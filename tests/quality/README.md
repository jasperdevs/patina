# Quality Checks

patina has two quality layers:

1. **Deterministic benchmark** — no LLM calls, no API key, no network.
   It checks the stylometry / lexicon signal layer against labeled fixtures.
2. **Live quality regression** — local, credentialed KO/EN rewrite checks
   that call a model, then report meaning preservation and residual AI-likeness.

## Deterministic benchmark

```bash
npm run benchmark
```

Outputs:
- A markdown table per language (accuracy, precision, recall, F1, confusion matrix)
- A list of any misclassified fixtures with their feature values
- `tests/quality/results.json` — full per-fixture log (gitignored)

### What it measures

Every fixture under `tests/fixtures/suspect-zones/{lang}/{ai|natural}/*.md`
carries an `expected_hot` label in its frontmatter. The benchmark runs
`analyzeText()` (defined in `src/features/index.js`) on the body and
compares the predicted hot/cold decision against that label. The decision
follows the 3-signal OR rule from `core/stylometry.md` §16:

```
paragraph is SUSPECT iff
  burstiness_band == "low"  OR
  MATTR_band == "low"       OR
  lexicon_density > threshold
```

Per-language metrics use `expected_hot=true` as the positive class.

### What it does NOT measure

- LLM-based scoring (`src/scoring.js`). The LLM is non-deterministic by
  design and adds API cost / latency, so it stays out of this layer.
- Rewrite quality (does the rewritten text read better?). That requires
  human or LLM grading and lives in the live quality regression below.
- AUROC against a ranked score — the current decision is binary
  (hot/cold), so we report accuracy + F1 instead.

## Live quality regression

```bash
npm run quality:live
```

This runs `tests/quality/live-quality.mjs` against committed synthetic
fixtures under:

```text
tests/fixtures/live-quality/ko/*.md
tests/fixtures/live-quality/en/*.md
```

The runner writes:

- `artifacts/live-quality/results.json`
- `artifacts/live-quality/report.md`

These artifacts are gitignored locally. They are meant for manual review unless a maintainer deliberately uploads them somewhere else.

### Required environment

Set one of:

- `PATINA_API_KEY`
- `PATINA_LIVE_API_KEY`

Optional:

- `PATINA_MODEL` or `PATINA_LIVE_MODEL` (default: `gpt-4o`)
- `PATINA_API_BASE` or `PATINA_LIVE_API_BASE` (default: OpenAI-compatible `/v1`)
- `PATINA_LIVE_PROVIDER` (`openai`, `gemini`, `groq`, `together`) to use a provider preset
- provider-specific key when `PATINA_LIVE_PROVIDER` is set, for example `GEMINI_API_KEY`
- `PATINA_LIVE_TIMEOUT_MS` (default: `120000`)

### Verdicts and CI policy

| Verdict | Meaning | Exit code in v1 |
|---|---|---:|
| `PASS` | rewrite + scoring + report generation succeeded, no warnings | 0 |
| `WARN` | infrastructure succeeded, but MPS/fidelity/AI-likeness is concerning | 0 |
| `ERROR` | missing credential, provider/model failure, timeout, schema failure, fixture error, or report failure | nonzero |

Quality score thresholds are **report-first** in v1. A low MPS/fidelity or
high residual AI-likeness is surfaced as `WARN`, not used as a merge blocker.
Infrastructure/report failures are fail-closed and make the command exit nonzero.

### Local-only policy

`npm run quality:live` is **not** part of the default GitHub Actions PR job.
The workflow still runs the deterministic `npm test` matrix, but live quality
is intentionally kept local/manual because it needs provider credentials, can
consume API quota, and may produce model-dependent `WARN` results.

Use it before a PR when the change might affect rewrite quality, scoring,
prompting, provider defaults, or output formatting. If a maintainer later wants
PR-visible live quality again, add a separate opt-in job rather than using
`pull_request_target` to expose secrets to PR code.

## Extending the corpus

1. Add a new fixture markdown with frontmatter:

   ```yaml
   ---
   fixture_id: ko-ai-06
   language: ko
   class: ai
   expected_hot: true
   why_designed_this_way: |
     Brief note on which signals you expect to fire.
   topic: <subject>
   ---

   <one paragraph of text>
   ```

2. Drop it under `tests/fixtures/suspect-zones/{lang}/{ai|natural}/`.

3. Re-run `npm run benchmark` and confirm it classifies as expected.

## Tuning the thresholds

If a real-world corpus produces too many misclassifications, the bands
in `.patina.default.yaml` (`stylometry.burstiness.bands`,
`stylometry.ttr.bands`, `lexicon.density_threshold`) drive the
classification. Sweep against this benchmark + your own corpus and
update thresholds; the shipped values come from the v3.5.1 / v3.7
calibration documented in `core/stylometry.md` §13 §16.

## Languages

Currently runs on `ko` and `en` fixtures. `zh` and `ja` are tracked in
[issue #104](https://github.com/devswha/patina/issues/104) — they
require lexicon curation and tokenization-policy decisions before the
benchmark can be extended.
