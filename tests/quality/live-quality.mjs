#!/usr/bin/env node
// Credentialed live quality regression runner for patina.
// Produces report-first quality warnings but fails closed on infrastructure,
// provider, schema, fixture, or report-generation errors.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

import { callLLM } from '../../src/api.js';
import { loadConfig, getRepoRoot } from '../../src/config.js';
import { loadPatterns, loadProfile, loadCoreFile } from '../../src/loader.js';
import { buildPrompt } from '../../src/prompt-builder.js';
import { selectProvider } from '../../src/providers.js';
import { scoreText, scoreMPS, scoreFidelity } from '../../src/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DEFAULT_FIXTURES_ROOT = resolve(REPO_ROOT, 'tests/fixtures/live-quality');
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, 'artifacts/live-quality');
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const VALID_LANGUAGES = new Set(['ko', 'en']);
const DEFAULT_POLICY = Object.freeze({
  mpsFloor: 70,
  fidelityFloor: 70,
  aiTarget: 30,
});

export function parseFixtureFile(path) {
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`${path}: missing YAML frontmatter`);

  const meta = yaml.load(match[1]);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(`${path}: frontmatter must be a mapping`);
  }

  const body = match[2].trim();
  const required = ['fixture_id', 'language'];
  for (const key of required) {
    if (typeof meta[key] !== 'string' || meta[key].trim() === '') {
      throw new Error(`${path}: ${key} must be a non-empty string`);
    }
  }
  if (!VALID_LANGUAGES.has(meta.language)) {
    throw new Error(`${path}: language must be one of ${Array.from(VALID_LANGUAGES).join(', ')}`);
  }
  if (!body) throw new Error(`${path}: body must not be empty`);
  if (meta.profile !== undefined && typeof meta.profile !== 'string') {
    throw new Error(`${path}: profile must be a string when present`);
  }
  if (meta.anchors !== undefined && !Array.isArray(meta.anchors)) {
    throw new Error(`${path}: anchors must be a list when present`);
  }

  return {
    path,
    relativePath: relative(REPO_ROOT, path),
    id: meta.fixture_id,
    language: meta.language,
    profile: meta.profile || 'default',
    expected_focus: Array.isArray(meta.expected_focus) ? meta.expected_focus : [],
    anchors: Array.isArray(meta.anchors) ? meta.anchors : [],
    body,
  };
}

export function listFixturePaths(root = DEFAULT_FIXTURES_ROOT) {
  const paths = [];
  if (!existsSync(root)) return paths;

  for (const lang of readdirSync(root).sort()) {
    const langDir = resolve(root, lang);
    if (!existsSync(langDir)) continue;
    for (const file of readdirSync(langDir).sort()) {
      if (!file.endsWith('.md')) continue;
      paths.push(resolve(langDir, file));
    }
  }
  return paths;
}

export function loadFixtures(root = DEFAULT_FIXTURES_ROOT) {
  return listFixturePaths(root).map(parseFixtureFile);
}

export function resolveLiveSettings(env = process.env) {
  const providerName = env.PATINA_LIVE_PROVIDER || '';
  let provider = null;
  const errors = [];

  if (providerName) {
    try {
      provider = selectProvider(providerName);
    } catch (err) {
      errors.push(err.message);
    }
  }

  const providerKey = provider?.apiKeyEnv ? env[provider.apiKeyEnv] : null;
  const apiKey = env.PATINA_LIVE_API_KEY || providerKey || env.PATINA_API_KEY || null;
  const baseURL = env.PATINA_LIVE_API_BASE || env.PATINA_API_BASE || provider?.baseURL || 'https://api.openai.com/v1';
  const model = env.PATINA_LIVE_MODEL || env.PATINA_MODEL || provider?.defaultModel || 'gpt-4o';
  const timeout = parsePositiveInt('PATINA_LIVE_TIMEOUT_MS', env.PATINA_LIVE_TIMEOUT_MS, 120000);
  if (timeout.error) errors.push(timeout.error);

  if (!apiKey) {
    const accepted = ['PATINA_API_KEY', 'PATINA_LIVE_API_KEY'];
    if (provider) accepted.push(provider.apiKeyEnv);
    errors.push(`Missing live quality API key. Set ${accepted.join(' or ')}.`);
  }

  return {
    provider: provider?.name || null,
    apiKey,
    apiKeySource: apiKey ? apiKeySource({ env, provider }) : null,
    baseURL,
    model,
    timeoutMs: timeout.value,
    errors,
  };
}

