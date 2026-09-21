import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeGtin,
  type ExternalProductDiscoveryResult,
  type NormalizedGtin,
} from '@wtm/domain';
import { createCachedProductDiscoveryProvider } from '../src/cached-product-discovery-provider.js';

function gtin(value = '4006381333931'): NormalizedGtin {
  const normalized = normalizeGtin(value);
  assert.equal(normalized.kind, 'VALID');
  if (normalized.kind !== 'VALID') throw new Error('Invalid test GTIN');
  return normalized.gtin;
}
function fixtureGtin(index: number): NormalizedGtin {
  const prefix = String(2_000_000_000_000 + index).slice(0, 12);
  for (let digit = 0; digit < 10; digit += 1) {
    const result = normalizeGtin(`${prefix}${digit}`);
    if (result.kind === 'VALID') return result.gtin;
  }
  throw new Error('Unable to construct fixture GTIN');
}
function found(value: NormalizedGtin): ExternalProductDiscoveryResult {
  return {
    kind: 'FOUND',
    gtin: value.value,
    brandName: 'Test',
    productName: 'Mascara',
    quantity: null,
    category: 'MASCARA',
    fetchedAt: new Date('2026-09-20T00:00:00.000Z'),
  };
}

test('discovery cache expires positive results at six hours and misses at fifteen minutes', async () => {
  let now = 0;
  let positiveCalls = 0;
  let negativeCalls = 0;
  const provider = createCachedProductDiscoveryProvider({
    now: () => now,
    provider: {
      async discover(value) {
        if (value.value === '4006381333931') {
          positiveCalls += 1;
          return found(value);
        }
        negativeCalls += 1;
        return { kind: 'NOT_FOUND', gtin: value.value };
      },
    },
  });
  const positive = gtin();
  const negative = gtin('5901234123457');
  await provider.discover(positive);
  await provider.discover(negative);
  now = 15 * 60_000 - 1;
  await provider.discover(negative);
  assert.equal(negativeCalls, 1);
  now += 1;
  await provider.discover(negative);
  assert.equal(negativeCalls, 2);
  now = 6 * 60 * 60_000 - 1;
  await provider.discover(positive);
  assert.equal(positiveCalls, 1);
  now += 1;
  await provider.discover(positive);
  assert.equal(positiveCalls, 2);
});

test('discovery cache uses LRU order and never exceeds the default 500 entries', async () => {
  const calls = new Map<string, number>();
  const provider = createCachedProductDiscoveryProvider({
    provider: {
      async discover(value) {
        calls.set(value.gtin14, (calls.get(value.gtin14) ?? 0) + 1);
        return found(value);
      },
    },
  });
  const values = Array.from({ length: 501 }, (_, index) =>
    fixtureGtin(index * 10),
  );
  for (const value of values.slice(0, 500)) await provider.discover(value);
  await provider.discover(values[0]!);
  await provider.discover(values[500]!);
  await provider.discover(values[0]!);
  assert.equal(calls.get(values[0]!.gtin14), 1);
  await provider.discover(values[1]!);
  assert.equal(calls.get(values[1]!.gtin14), 2);
});

test('discovery cache deduplicates canonical GTIN while isolating each caller and upstream object', async () => {
  let calls = 0;
  let complete!: (value: ExternalProductDiscoveryResult) => void;
  const waiting = new Promise<ExternalProductDiscoveryResult>((resolve) => {
    complete = resolve;
  });
  const provider = createCachedProductDiscoveryProvider({
    provider: {
      async discover() {
        calls += 1;
        return waiting;
      },
    },
  });
  const first = provider.discover(gtin());
  const second = provider.discover(gtin('04006381333931'));
  const upstream = found(gtin());
  complete(upstream);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(a.gtin, '4006381333931');
  assert.equal(b.gtin, '04006381333931');
  assert.notEqual(a, b);
  assert.equal(a.kind, 'FOUND');
  assert.equal(b.kind, 'FOUND');
  assert.equal(upstream.kind, 'FOUND');
  if (a.kind !== 'FOUND' || b.kind !== 'FOUND' || upstream.kind !== 'FOUND')
    throw new Error('Expected found');
  a.productName = 'Mutated';
  a.fetchedAt.setTime(0);
  upstream.productName = 'Provider mutated';
  upstream.fetchedAt.setTime(1);
  const cached = await provider.discover(gtin());
  assert.equal(cached.kind, 'FOUND');
  if (cached.kind !== 'FOUND') throw new Error('Expected cached result');
  assert.equal(cached.productName, 'Mascara');
  assert.equal(cached.fetchedAt.toISOString(), '2026-09-20T00:00:00.000Z');
  assert.equal(b.productName, 'Mascara');
  assert.equal(b.fetchedAt.toISOString(), '2026-09-20T00:00:00.000Z');
  assert.notEqual(cached.fetchedAt, b.fetchedAt);
});

