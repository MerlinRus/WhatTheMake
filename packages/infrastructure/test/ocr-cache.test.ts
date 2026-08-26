import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import type { OcrProvider, OcrRequest, OcrResult } from '@wtm/domain';

import {
  createCachedOcrProvider,
  createOcrCacheKey,
  createPostgresDatabase,
  type OcrCacheEventOutcome,
  type OcrCacheStore,
} from '../src/index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const request: OcrRequest = {
  operation: 'DOCUMENT_TEXT_DETECTION',
  imageBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  mediaType: 'image/jpeg',
  languageHints: ['ru', 'en'],
};

function provider(
  recognize: (input: OcrRequest) => Promise<OcrResult>,
  version = 'fixture-v1',
): OcrProvider {
  return {
    providerId: 'FIXTURE',
    version,
    recognize,
  };
}

function memoryStore(): OcrCacheStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async get(cacheKey): Promise<string | null> {
      return entries.get(cacheKey) ?? null;
    },
    async put(cacheKey, text): Promise<void> {
      entries.set(cacheKey, text);
    },
  };
}

test('OCR cache key covers input and provider versions', () => {
  const baseProvider = provider(async () => ({
    kind: 'SUCCEEDED',
    text: 'unused',
  }));
  const base = createOcrCacheKey(request, baseProvider);

  assert.match(base, /^[0-9a-f]{64}$/);
  assert.notEqual(
    createOcrCacheKey(
      { ...request, imageBytes: Uint8Array.from([0xff, 0xd8, 0x00, 0xd9]) },
      baseProvider,
    ),
    base,
  );
  assert.notEqual(
    createOcrCacheKey({ ...request, mediaType: 'image/png' }, baseProvider),
    base,
  );
  assert.notEqual(
    createOcrCacheKey(
      { ...request, languageHints: ['en', 'ru'] },
      baseProvider,
    ),
    base,
  );
  assert.notEqual(
    createOcrCacheKey(request, { ...baseProvider, version: 'fixture-v2' }),
    base,
  );
});

test('OCR cache deduplicates concurrent L2 lookup and provider work', async () => {
  let releaseRead: ((value: string | null) => void) | undefined;
  let readCount = 0;
  let writeCount = 0;
  let providerCount = 0;
  const readGate = new Promise<string | null>((resolveRead) => {
    releaseRead = resolveRead;
  });
  const store: OcrCacheStore = {
    async get(): Promise<string | null> {
      readCount += 1;
      return readGate;
    },
    async put(): Promise<void> {
      writeCount += 1;
    },
  };
  const cached = createCachedOcrProvider({
    provider: provider(async () => {
      providerCount += 1;
      return { kind: 'SUCCEEDED', text: 'AQUA, CERA ALBA' };
    }),
    store,
    l1MaxEntries: 10,
    l1TtlMs: 60_000,
  });

  const first = cached.recognize(request);
  const second = cached.recognize(request);
  assert.equal(readCount, 1);
  assert.equal(cached.getCacheSnapshot().inflightCount, 1);
  assert.ok(releaseRead);
  releaseRead(null);

  assert.deepEqual(await Promise.all([first, second]), [
    { kind: 'SUCCEEDED', text: 'AQUA, CERA ALBA' },
    { kind: 'SUCCEEDED', text: 'AQUA, CERA ALBA' },
  ]);
  assert.equal(providerCount, 1);
  assert.equal(writeCount, 1);
  assert.equal(cached.getCacheSnapshot().inflightCount, 0);
});

test('OCR cache serves a successful result from bounded L1', async () => {
  let providerCount = 0;
  let readCount = 0;
  const store = memoryStore();
  const cached = createCachedOcrProvider({
    provider: provider(async () => {
      providerCount += 1;
      return { kind: 'SUCCEEDED', text: 'CI 77499' };
    }),
    store: {
      ...store,
      async get(cacheKey): Promise<string | null> {
        readCount += 1;
        return store.get(cacheKey);
      },
    },
    l1MaxEntries: 1,
    l1TtlMs: 60_000,
  });

  assert.deepEqual(await cached.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'CI 77499',
  });
  assert.deepEqual(await cached.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'CI 77499',
  });
  assert.equal(providerCount, 1);
  assert.equal(readCount, 1);
  assert.equal(cached.getCacheSnapshot().l1EntryCount, 1);
});

test('OCR cache evicts the least recently used L1 entry', async () => {
  let providerCount = 0;
  let readCount = 0;
  const store = memoryStore();
  const cached = createCachedOcrProvider({
    provider: provider(async () => {
      providerCount += 1;
      return { kind: 'SUCCEEDED', text: `fixture-${providerCount}` };
    }),
    store: {
      ...store,
      async get(cacheKey): Promise<string | null> {
        readCount += 1;
        return store.get(cacheKey);
      },
    },
    l1MaxEntries: 1,
    l1TtlMs: 60_000,
  });
  const otherRequest: OcrRequest = {
    ...request,
    imageBytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    mediaType: 'image/png',
  };

  await cached.recognize(request);
  await cached.recognize(otherRequest);
  assert.deepEqual(await cached.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'fixture-1',
  });
  assert.equal(providerCount, 2);
  assert.equal(readCount, 3);
  assert.equal(cached.getCacheSnapshot().l1EntryCount, 1);
});