function apiKeySource({ env, provider }) {
  if (env.PATINA_LIVE_API_KEY) return 'env:PATINA_LIVE_API_KEY';
  if (provider?.apiKeyEnv && env[provider.apiKeyEnv]) return `env:${provider.apiKeyEnv}`;
  if (env.PATINA_API_KEY) return 'env:PATINA_API_KEY';
  return null;
}

function parsePositiveInt(name, value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return { value: defaultValue, error: null };
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return { value: defaultValue, error: `${name} must be a positive integer when set (got ${JSON.stringify(value)})` };
  }
  return { value: n, error: null };
}

export async function runLiveQuality(options = {}) {
  const repoRoot = options.repoRoot || getRepoRoot();
  const fixturesRoot = options.fixturesRoot || DEFAULT_FIXTURES_ROOT;
  const policy = { ...DEFAULT_POLICY, ...(options.policy || {}) };
  const env = options.env || process.env;
  const deps = {
    rewrite: options.rewrite || defaultRewrite,
    scoreText: options.scoreText || scoreText,
    scoreMPS: options.scoreMPS || scoreMPS,
    scoreFidelity: options.scoreFidelity || scoreFidelity,
  };

  const report = createReport({ policy, fixturesRoot, env });
  let fixtures = [];
  try {
    fixtures = loadFixtures(fixturesRoot);
  } catch (err) {
    report.errors.push({ scope: 'fixtures', message: err.message });
    return finalizeReport(report);
  }

  if (fixtures.length === 0) {
    report.errors.push({ scope: 'fixtures', message: `No live quality fixtures found under ${relative(repoRoot, fixturesRoot)}` });
    return finalizeReport(report);
  }

  const settings = resolveLiveSettings(env);
  report.settings = redactSettings(settings);
  if (settings.errors.length) {
    for (const message of settings.errors) {
      report.errors.push({ scope: 'settings', message });
    }
    return finalizeReport(report);
  }

  for (const fixture of fixtures) {
    const result = await evaluateFixture({ fixture, settings, policy, repoRoot, deps });
    report.fixtures.push(result);
  }

  return finalizeReport(report);
}

function createReport({ policy, fixturesRoot, env }) {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runner: 'tests/quality/live-quality.mjs',
    fixtures_root: relative(REPO_ROOT, fixturesRoot),
    policy: {
      ...policy,
      exit: 'ERROR exits nonzero; WARN exits zero (report-first).',
    },
    settings: {
      provider: env.PATINA_LIVE_PROVIDER || null,
      model: env.PATINA_LIVE_MODEL || env.PATINA_MODEL || null,
      apiKeySource: null,
    },
    summary: {
      total: 0,
      pass: 0,
      warn: 0,
      error: 0,
      overall: 'ERROR',
    },
    fixtures: [],
    errors: [],
  };
}

function redactSettings(settings) {
  return {
    provider: settings.provider,
    baseURL: settings.baseURL,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    apiKeySource: settings.apiKeySource,
    hasApiKey: Boolean(settings.apiKey),
  };
}

