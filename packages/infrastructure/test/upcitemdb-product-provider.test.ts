import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeGtin,
  type ExternalProductDiscoveryResult,
} from '@wtm/domain';
import {
  createUpcItemDbProductProvider,
  type UpcItemDbProductProviderOptions,
} from '../src/upcitemdb-product-provider.js';

const code = '4250587753509';
function gtin(value = code) {
  const result = normalizeGtin(value);
  if (result.kind !== 'VALID') throw new Error('Invalid fixture code');
  return result.gtin;
}
function payload(item: Record<string, unknown> = {}) {
  return {
    code: 'OK',
    total: 1,
    items: [
      {
        ean: code,
        title: 'Fixture mascara',
        brand: 'Fixture',
        size: '10 ml',
        category:
          'Health & Beauty > Personal Care > Cosmetics > Makeup > Eye Makeup > Mascara',
        ...item,
      },
    ],
  };
}
function json(
  body: unknown = payload(),
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
function fixture(overrides: Partial<UpcItemDbProductProviderOptions> = {}) {
  let instant = Date.parse('2026-09-20T12:00:00Z');
  let calls = 0;
  let reservations = 0;
  const completed: ExternalProductDiscoveryResult[] = [];
  const provider = createUpcItemDbProductProvider({
    now: () => new Date(instant),
    admitRequest: async () => {
      reservations += 1;
      return {
        async complete(result) {
          completed.push(result);
        },
      };
    },
    ...overrides,
    fetch: async (input, init) => {
      calls += 1;
      assert.equal(new URL(input).origin, 'https://api.upcitemdb.com');
      assert.equal(new URL(input).pathname, '/prod/trial/lookup');
      assert.equal(init?.redirect, 'manual');
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).has('user_key'), false);
      return overrides.fetch ? overrides.fetch(input, init) : json();
    },
  });
  return {
    provider,
    calls: () => calls,
    reservations: () => reservations,
    completed,
    advance(milliseconds: number) {
      instant += milliseconds;
    },
    instant: () => instant,
  };
}

test('UPCitemdb uses only free exact lookup and returns bounded candidate fields', async () => {
  for (const value of [code, `0${code}`]) {
    const f = fixture({
      fetch: async (input) => {
        assert.equal(new URL(input).searchParams.get('upc'), value);
        return json(
          payload({
            offers: [{ price: 0, link: 'http://127.0.0.1/private' }],
            images: ['http://127.0.0.1/image'],
            rating: 5,
            ingredients: 'invented',
          }),
        );
      },
    });
    assert.deepEqual(await f.provider.discover(gtin(value)), {
      kind: 'FOUND',
      provider: 'UPCITEMDB',
      gtin: value,
      brandName: 'Fixture',
      productName: 'Fixture mascara',
      quantity: '10 ml',
      category: 'MASCARA',
      fetchedAt: new Date(f.instant()),
    });
    assert.equal(f.calls(), 1);
    assert.equal(f.reservations(), 1);
    assert.equal(f.completed.length, 1);
  }
});

test('UPCitemdb refuses unbudgeted requests and validates constructor bounds', async () => {
  assert.throws(() =>
    createUpcItemDbProductProvider({} as UpcItemDbProductProviderOptions),
  );
  for (const overrides of [
    { timeoutMs: 0 },
    { timeoutMs: 6001 },
    { maxResponseBytes: 65_537 },
  ]) {
    assert.throws(() => fixture(overrides));
  }
  const f = fixture({ admitRequest: async () => null });
  assert.deepEqual(await f.provider.discover(gtin()), {
    kind: 'UNAVAILABLE',
    provider: 'UPCITEMDB',
    gtin: code,
    reason: 'RATE_LIMITED',
  });
  assert.equal(f.calls(), 0);
  assert.equal(f.completed.length, 0);
  const failed = fixture({
    admitRequest: async () => {
      throw new Error('Budget unavailable');
    },
  });
  assert.equal((await failed.provider.discover(gtin())).kind, 'UNAVAILABLE');
  assert.equal(failed.calls(), 0);
});

test('UPCitemdb enforces one inflight request and 10.1-second local spacing', async () => {
  let release!: (value: Response) => void;
  const barrier = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const f = fixture({ fetch: async () => barrier });
  const first = f.provider.discover(gtin());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await f.provider.discover(gtin())).kind, 'UNAVAILABLE');
  release(json());
  assert.equal((await first).kind, 'FOUND');
  f.advance(10_099);
  assert.equal((await f.provider.discover(gtin())).kind, 'UNAVAILABLE');
  assert.equal(f.calls(), 1);
  assert.equal(f.reservations(), 1);
});

