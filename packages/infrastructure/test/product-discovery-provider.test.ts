import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGtin } from '@wtm/domain';

import { createOpenBeautyFactsProductProvider } from '../src/open-beauty-facts-product-provider.js';

function gtin(value = '4006381333931') {
  const result = normalizeGtin(value);
  assert.equal(result.kind, 'VALID');
  if (result.kind !== 'VALID') throw new Error('fixture GTIN is invalid');
  return result.gtin;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('Open Beauty Facts provider uses fixed exact endpoint and caches a bounded result', async () => {
  let calls = 0;
  const provider = createOpenBeautyFactsProductProvider({
    fetch: async (input, init) => {
      calls += 1;
      const url = new URL(input);
      assert.equal(url.origin, 'https://world.openbeautyfacts.org');
      assert.equal(url.pathname, '/api/v3/product/4006381333931');
      assert.equal(url.searchParams.get('product_type'), 'beauty');
      assert.match(
        String(init?.headers && Object.entries(init.headers).flat().join(' ')),
        /WhatTheMake/,
      );
      assert.equal(init?.redirect, 'manual');
      return jsonResponse({
        code: '4006381333931',
        product: {
          code: '4006381333931',
          brands: 'Lash Lab',
          product_name: 'Decision Mascara',
          quantity: '10 ml',
        },
      });
    },
  });

  const first = await provider.discover(gtin());
  const second = await provider.discover(gtin());
  assert.equal(first.kind, 'FOUND');
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test('Open Beauty Facts provider deduplicates concurrent requests', async () => {
  let calls = 0;
  let complete!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => (complete = resolve));
  const provider = createOpenBeautyFactsProductProvider({
    fetch: async () => {
      calls += 1;
      return pending;
    },
  });
  const first = provider.discover(gtin());
  const second = provider.discover(gtin());
  complete(
    jsonResponse({
      code: '4006381333931',
      product: { code: '4006381333931', product_name: 'Mascara' },
    }),
  );
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('Open Beauty Facts provider maps miss, throttling and redirect without following it', async () => {
  const missing = createOpenBeautyFactsProductProvider({
    fetch: async () => jsonResponse({}, 404),
  });
  const throttled = createOpenBeautyFactsProductProvider({
    fetch: async () => jsonResponse({}, 429),
  });
  const redirect = createOpenBeautyFactsProductProvider({
    fetch: async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example/collect' },
      }),
  });
  assert.equal((await missing.discover(gtin())).kind, 'NOT_FOUND');
  assert.deepEqual(await throttled.discover(gtin()), {
    kind: 'UNAVAILABLE',
    gtin: '4006381333931',
    reason: 'RATE_LIMITED',
  });
  assert.equal((await redirect.discover(gtin())).kind, 'UNAVAILABLE');
});

test('Open Beauty Facts provider rejects wrong identity, controls and oversized body', async () => {
  const wrong = createOpenBeautyFactsProductProvider({
    fetch: async () =>
      jsonResponse({
        code: '5901234123457',
        product: { code: '5901234123457', product_name: 'Wrong' },
      }),
  });
  const control = createOpenBeautyFactsProductProvider({
    fetch: async () =>
      jsonResponse({
        code: '4006381333931',
        product: { code: '4006381333931', product_name: 'Bad\u0001name' },
      }),
  });
  const bidi = createOpenBeautyFactsProductProvider({
    fetch: async () =>
      jsonResponse({
        code: '4006381333931',
        product: {
          code: '4006381333931',
          product_name: 'Safe\u202Egpj.exe',
        },
      }),
  });
  const oversized = createOpenBeautyFactsProductProvider({
    maxResponseBytes: 64,
    fetch: async () =>
      jsonResponse({
        code: '4006381333931',
        product: { code: '4006381333931', product_name: 'x'.repeat(100) },
      }),
  });
  for (const provider of [wrong, control, bidi, oversized]) {
    assert.deepEqual(await provider.discover(gtin()), {
      kind: 'UNAVAILABLE',
      gtin: '4006381333931',
      reason: 'INVALID_RESPONSE',
    });
  }
});

test('Open Beauty Facts provider bounds request time', async () => {
  const provider = createOpenBeautyFactsProductProvider({
    timeoutMs: 5,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  });
  assert.deepEqual(await provider.discover(gtin()), {
    kind: 'UNAVAILABLE',
    gtin: '4006381333931',
    reason: 'TIMEOUT',
  });
});
