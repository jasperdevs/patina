import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  exitCodeForReport,
  parseFixtureFile,
  resolveLiveSettings,
  runLiveQuality,
  writeReports,
} from '../quality/live-quality.mjs';

function tempRoot() {
  return mkdtempSync(resolve(tmpdir(), 'patina-live-quality-'));
}

function writeFixture(root, body = 'Original AI text with important claim.') {
  const dir = resolve(root, 'ko');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'ko-live-test.md');
  writeFileSync(path, `---\nfixture_id: ko-live-test\nlanguage: ko\nprofile: default\nanchors:\n  - "important claim"\n---\n${body}\n`, 'utf8');
  return path;
}

function mockDeps({ rewrite = 'Rewritten human text with important claim.', aiBefore = 80, aiAfter = 24, mps = 95, fidelity = 92 } = {}) {
  return {
    rewrite: async () => {
      if (rewrite instanceof Error) throw rewrite;
      return rewrite;
    },
    scoreText: async ({ text }) => ({ overall: text.startsWith('Rewritten') ? aiAfter : aiBefore }),
    scoreMPS: async () => ({ mps }),
    scoreFidelity: async () => ({ fidelity }),
  };
}

test('parseFixtureFile validates frontmatter and body', () => {
  const root = tempRoot();
  try {
    const path = writeFixture(root);
    const fixture = parseFixtureFile(path);
    assert.equal(fixture.id, 'ko-live-test');
    assert.equal(fixture.language, 'ko');
    assert.equal(fixture.profile, 'default');
    assert.equal(fixture.anchors[0], 'important claim');
    assert.match(fixture.body, /Original AI text/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parseFixtureFile rejects missing frontmatter', () => {
  const root = tempRoot();
  try {
    const path = resolve(root, 'bad.md');
    writeFileSync(path, 'plain text only', 'utf8');
    assert.throws(() => parseFixtureFile(path), /missing YAML frontmatter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveLiveSettings fails closed when no credential is configured', () => {
  const settings = resolveLiveSettings({});
  assert.equal(settings.hasApiKey, undefined);
  assert.equal(settings.apiKey, null);
  assert.match(settings.errors.join('\n'), /Missing live quality API key/);
});

test('resolveLiveSettings fails closed on invalid timeout config', () => {
  const settings = resolveLiveSettings({
    PATINA_LIVE_API_KEY: 'test-key',
    PATINA_LIVE_TIMEOUT_MS: 'later',
  });
  assert.match(settings.errors.join('\n'), /PATINA_LIVE_TIMEOUT_MS must be a positive integer/);
});

test('runLiveQuality reports missing credentials as ERROR before sample execution', async () => {
  const root = tempRoot();
  let called = false;
  try {
    writeFixture(root);
    const report = await runLiveQuality({
      fixturesRoot: root,
      env: {},
      rewrite: async () => {
        called = true;
        return 'should not run';
      },
    });
    assert.equal(report.summary.overall, 'ERROR');
    assert.equal(exitCodeForReport(report), 1);
    assert.equal(called, false);
    assert.match(report.errors[0].message, /Missing live quality API key/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('low quality scores become WARN and keep a zero exit policy', async () => {
  const root = tempRoot();
  try {
    writeFixture(root);
    const report = await runLiveQuality({
      fixturesRoot: root,
      env: { PATINA_LIVE_API_KEY: 'test-key' },
      ...mockDeps({ aiBefore: 80, aiAfter: 55, mps: 65, fidelity: 90 }),
    });
    assert.equal(report.summary.overall, 'WARN');
    assert.equal(report.summary.warn, 1);
    assert.equal(exitCodeForReport(report), 0);
    assert.match(report.fixtures[0].warnings.join('\n'), /MPS 65 < 70/);
    assert.match(report.fixtures[0].warnings.join('\n'), /AI-likeness after 55 > 30/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rewrite output is formatted before scoring and reporting', async () => {
  const root = tempRoot();
  try {
    writeFixture(root);
    const report = await runLiveQuality({
      fixturesRoot: root,
      env: { PATINA_LIVE_API_KEY: 'test-key' },
      ...mockDeps({
        rewrite: '[BODY]\nRewritten human text with important claim.\n[/BODY]\n\n[SELF_AUDIT]\nleak\n[/SELF_AUDIT]',
      }),
    });
    assert.equal(report.summary.overall, 'PASS');
    assert.equal(report.fixtures[0].rewritten, 'Rewritten human text with important claim.');
    assert.ok(!report.fixtures[0].rewritten.includes('SELF_AUDIT'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider failures become ERROR and nonzero', async () => {
  const root = tempRoot();
  try {
    writeFixture(root);
    const report = await runLiveQuality({
      fixturesRoot: root,
      env: { PATINA_LIVE_API_KEY: 'test-key' },
      ...mockDeps({ rewrite: new Error('provider down') }),
    });
    assert.equal(report.summary.overall, 'ERROR');
    assert.equal(exitCodeForReport(report), 1);
    assert.match(report.fixtures[0].errors[0].message, /provider down/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoring schema failures become ERROR and nonzero', async () => {
  const root = tempRoot();
  try {
    writeFixture(root);
    const report = await runLiveQuality({
      fixturesRoot: root,
      env: { PATINA_LIVE_API_KEY: 'test-key' },
      rewrite: async () => 'Rewritten human text with important claim.',
      scoreText: async ({ text }) => text.startsWith('Rewritten')
        ? { overall: null, error: 'schema-failure' }
        : { overall: 80 },
      scoreMPS: async () => ({ mps: 95 }),
      scoreFidelity: async () => ({ fidelity: 92 }),
    });
    assert.equal(report.summary.overall, 'ERROR');
    assert.equal(exitCodeForReport(report), 1);
    assert.match(report.fixtures[0].errors[0].message, /schema-failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeReports creates JSON and Markdown artifacts', async () => {
  const fixturesRoot = tempRoot();
  const out = tempRoot();
  try {
    writeFixture(fixturesRoot);
    const report = await runLiveQuality({
      fixturesRoot,
      env: { PATINA_LIVE_API_KEY: 'test-key' },
      ...mockDeps(),
    });
    assert.equal(report.summary.overall, 'PASS');
    const paths = writeReports(report, out);
    assert.equal(existsSync(paths.jsonPath), true);
    assert.equal(existsSync(paths.mdPath), true);
    assert.equal(JSON.parse(readFileSync(paths.jsonPath, 'utf8')).summary.overall, 'PASS');
    assert.match(readFileSync(paths.mdPath, 'utf8'), /Patina Live Quality Report/);
  } finally {
    rmSync(fixturesRoot, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