async function evaluateFixture({ fixture, settings, policy, repoRoot, deps }) {
  const row = {
    fixture_id: fixture.id,
    language: fixture.language,
    profile: fixture.profile,
    path: fixture.relativePath,
    anchors: fixture.anchors,
    expected_focus: fixture.expected_focus,
    input: fixture.body,
    rewritten: null,
    scores: null,
    warnings: [],
    errors: [],
    verdict: 'ERROR',
  };

  try {
    const config = loadConfig();
    config.language = fixture.language;
    config.profile = fixture.profile;
    const patterns = loadPatterns(repoRoot, fixture.language, config['skip-patterns'] || []);

    const rewritten = await deps.rewrite({ fixture, settings, config, patterns, repoRoot });
    if (typeof rewritten !== 'string' || rewritten.trim() === '') {
      throw new Error('Rewrite returned an empty response');
    }
    row.rewritten = rewritten.trim();

    const [beforeAI, afterAI, mps, fidelity] = await Promise.all([
      deps.scoreText({ text: fixture.body, config, patterns, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model }),
      deps.scoreText({ text: row.rewritten, config, patterns, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model }),
      deps.scoreMPS({ original: fixture.body, rewritten: row.rewritten, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model }),
      deps.scoreFidelity({ original: fixture.body, rewritten: row.rewritten, apiKey: settings.apiKey, baseURL: settings.baseURL, model: settings.model }),
    ]);

    assertScoringOk('ai_before', beforeAI, 'overall');
    assertScoringOk('ai_after', afterAI, 'overall');
    assertScoringOk('mps', mps, 'mps');
    assertScoringOk('fidelity', fidelity, 'fidelity');

    row.scores = {
      ai_before: round1(beforeAI.overall),
      ai_after: round1(afterAI.overall),
      mps: round1(mps.mps),
      fidelity: round1(fidelity.fidelity),
      mps_detail: mps,
      fidelity_detail: fidelity,
    };
    row.warnings = qualityWarnings(row.scores, policy);
    row.verdict = row.warnings.length ? 'WARN' : 'PASS';
  } catch (err) {
    row.errors.push({ message: err.message });
    row.verdict = 'ERROR';
  }

  return row;
}

async function defaultRewrite({ fixture, settings, config, patterns, repoRoot }) {
  const profile = loadProfile(repoRoot, fixture.profile || config.profile || 'default');
  const voice = loadCoreFile(repoRoot, 'voice.md');
  const scoring = loadCoreFile(repoRoot, 'scoring.md');
  const prompt = buildPrompt({
    config,
    patterns,
    profile: profile.body ? profile : null,
    voice: voice.body ? voice : null,
    scoring: scoring.body ? scoring : null,
    text: fixture.body,
    mode: 'rewrite',
  });

  return callLLM({
    prompt,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    model: settings.model,
    timeout: settings.timeoutMs,
  });
}

function assertScoringOk(label, result, field) {
  if (!result || result.error) {
    throw new Error(`${label} scoring failed${result?.error ? `: ${result.error}` : ''}`);
  }
  if (!Number.isFinite(Number(result[field]))) {
    throw new Error(`${label} scoring did not produce numeric ${field}`);
  }
}

function qualityWarnings(scores, policy) {
  const warnings = [];
  if (scores.mps < policy.mpsFloor) warnings.push(`MPS ${scores.mps} < ${policy.mpsFloor}`);
  if (scores.fidelity < policy.fidelityFloor) warnings.push(`Fidelity ${scores.fidelity} < ${policy.fidelityFloor}`);
  if (scores.ai_after > policy.aiTarget) warnings.push(`AI-likeness after ${scores.ai_after} > ${policy.aiTarget}`);
  if (scores.ai_after >= scores.ai_before) warnings.push(`AI-likeness did not improve (${scores.ai_before} → ${scores.ai_after})`);
  return warnings;
}

function finalizeReport(report) {
  report.summary.total = report.fixtures.length;
  report.summary.pass = report.fixtures.filter((f) => f.verdict === 'PASS').length;
  report.summary.warn = report.fixtures.filter((f) => f.verdict === 'WARN').length;
  report.summary.error = report.fixtures.filter((f) => f.verdict === 'ERROR').length + report.errors.length;
  report.summary.overall = report.summary.error > 0 ? 'ERROR'
    : report.summary.warn > 0 ? 'WARN'
    : 'PASS';
  return report;
}