test('UPCitemdb rejects mismatched codes, packaging indicators and multiple hits', async () => {
  const cases = [
    payload({ ean: '5901234123457' }),
    payload({ ean: 4250587753509 }),
    payload({ upc: '041554007503' }),
    payload({ gtin: '14250587753506' }),
    payload({ title: 'text\u202Eunsafe' }),
    payload({ title: 'x'.repeat(301) }),
    { code: 'OK', total: 2, items: [...payload().items, ...payload().items] },
    { code: 'OK', total: 0, items: payload().items },
    { code: 'SERVER_ERR', total: 0, items: [] },
  ];
  for (const body of cases) {
    const f = fixture({ fetch: async () => json(body) });
    assert.deepEqual(await f.provider.discover(gtin()), {
      kind: 'UNAVAILABLE',
      provider: 'UPCITEMDB',
      gtin: code,
      reason: 'INVALID_RESPONSE',
    });
    assert.equal(f.completed.length, 1);
  }
});

test('UPCitemdb category conflicts are unsupported and missing taxonomy remains unknown', async () => {
  for (const [title, category, expected] of [
    ['Mascara Primer', 'Makeup > Mascara', 'OTHER'],
    ['Brow Mascara', 'Makeup > Mascara', 'OTHER'],
    ['Brown Mascara', 'Makeup > Mascara', 'MASCARA'],
    ['Mascara', null, 'UNKNOWN'],
  ] as const) {
    const f = fixture({
      fetch: async () => json(payload({ title, category })),
    });
    const result = await f.provider.discover(gtin());
    assert.equal(result.kind, 'FOUND');
    if (result.kind === 'FOUND') assert.equal(result.category, expected);
  }
});

test('UPCitemdb distinguishes a source miss from rate, upstream and redirect errors', async () => {
  for (const [status, kind, reason] of [
    [404, 'NOT_FOUND', undefined],
    [429, 'UNAVAILABLE', 'RATE_LIMITED'],
    [503, 'UNAVAILABLE', 'UPSTREAM_ERROR'],
    [302, 'UNAVAILABLE', 'INVALID_RESPONSE'],
  ] as const) {
    const f = fixture({
      fetch: async () =>
        json({}, status, { Location: 'http://127.0.0.1/private' }),
    });
    const result = await f.provider.discover(gtin());
    assert.equal(result.kind, kind);
    if (result.kind === 'UNAVAILABLE') assert.equal(result.reason, reason);
    assert.equal(f.completed.length, 1);
    assert.equal(f.calls(), 1);
  }
  const f = fixture({
    fetch: async () => json({ code: 'OK', total: 0, items: [] }),
  });
  assert.equal((await f.provider.discover(gtin())).kind, 'NOT_FOUND');
});

test('UPCitemdb respects bounded retry and reset cooldown before reserving another request', async () => {
  let requests = 0;
  const f = fixture({
    fetch: async () =>
      ++requests === 1
        ? json({}, 429, {
            'Retry-After': '120',
            'X-RateLimit-Reset': String(
              Date.parse('2026-09-20T12:03:00Z') / 1000,
            ),
          })
        : json(),
  });
  await f.provider.discover(gtin());
  f.advance(179_999);
  assert.equal((await f.provider.discover(gtin())).kind, 'UNAVAILABLE');
  assert.equal(f.reservations(), 1);
  f.advance(1);
  assert.equal((await f.provider.discover(gtin())).kind, 'FOUND');
  assert.equal(f.reservations(), 2);
  const bounded = fixture({
    fetch: async () =>
      json({}, 429, { 'Retry-After': '999999999999999999999' }),
  });
  await bounded.provider.discover(gtin());
  bounded.advance(86_400_000);
  await bounded.provider.discover(gtin());
  assert.equal(bounded.calls(), 2);
});

test('UPCitemdb honours exhausted remaining header even on a successful response', async () => {
  const f = fixture({
    fetch: async () =>
      json(payload(), 200, {
        'X-RateLimit-Remaining': '0',
        'Retry-After': '120',
      }),
  });
  assert.equal((await f.provider.discover(gtin())).kind, 'FOUND');
  f.advance(60_000);
  assert.equal((await f.provider.discover(gtin())).kind, 'UNAVAILABLE');
  assert.equal(f.calls(), 1);
});

test('UPCitemdb bounds body, content type and deadline; completion error preserves response', async () => {
  for (const fetch of [
    async () =>
      new Response('not json', { headers: { 'Content-Type': 'text/html' } }),
    async () => json(payload({ description: 'x'.repeat(65_536) })),
    async () => json({}, 200, { 'Content-Length': '70000' }),
  ]) {
    const result = await fixture({ fetch }).provider.discover(gtin());
    assert.equal(result.kind, 'UNAVAILABLE');
    if (result.kind === 'UNAVAILABLE')
      assert.equal(result.reason, 'INVALID_RESPONSE');
  }
  const timed = fixture({
    timeoutMs: 5,
    fetch: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
  });
  const result = await timed.provider.discover(gtin());
  assert.equal(result.kind, 'UNAVAILABLE');
  if (result.kind === 'UNAVAILABLE') assert.equal(result.reason, 'TIMEOUT');
  assert.equal(timed.completed.length, 1);
  let completed = 0;
  const statsFailed = fixture({
    admitRequest: async () => ({
      async complete() {
        completed += 1;
        throw new Error('Statistics unavailable');
      },
    }),
  });
  assert.equal((await statsFailed.provider.discover(gtin())).kind, 'FOUND');
  assert.equal(completed, 1);
});
