import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import console from 'node:console';
const { fetch, AbortSignal } = globalThis;

if (process.env.RUN_LIVE_DISCOVERY_EVAL !== '1')
  throw new Error('Explicit RUN_LIVE_DISCOVERY_EVAL=1 required');
const origin = 'https://whatthemake.ru';
const corpus = JSON.parse(
  await readFile(
    new URL('../benchmarks/gtin/holdout-v1.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(corpus.datasetId, 'manufacturer-identity-holdout-v1');
assert.equal(corpus.products.length, 3);
const rows = [];
for (const product of corpus.products) {
  assert.match(product.gtin, /^\d{13}$/);
  const measurements = [];
  for (const phase of ['INITIAL_CACHE_STATE_UNKNOWN', 'IMMEDIATE_REPEAT']) {
    const started = performance.now();
    const response = await fetch(
      `${origin}/api/v1/discovery/barcodes/${product.gtin}`,
      {
        signal: AbortSignal.timeout(20_000),
        redirect: 'manual',
        headers: { Accept: 'application/json' },
      },
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.length < 64 * 1024);
    const { discovery } = JSON.parse(text);
    assert.ok(['FOUND', 'NOT_FOUND', 'UNAVAILABLE'].includes(discovery.state));
    if (discovery.state === 'FOUND') {
      assert.equal(
        discovery.candidate.gtin.padStart(14, '0'),
        product.gtin.padStart(14, '0'),
      );
      assert.equal(discovery.candidate.confidence, 'LOW');
    }
    measurements.push({
      phase,
      elapsedMs: Math.round(performance.now() - started),
      state: discovery.state,
      provider: discovery.candidate?.provider ?? discovery.provider,
      reason: discovery.reason ?? null,
      candidate:
        discovery.state === 'FOUND'
          ? {
              productName: discovery.candidate.productName,
              brandName: discovery.candidate.brandName,
              category: discovery.candidate.category,
              categoryMatchesReference:
                discovery.candidate.category === product.category,
              fetchedAt: discovery.candidate.fetchedAt,
            }
          : null,
    });
  }
  const row = {
    id: product.id,
    gtin: product.gtin,
    referenceName: product.productName,
    measurements,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  if (rows.length < corpus.products.length) await delay(11_000);
}
console.log(
  JSON.stringify({
    kind: 'SMALL_LIVE_DISCOVERY_OBSERVATION',
    measuredAt: new Date().toISOString(),
    products: rows.length,
    foundInitial: rows.filter((row) => row.measurements[0].state === 'FOUND')
      .length,
    unavailableInitial: rows.filter(
      (row) => row.measurements[0].state === 'UNAVAILABLE',
    ).length,
    internetPrecision: null,
    marketCoverage: null,
    latencyP95Ms: null,
    warning:
      'Three products from one manufacturer; title matching needs review. Initial cache state unknown. Not a representative accuracy, cold-cache or p95 benchmark.',
  }),
);
