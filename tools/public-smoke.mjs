import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
const { fetch, AbortSignal } = globalThis;

const origin = 'https://whatthemake.ru';
const readiness = await fetch(`${origin}/api/v1/ready`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(readiness.status, 200);
const ready = await readiness.json();
assert.equal(ready.status, 'UP');
if (process.env.EXPECTED_BUILD_SHA)
  assert.equal(ready.version.buildSha, process.env.EXPECTED_BUILD_SHA);
const response = await fetch(`${origin}/api/v1/comparisons/preview`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  signal: AbortSignal.timeout(20000),
  body: JSON.stringify({
    schemaVersion: 1,
    gtins: ['3560070791460', '3600523503384'],
    brief: {
      mode: 'UNKNOWN_GOALS',
      waterproof: 'NO_PREFERENCE',
      removal: 'NO_PREFERENCE',
      sensitiveEyes: true,
      contactLenses: false,
      avoidedIngredients: [],
    },
  }),
});
assert.equal(response.status, 200);
const { comparison } = await response.json();
assert.equal(comparison.rulesVersion, 'mascara-comparison-v3');
assert.equal(comparison.recommendation.kind, 'NO_CLEAR_WINNER');
assert.deepEqual(
  comparison.slots.map((slot) => slot.state),
  ['UNSUPPORTED_CATEGORY', 'UNSUPPORTED_CATEGORY'],
);
assert.equal(comparison.warnings.length, 1);
console.log(
  JSON.stringify({
    smoke: 'PASSED',
    buildSha: ready.version.buildSha,
    categoryGate: true,
    eyeContextWarning: true,
  }),
);