test('OCR cache never stores provider failures', async () => {
  let providerCount = 0;
  let writeCount = 0;
  const cached = createCachedOcrProvider({
    provider: provider(async () => {
      providerCount += 1;
      return {
        kind: 'FAILED',
        code: 'OCR_RATE_LIMITED',
        retryable: true,
      };
    }),
    store: {
      async get(): Promise<null> {
        return null;
      },
      async put(): Promise<void> {
        writeCount += 1;
      },
    },
    l1MaxEntries: 10,
    l1TtlMs: 60_000,
  });

  const expected = {
    kind: 'FAILED',
    code: 'OCR_RATE_LIMITED',
    retryable: true,
  } as const;
  assert.deepEqual(await cached.recognize(request), expected);
  assert.deepEqual(await cached.recognize(request), expected);
  assert.equal(providerCount, 2);
  assert.equal(writeCount, 0);
  assert.equal(cached.getCacheSnapshot().l1EntryCount, 0);
});

test('OCR cache read and write errors preserve provider fallback', async () => {
  const outcomes: OcrCacheEventOutcome[] = [];
  let providerCount = 0;
  const cached = createCachedOcrProvider({
    provider: provider(async () => {
      providerCount += 1;
      return { kind: 'SUCCEEDED', text: 'PANTHENOL' };
    }),
    store: {
      async get(): Promise<never> {
        throw new Error('database read detail');
      },
      async put(): Promise<never> {
        throw new Error('database write detail');
      },
    },
    l1MaxEntries: 10,
    l1TtlMs: 60_000,
    onCacheEvent: ({ outcome }) => outcomes.push(outcome),
  });

  assert.deepEqual(await cached.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'PANTHENOL',
  });
  assert.equal(providerCount, 1);
  assert.deepEqual(outcomes, ['READ_ERROR', 'WRITE_ERROR']);
});

test('aborting one duplicate waiter does not cancel shared OCR work', async () => {
  let complete: ((result: OcrResult) => void) | undefined;
  let providerSignal: AbortSignal | undefined;
  const cached = createCachedOcrProvider({
    provider: provider(
      (input) =>
        new Promise<OcrResult>((resolveResult) => {
          providerSignal = input.signal;
          complete = resolveResult;
        }),
    ),
    store: memoryStore(),
    l1MaxEntries: 10,
    l1TtlMs: 60_000,
  });
  const controller = new AbortController();

  const cancelled = cached.recognize({ ...request, signal: controller.signal });
  const surviving = cached.recognize(request);
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
  controller.abort();

  assert.deepEqual(await cancelled, {
    kind: 'FAILED',
    code: 'OCR_ABORTED',
    retryable: false,
  });
  assert.equal(providerSignal?.aborted, false);
  assert.ok(complete);
  complete({ kind: 'SUCCEEDED', text: 'COPERNICIA CERIFERA CERA' });
  assert.deepEqual(await surviving, {
    kind: 'SUCCEEDED',
    text: 'COPERNICIA CERIFERA CERA',
  });
});

test('aborting the last waiter cancels underlying OCR work', async () => {
  let providerSignal: AbortSignal | undefined;
  const cached = createCachedOcrProvider({
    provider: provider(
      (input) =>
        new Promise<OcrResult>((resolveResult) => {
          providerSignal = input.signal;
          input.signal?.addEventListener(
            'abort',
            () =>
              resolveResult({
                kind: 'FAILED',
                code: 'OCR_ABORTED',
                retryable: false,
              }),
            { once: true },
          );
        }),
    ),
    store: memoryStore(),
    l1MaxEntries: 10,
    l1TtlMs: 60_000,
  });
  const controller = new AbortController();
  const result = cached.recognize({ ...request, signal: controller.signal });
  await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));

  controller.abort();

  assert.deepEqual(await result, {
    kind: 'FAILED',
    code: 'OCR_ABORTED',
    retryable: false,
  });
  assert.equal(providerSignal?.aborted, true);
  assert.equal(cached.getCacheSnapshot().inflightCount, 0);
});

test(
  'PostgreSQL L2 survives cache and database recreation',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const firstDatabase = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 2,
      applicationName: 'wtm-ocr-cache-first',
    });

    try {
      await firstDatabase.migrate(resolve('apps/server/migrations'));
      await adminPool.query('TRUNCATE wtm_ocr_provider_cache');
      const first = createCachedOcrProvider({
        provider: provider(async () => ({
          kind: 'SUCCEEDED',
          text: 'AQUA, PARAFFIN',
        })),
        store: firstDatabase.ocrCache,
        l1MaxEntries: 10,
        l1TtlMs: 60_000,
      });
      assert.deepEqual(await first.recognize(request), {
        kind: 'SUCCEEDED',
        text: 'AQUA, PARAFFIN',
      });
    } finally {
      await firstDatabase.close();
    }

    const secondDatabase = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 2,
      applicationName: 'wtm-ocr-cache-second',
    });
    let providerCount = 0;
    try {
      const restarted = createCachedOcrProvider({
        provider: provider(async () => {
          providerCount += 1;
          return {
            kind: 'FAILED',
            code: 'OCR_PROVIDER_UNAVAILABLE',
            retryable: true,
          };
        }),
        store: secondDatabase.ocrCache,
        l1MaxEntries: 10,
        l1TtlMs: 60_000,
      });

      assert.deepEqual(await restarted.recognize(request), {
        kind: 'SUCCEEDED',
        text: 'AQUA, PARAFFIN',
      });
      assert.equal(providerCount, 0);
    } finally {
      await secondDatabase.close();
      await adminPool.end();
    }
  },
);
