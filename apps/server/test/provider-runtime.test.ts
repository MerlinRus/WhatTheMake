import assert from 'node:assert/strict';
import test from 'node:test';

import type { OcrCacheStore } from '@wtm/infrastructure';

import { createProviderRuntime } from '../src/provider-runtime.js';

function memoryCache(): OcrCacheStore {
  const values = new Map<string, string>();
  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
  };
}

function config() {
  return {
    googleVisionApiKey: 'AIzaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    googleVisionTimeoutMs: 1_000,
    ocrQueueConcurrency: 1,
    ocrQueueMaxPending: 2,
    ocrQueueWaitTimeoutMs: 1_000,
    ocrL1MaxEntries: 4,
    ocrL1TtlMs: 60_000,
    deepSeekEnabled: true,
    deepSeekApiKey: 'sk-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    deepSeekTimeoutMs: 1_000,
  } as const;
}

test('provider runtime composes cached OCR and constructs dormant LLM', async () => {
  let googleCalls = 0;
  let deepSeekCalls = 0;
  const events: unknown[] = [];
  const runtime = createProviderRuntime({
    config: config(),
    ocrCache: memoryCache(),
    googleVisionFetch: async () => {
      googleCalls += 1;
      return new Response(
        JSON.stringify({
          responses: [{ fullTextAnnotation: { text: 'Aqua, Glycerin' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    deepSeekFetch: async () => {
      deepSeekCalls += 1;
      throw new Error('DeepSeek must remain dormant');
    },
    onEvent: (event) => events.push(event),
  });

  const request = {
    operation: 'DOCUMENT_TEXT_DETECTION' as const,
    imageBytes: Uint8Array.from([1, 2, 3]),
    mediaType: 'image/jpeg' as const,
    languageHints: ['ru', 'en'],
  };
  assert.deepEqual(await runtime.ocr?.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'Aqua, Glycerin',
  });
  assert.deepEqual(await runtime.ocr?.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'Aqua, Glycerin',
  });

  assert.equal(googleCalls, 1);
  assert.equal(deepSeekCalls, 0);
  assert.equal(runtime.metadata.googleVision.enabled, true);
  assert.equal(runtime.metadata.deepSeek.enabled, true);
  assert.ok(events.some((event) => JSON.stringify(event).includes('L1_HIT')));
  for (const event of events) {
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes('cacheKey'), false);
    assert.equal(serialized.includes('Aqua'), false);
  }
  await runtime.shutdown();
});

test('provider runtime can explicitly disable both network providers', async () => {
  const runtime = createProviderRuntime({
    config: {
      ...config(),
      googleVisionApiKey: null,
      deepSeekEnabled: false,
      deepSeekApiKey: null,
    },
    ocrCache: memoryCache(),
  });

  assert.equal(runtime.ocr, null);
  assert.equal(runtime.metadata.googleVision.enabled, false);
  assert.equal(runtime.metadata.deepSeek.enabled, false);
  assert.equal(
    (
      await runtime.llm.transform({
        operation: 'CLASSIFY_AND_SUMMARIZE_ALLOWED_TEXT',
        locale: 'ru-RU',
        items: [{ itemId: 'one', text: 'safe text' }],
        allowedLabels: ['POSITIVE'],
      })
    ).kind,
    'FALLBACK',
  );
  await runtime.shutdown();
});