test('discovery cache rejects the seventeenth unique request but admits duplicate waiters and releases capacity', async () => {
  let complete!: () => void;
  const barrier = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const provider = createCachedProductDiscoveryProvider({
    provider: {
      async discover(value) {
        calls += 1;
        await barrier;
        return found(value);
      },
    },
  });
  const values = Array.from({ length: 17 }, (_, index) =>
    fixtureGtin(index * 10),
  );
  const pending = values.slice(0, 16).map((value) => provider.discover(value));
  const duplicate = provider.discover(values[0]!);
  assert.deepEqual(await provider.discover(values[16]!), {
    kind: 'UNAVAILABLE',
    gtin: values[16]!.value,
    reason: 'RATE_LIMITED',
  });
  complete();
  await Promise.all([...pending, duplicate]);
  assert.equal(calls, 16);
  assert.equal((await provider.discover(values[16]!)).kind, 'FOUND');
  assert.equal(calls, 17);
});

test('discovery cache never caches unavailable, rejection or mismatched identity', async () => {
  for (const reason of [
    'TIMEOUT',
    'RATE_LIMITED',
    'UPSTREAM_ERROR',
    'INVALID_RESPONSE',
    'DISABLED',
  ] as const) {
    let calls = 0;
    const provider = createCachedProductDiscoveryProvider({
      provider: {
        async discover(value) {
          calls += 1;
          return { kind: 'UNAVAILABLE', gtin: value.value, reason };
        },
      },
    });
    assert.deepEqual(await provider.discover(gtin()), {
      kind: 'UNAVAILABLE',
      gtin: gtin().value,
      reason,
    });
    await provider.discover(gtin());
    assert.equal(calls, 2);
  }
  let calls = 0;
  const rejected = createCachedProductDiscoveryProvider({
    provider: {
      discover() {
        calls += 1;
        throw new Error('Provider exception');
      },
    },
  });
  for (let index = 0; index < 2; index += 1)
    assert.deepEqual(await rejected.discover(gtin()), {
      kind: 'UNAVAILABLE',
      gtin: gtin().value,
      reason: 'UPSTREAM_ERROR',
    });
  assert.equal(calls, 2);
  let mismatches = 0;
  const wrong = createCachedProductDiscoveryProvider({
    provider: {
      async discover() {
        mismatches += 1;
        return found(gtin('5901234123457'));
      },
    },
  });
  for (let index = 0; index < 2; index += 1)
    assert.deepEqual(await wrong.discover(gtin()), {
      kind: 'UNAVAILABLE',
      gtin: gtin().value,
      reason: 'INVALID_RESPONSE',
    });
  assert.equal(mismatches, 2);
});

test('discovery cache validates resource limits and supports no-cache mode', async () => {
  const upstream = {
    async discover(value: NormalizedGtin) {
      return found(value);
    },
  };
  for (const options of [
    { maxCacheEntries: 501 },
    { maxCacheEntries: -1 },
    { maxConcurrentRequests: 17 },
    { maxConcurrentRequests: 0 },
    { foundTtlMs: 0 },
    { notFoundTtlMs: Number.NaN },
  ])
    assert.throws(() =>
      createCachedProductDiscoveryProvider({ provider: upstream, ...options }),
    );
  let calls = 0;
  const disabled = createCachedProductDiscoveryProvider({
    maxCacheEntries: 0,
    provider: {
      async discover(value) {
        calls += 1;
        return found(value);
      },
    },
  });
  await disabled.discover(gtin());
  await disabled.discover(gtin());
  assert.equal(calls, 2);
});