export function writeReports(report, outputDir = DEFAULT_OUTPUT_DIR) {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = resolve(outputDir, 'results.json');
  const mdPath = resolve(outputDir, 'report.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdownReport(report), 'utf8');
  return { jsonPath, mdPath };
}

export function exitCodeForReport(report) {
  return report.summary.overall === 'ERROR' ? 1 : 0;
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Patina Live Quality Report');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Overall verdict: **${report.summary.overall}**`);
  lines.push('');
  lines.push('Exit policy: `ERROR` fails CI; `WARN` is report-first and exits zero in v1.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| total | pass | warn | error | model | provider |');
  lines.push('|---:|---:|---:|---:|---|---|');
  lines.push(`| ${report.summary.total} | ${report.summary.pass} | ${report.summary.warn} | ${report.summary.error} | ${escapeCell(report.settings?.model || '')} | ${escapeCell(report.settings?.provider || 'default')} |`);
  lines.push('');

  if (report.errors.length) {
    lines.push('## Infrastructure errors');
    lines.push('');
    for (const err of report.errors) {
      lines.push(`- **${escapeMd(err.scope)}**: ${escapeMd(err.message)}`);
    }
    lines.push('');
  }

  lines.push('## Fixtures');
  lines.push('');
  lines.push('| fixture | lang | MPS | fidelity | AI before | AI after | verdict |');
  lines.push('|---|---|---:|---:|---:|---:|---|');
  for (const f of report.fixtures) {
    lines.push(`| ${escapeCell(f.fixture_id)} | ${escapeCell(f.language)} | ${cellNum(f.scores?.mps)} | ${cellNum(f.scores?.fidelity)} | ${cellNum(f.scores?.ai_before)} | ${cellNum(f.scores?.ai_after)} | ${escapeCell(f.verdict)} |`);
  }
  lines.push('');

  for (const f of report.fixtures) {
    lines.push(`<details><summary>${escapeMd(f.fixture_id)} — ${escapeMd(f.verdict)}</summary>`);
    lines.push('');
    if (f.warnings.length) {
      lines.push('Warnings:');
      for (const warning of f.warnings) lines.push(`- ${escapeMd(warning)}`);
      lines.push('');
    }
    if (f.errors.length) {
      lines.push('Errors:');
      for (const err of f.errors) lines.push(`- ${escapeMd(err.message)}`);
      lines.push('');
    }
    lines.push('Original:');
    lines.push('');
    lines.push('```');
    lines.push(f.input || '');
    lines.push('```');
    lines.push('');
    lines.push('Rewritten:');
    lines.push('');
    lines.push('```');
    lines.push(f.rewritten || '');
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function escapeMd(value) {
  return String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cellNum(value) {
  return Number.isFinite(Number(value)) ? String(value) : '—';
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

async function main() {
  const report = await runLiveQuality();
  const { jsonPath, mdPath } = writeReports(report);
  console.log(`Patina live quality: ${report.summary.overall}`);
  console.log(`JSON report: ${relative(REPO_ROOT, jsonPath)}`);
  console.log(`Markdown report: ${relative(REPO_ROOT, mdPath)}`);
  if (exitCodeForReport(report) !== 0) {
    for (const err of report.errors) console.error(`[patina-live-quality] ${err.scope}: ${err.message}`);
    for (const fixture of report.fixtures.filter((f) => f.verdict === 'ERROR')) {
      for (const err of fixture.errors) console.error(`[patina-live-quality] ${fixture.fixture_id}: ${err.message}`);
    }
    process.exit(exitCodeForReport(report));
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  main().catch((err) => {
    const crashReport = finalizeReport({
      ...createReport({ policy: DEFAULT_POLICY, fixturesRoot: DEFAULT_FIXTURES_ROOT, env: process.env }),
      errors: [{ scope: 'runner', message: err.message }],
    });
    try {
      writeReports(crashReport);
    } catch (writeErr) {
      console.error('[patina-live-quality] report generation failed:', writeErr.message);
    }
    console.error('[patina-live-quality] runner:', err.message);
    process.exit(1);
  });
}
