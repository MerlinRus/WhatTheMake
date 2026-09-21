import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { normalizeGtin } from '../packages/domain/src/gtin.js';
import type { ExternalProductDiscoveryResult } from '../packages/domain/src/product-discovery.js';
import { createOpenBeautyFactsProductProvider } from '../packages/infrastructure/src/open-beauty-facts-product-provider.js';

const ProductSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9-]+$', maxLength: 100 }),
    gtin: Type.String({ pattern: '^[0-9]{13}$' }),
    brandName: Type.String({ minLength: 1, maxLength: 200 }),
    productName: Type.String({ minLength: 1, maxLength: 300 }),
    category: Type.Union([Type.Literal('MASCARA'), Type.Literal('OTHER')]),
    sourcePublisher: Type.Literal('cosnova GmbH'),
    sourceKind: Type.Literal('MANUFACTURER_LEAFLET_ON_RETAILER_HOST'),
    sourceUrl: Type.String({
      pattern: '^https://products\\.dm-static\\.com/.+\\.pdf$',
      maxLength: 2048,
    }),
    sourcePage: Type.Literal(1),
    evidenceNote: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { additionalProperties: false },
);
const CorpusSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    datasetId: Type.Literal('manufacturer-identity-holdout-v1'),
    checkedOn: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    reviewMethod: Type.Literal('AI_PRIMARY_DOCUMENT_REVIEW'),
    humanReviewPending: Type.Literal(true),
    products: Type.Array(ProductSchema, { minItems: 3, maxItems: 30 }),
  },
  { additionalProperties: false },
);
type Product = Static<typeof ProductSchema>;

async function readJson(path: string): Promise<unknown> {
  const file = await stat(path);
  if (!file.isFile() || file.size > 1024 * 1024)
    throw new Error('Invalid bounded benchmark file');
  return JSON.parse(await readFile(path, 'utf8'));
}

function normalized(value: string) {
  const result = normalizeGtin(value);
  assert.equal(result.kind, 'VALID', `Invalid fixture GTIN ${value}`);
  if (result.kind !== 'VALID') throw new Error('Invalid fixture GTIN');
  return result.gtin;
}

function response(
  product: Product,
  returnedCode = product.gtin,
  status = 200,
): Response {
  // Hand-built adapter input, NOT a captured upstream response or coverage evidence.
  return new Response(
    JSON.stringify({
      code: returnedCode,
      product: {
        code: returnedCode,
        product_name: product.productName,
        brands: product.brandName,
        categories_tags: ['en:mascaras'],
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

async function main(): Promise<void> {
  if (process.argv.length !== 2)
    throw new Error('No arguments supported: offline fixtures only');
  const corpus = await readJson('benchmarks/gtin/holdout-v1.json');
  assert.ok(Value.Check(CorpusSchema, corpus), 'Invalid corpus');
  if (!Value.Check(CorpusSchema, corpus)) throw new Error('Invalid corpus');
  const seed = await readJson('apps/server/seeds/mascara/seed.json');
  const SeedSchema = Type.Object({
    products: Type.Array(Type.Object({ gtin: Type.String() })),
  });
  if (!Value.Check(SeedSchema, seed))
    throw new Error('Invalid seed for holdout audit');
  const imported = new Set(
    seed.products.map((product) => normalized(product.gtin).gtin14),
  );
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const product of corpus.products) {
    const key = normalized(product.gtin).gtin14;
    assert.ok(
      !imported.has(key),
      `Holdout contaminated by imported seed: ${product.id}`,
    );
    assert.ok(
      !ids.has(product.id) && !codes.has(key),
      'Duplicate holdout identity',
    );
    ids.add(product.id);
    codes.add(key);
  }
  const rows: Array<{
    id: string;
    passed: boolean;
    offlineProcessingMs: number;
    actual: string;
  }> = [];
  async function run(
    id: string,
    product: Product,
    transport: (signal: AbortSignal | null | undefined) => Promise<Response>,
    check: (result: ExternalProductDiscoveryResult) => void,
    query = product.gtin,
  ): Promise<void> {
    let calls = 0;
    const provider = createOpenBeautyFactsProductProvider({
      maxCacheEntries: 0,
      timeoutMs: 5,
      fetch: async (input, init) => {
        calls += 1;
        const url = new URL(input);
        assert.equal(url.origin, 'https://world.openbeautyfacts.org');
        assert.equal(url.pathname, `/api/v3/product/${query}`);
        return transport(init?.signal);
      },
    });
    const started = performance.now();
    const actual = await provider.discover(normalized(query));
    let passed = true;
    try {
      check(actual);
      assert.equal(calls, 1);
    } catch {
      passed = false;
    }
    rows.push({
      id,
      passed,
      offlineProcessingMs: Number((performance.now() - started).toFixed(3)),
      actual:
        actual.kind === 'UNAVAILABLE'
          ? `${actual.kind}:${actual.reason}`
          : actual.kind,
    });
  }
  for (const product of corpus.products) {
    const check = (result: ExternalProductDiscoveryResult) => {
      assert.equal(result.kind, 'FOUND');
      if (result.kind !== 'FOUND') throw new Error('Expected identity');
      assert.equal(result.productName, product.productName);
      assert.equal(result.brandName, product.brandName);
      assert.equal(result.category, product.category);
      assert.equal(
        normalized(result.gtin).gtin14,
        normalized(product.gtin).gtin14,
      );
    };
    await run(
      `${product.id}:exact`,
      product,
      async () => response(product),
      check,
    );
    await run(
      `${product.id}:gtin14`,
      product,
      async () => response(product),
      check,
      normalized(product.gtin).gtin14,
    );
  }
  const first = corpus.products[0]!;
  const other = corpus.products[1]!;
  const expected =
    (kind: string, reason?: string) =>
    (result: ExternalProductDiscoveryResult) => {
      assert.equal(result.kind, kind);
      if (reason) {
        assert.equal(result.kind, 'UNAVAILABLE');
        if (result.kind === 'UNAVAILABLE') assert.equal(result.reason, reason);
      }
    };
  await run(
    'conflicting-returned-gtin',
    first,
    async () => response(other),
    expected('UNAVAILABLE', 'INVALID_RESPONSE'),
  );
  await run(
    'provider-miss-not-global-nonexistence',
    first,
    async () => response(first, first.gtin, 404),
    expected('NOT_FOUND'),
  );
  await run(
    'quota-exhausted-not-miss',
    first,
    async () => response(first, first.gtin, 429),
    expected('UNAVAILABLE', 'RATE_LIMITED'),
  );
  await run(
    'upstream-failure-not-miss',
    first,
    async () => response(first, first.gtin, 503),
    expected('UNAVAILABLE', 'UPSTREAM_ERROR'),
  );
  await run(
    'deadline-not-miss',
    first,
    (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
    expected('UNAVAILABLE', 'TIMEOUT'),
  );
  const failed = rows.filter((row) => !row.passed).length;
  process.stdout.write(
    `${JSON.stringify(
      {
        kind: 'OFFLINE_FIXTURE_REPORT',
        datasetId: corpus.datasetId,
        independentGroundTruthProducts: corpus.products.length,
        importedSeedOverlap: 0,
        fixtureChecks: rows.length,
        failures: failed,
        liveProviderRequests: 0,
        internetPrecision: null,
        internetCoverage: null,
        productionLatencyP95Ms: null,
        multiSourceConflictResolutionTested: false,
        warning:
          'Constructed transport fixtures. Independent document labels, not a measured live discovery benchmark. One brand/manufacturer, human review pending.',
        rows,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Benchmark failed'}\n`,
  );
  process.exitCode = 1;
});
