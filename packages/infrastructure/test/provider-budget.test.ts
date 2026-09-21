import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  LlmTextTransformRequest,
  ProviderAdmission,
  ProviderBudgetCompletion,
  ProviderBudgetReservation,
  ProviderAdmissionResult,
} from '@wtm/domain';
import { createGoogleVisionOcrProvider } from '../src/google-vision-ocr-provider.js';
import { createDeepSeekLlmProvider } from '../src/deepseek-llm-provider.js';
import { createProviderBudgetAdmission } from '../src/provider-budget-admission.js';
import { createCachedOcrProvider } from '../src/cached-ocr-provider.js';

const image = {
  operation: 'DOCUMENT_TEXT_DETECTION' as const,
  imageBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  mediaType: 'image/jpeg' as const,
};
const text: LlmTextTransformRequest = {
  operation: 'CLASSIFY_AND_SUMMARIZE_ALLOWED_TEXT',
  locale: 'ru-RU',
  items: [{ itemId: 'one', text: 'Private input sentinel' }],
  allowedLabels: ['VOLUME'],
};

test('both paid adapters deny before fetch when budget is exhausted or repository fails', async () => {
  for (const reason of ['BUDGET_EXHAUSTED', 'BUDGET_UNAVAILABLE'] as const) {
    let fetched = 0;
    const beforeDispatch: ProviderAdmission = async () => ({
      kind: 'DENIED',
      reason,
    });
    const fetch: typeof globalThis.fetch = async () => {
      fetched += 1;
      throw new Error('Unexpected fetch');
    };
    const ocr = createGoogleVisionOcrProvider({
      apiKey: 'test-secret',
      beforeDispatch,
      fetch,
    });
    const llm = createDeepSeekLlmProvider({
      enabled: true,
      apiKey: 'test-secret',
      beforeDispatch,
      fetch,
    });
    assert.deepEqual(await ocr.recognize(image), {
      kind: 'FAILED',
      code: `OCR_${reason}`,
      retryable: false,
    });
    const result = await llm.transform(text);
    assert.equal(result.kind, 'FALLBACK');
    if (result.kind === 'FALLBACK') {
      assert.equal(result.code, `LLM_${reason}`);
      assert.equal(result.retryable, false);
    }
    assert.equal(fetched, 0);
  }
});

test('thrown admission fails closed in both adapters', async () => {
  const beforeDispatch: ProviderAdmission = async () => {
    throw new Error('Private database failure');
  };
  let fetched = 0;
  const fetch: typeof globalThis.fetch = async () => {
    fetched += 1;
    throw new Error('Unexpected fetch');
  };
  const ocr = await createGoogleVisionOcrProvider({
    apiKey: 'test',
    beforeDispatch,
    fetch,
  }).recognize(image);
  const llm = await createDeepSeekLlmProvider({
    enabled: true,
    apiKey: 'test',
    beforeDispatch,
    fetch,
  }).transform(text);
  assert.equal(ocr.kind === 'FAILED' && ocr.code, 'OCR_BUDGET_UNAVAILABLE');
  assert.equal(llm.kind === 'FALLBACK' && llm.code, 'LLM_BUDGET_UNAVAILABLE');
  assert.equal(fetched, 0);
});

test('invalid, disabled and pre-aborted requests do not reserve quota', async () => {
  let reservations = 0;
  const beforeDispatch: ProviderAdmission = async () => {
    reservations += 1;
    return { kind: 'DENIED', reason: 'BUDGET_EXHAUSTED' };
  };
  const signal = AbortSignal.abort();
  const ocr = createGoogleVisionOcrProvider({ apiKey: 'test', beforeDispatch });
  const llm = createDeepSeekLlmProvider({
    enabled: true,
    apiKey: 'test',
    beforeDispatch,
  });
  await ocr.recognize({ ...image, imageBytes: new Uint8Array() });
  await ocr.recognize({ ...image, signal });
  await llm.transform({ ...text, items: [] });
  await llm.transform({ ...text, signal });
  await createDeepSeekLlmProvider({ enabled: false, beforeDispatch }).transform(
    text,
  );
  assert.equal(reservations, 0);
});

test('admitted provider failure remains charged and finishes only numeric/enum data', async () => {
  let reservations = 0;
  const completed: ProviderBudgetCompletion[] = [];
  const beforeDispatch = createProviderBudgetAdmission({
    async reserve(): Promise<ProviderBudgetReservation> {
      reservations += 1;
      return { kind: 'ADMITTED', reservationId: 'test-reservation' };
    },
    async complete(_id, completion) {
      completed.push(completion);
      return true;
    },
  });
  await createGoogleVisionOcrProvider({
    apiKey: 'test-secret',
    beforeDispatch,
    fetch: async () => new Response('', { status: 401 }),
  }).recognize(image);
  await createDeepSeekLlmProvider({
    enabled: true,
    apiKey: 'test-secret',
    beforeDispatch,
    fetch: async () => {
      throw new Error('Private network detail');
    },
  }).transform(text);
  assert.equal(reservations, 2);
  assert.deepEqual(
    completed.map((entry) => entry.outcome),
    ['AUTHENTICATION_FAILED', 'PROVIDER_UNAVAILABLE'],
  );
  for (const completion of completed) {
    assert.deepEqual(Object.keys(completion).sort(), ['durationMs', 'outcome']);
    assert.ok(completion.durationMs >= 0);
  }
  assert.equal(JSON.stringify(completed).includes('Private'), false);
  assert.equal(JSON.stringify(completed).includes('test-secret'), false);
});

test(
  'aborted during admission never fetches but keeps the conservative reservation',
  { timeout: 5_000 },
  async () => {
    const controller = new AbortController();
    let record!: (value: ProviderBudgetCompletion) => void;
    const completed = new Promise<ProviderBudgetCompletion>((resolve) => {
      record = resolve;
    });
    let fetched = 0;
    const beforeDispatch: ProviderAdmission = async () => {
      controller.abort();
      return {
        kind: 'ADMITTED',
        async complete(value) {
          record(value);
        },
      };
    };
    const result = await createGoogleVisionOcrProvider({
      apiKey: 'test',
      beforeDispatch,
      fetch: async () => {
        fetched += 1;
        throw new Error();
      },
    }).recognize({ ...image, signal: controller.signal });
    assert.equal(result.kind === 'FAILED' && result.code, 'OCR_ABORTED');
    assert.equal(fetched, 0);
    assert.equal((await completed).outcome, 'ABORTED');
  },
);

test('upstream timeout consumes admission once without automatic retries', async () => {
  const completed: ProviderBudgetCompletion[] = [];
  let fetched = 0;
  const beforeDispatch: ProviderAdmission = async () => ({
    kind: 'ADMITTED',
    async complete(value) {
      completed.push(value);
    },
  });
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    fetched += 1;
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted)
        reject(new DOMException('Aborted', 'AbortError'));
      else
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
    });
  };
  const ocr = await createGoogleVisionOcrProvider({
    apiKey: 'test',
    beforeDispatch,
    fetch,
    timeoutMs: 5,
  }).recognize(image);
  const llm = await createDeepSeekLlmProvider({
    enabled: true,
    apiKey: 'test',
    beforeDispatch,
    fetch,
    timeoutMs: 5,
  }).transform(text);
  assert.equal(ocr.kind === 'FAILED' && ocr.code, 'OCR_TIMEOUT');
  assert.equal(llm.kind === 'FALLBACK' && llm.code, 'LLM_TIMEOUT');
  assert.equal(fetched, 2);
  assert.deepEqual(
    completed.map((entry) => entry.outcome),
    ['TIMEOUT', 'TIMEOUT'],
  );
});

test('completion database failure cannot replace a successful OCR result', async () => {
  const beforeDispatch = createProviderBudgetAdmission({
    async reserve() {
      return { kind: 'ADMITTED', reservationId: 'test' };
    },
    async complete() {
      throw new Error('Database down');
    },
  });
  assert.deepEqual(
    await createGoogleVisionOcrProvider({
      apiKey: 'test',
      beforeDispatch,
      fetch: async () =>
        new Response(
          JSON.stringify({
            responses: [{ fullTextAnnotation: { text: 'AQUA' } }],
          }),
        ),
    }).recognize(image),
    { kind: 'SUCCEEDED', text: 'AQUA' },
  );
  const denied = createProviderBudgetAdmission({
    async reserve() {
      throw new Error('Database down');
    },
    async complete() {
      throw new Error('Unexpected completion');
    },
  });
  assert.deepEqual(await denied('GOOGLE_VISION'), {
    kind: 'DENIED',
    reason: 'BUDGET_UNAVAILABLE',
  });
});

test('OCR L1, L2 and in-flight cache reuse never admit another paid invocation', async () => {
  const store = new Map<string, string>();
  let reservations = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const upstream = createGoogleVisionOcrProvider({
    apiKey: 'test',
    beforeDispatch: async () => {
      reservations += 1;
      started();
      return { kind: 'ADMITTED', async complete() {} };
    },
    fetch: async () => {
      await held;
      return new Response(
        JSON.stringify({
          responses: [{ fullTextAnnotation: { text: 'AQUA' } }],
        }),
      );
    },
  });
  const cacheStore = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
  const cacheOptions = {
    provider: upstream,
    store: cacheStore,
    l1MaxEntries: 10,
    l1TtlMs: 60_000,
  };
  const cached = createCachedOcrProvider(cacheOptions);
  const first = cached.recognize(image);
  await admitted;
  const second = cached.recognize(image);
  release();
  await Promise.all([first, second]);
  await cached.recognize(image);
  await createCachedOcrProvider(cacheOptions).recognize(image);
  assert.equal(reservations, 1);
});

test(
  'budget admission deadline denies dispatch and late reservation stays charged',
  { timeout: 5_000 },
  async () => {
    let reserve!: (result: ProviderBudgetReservation) => void;
    let recorded!: (value: ProviderBudgetCompletion) => void;
    const accounting = new Promise<ProviderBudgetCompletion>((resolve) => {
      recorded = resolve;
    });
    const admission = createProviderBudgetAdmission(
      {
        reserve: () =>
          new Promise((resolve) => {
            reserve = resolve;
          }),
        async complete(_id, value) {
          recorded(value);
          return true;
        },
      },
      { admissionTimeoutMs: 5 },
    );
    assert.deepEqual(await admission('GOOGLE_VISION'), {
      kind: 'DENIED',
      reason: 'BUDGET_UNAVAILABLE',
    });
    reserve({ kind: 'ADMITTED', reservationId: 'late-charged' });
    assert.equal((await accounting).outcome, 'TIMEOUT');
  },
);

test(
  'budget completion deadline returns even when accounting never settles',
  { timeout: 5_000 },
  async () => {
    const admission = createProviderBudgetAdmission(
      {
        async reserve() {
          return { kind: 'ADMITTED', reservationId: 'charged' };
        },
        complete: () => new Promise<boolean>(() => {}),
      },
      { completionTimeoutMs: 5 },
    );
    const result = await admission('DEEPSEEK');
    assert.equal(result.kind, 'ADMITTED');
    if (result.kind === 'ADMITTED')
      await result.complete({ outcome: 'SUCCEEDED', durationMs: 1 });
  },
);

test(
  'both provider hooks abort while admission is pending and never dispatch a late grant',
  { timeout: 5_000 },
  async () => {
    for (const kind of ['OCR', 'LLM'] as const) {
      const controller = new AbortController();
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let grant!: (result: ProviderAdmissionResult) => void;
      let recorded!: (value: ProviderBudgetCompletion) => void;
      const accounting = new Promise<ProviderBudgetCompletion>((resolve) => {
        recorded = resolve;
      });
      let fetched = 0;
      const beforeDispatch: ProviderAdmission = () => {
        started();
        return new Promise((resolve) => {
          grant = resolve;
        });
      };
      const fetch: typeof globalThis.fetch = async () => {
        fetched += 1;
        throw new Error('Unexpected dispatch');
      };
      const operation =
        kind === 'OCR'
          ? createGoogleVisionOcrProvider({
              apiKey: 'test',
              beforeDispatch,
              fetch,
            }).recognize({ ...image, signal: controller.signal })
          : createDeepSeekLlmProvider({
              enabled: true,
              apiKey: 'test',
              beforeDispatch,
              fetch,
            }).transform({ ...text, signal: controller.signal });
      await waiting;
      controller.abort();
      const result = await operation;
      assert.equal(
        result.kind === 'SUCCEEDED' ? null : result.code,
        `${kind}_ABORTED`,
      );
      assert.equal(fetched, 0);
      grant({
        kind: 'ADMITTED',
        async complete(value) {
          recorded(value);
        },
      });
      assert.equal((await accounting).outcome, 'ABORTED');
      assert.equal(fetched, 0);
    }
  },
);

test(
  'both provider hooks retain their timeout while waiting for admission',
  { timeout: 5_000 },
  async () => {
    const beforeDispatch: ProviderAdmission = () => new Promise(() => {});
    let fetched = 0;
    const fetch: typeof globalThis.fetch = async () => {
      fetched += 1;
      throw new Error('Unexpected dispatch');
    };
    const ocr = await createGoogleVisionOcrProvider({
      apiKey: 'test',
      beforeDispatch,
      fetch,
      timeoutMs: 5,
    }).recognize(image);
    const llm = await createDeepSeekLlmProvider({
      enabled: true,
      apiKey: 'test',
      beforeDispatch,
      fetch,
      timeoutMs: 5,
    }).transform(text);
    assert.equal(ocr.kind === 'FAILED' && ocr.code, 'OCR_TIMEOUT');
    assert.equal(llm.kind === 'FALLBACK' && llm.code, 'LLM_TIMEOUT');
    assert.equal(fetched, 0);
  },
);

test(
  'adapters do not withhold provider results when custom completion hangs',
  { timeout: 5_000 },
  async () => {
    const beforeDispatch: ProviderAdmission = async () => ({
      kind: 'ADMITTED',
      complete: () => new Promise(() => {}),
    });
    const ocr = await createGoogleVisionOcrProvider({
      apiKey: 'test',
      beforeDispatch,
      fetch: async () =>
        new Response(
          JSON.stringify({
            responses: [{ fullTextAnnotation: { text: 'AQUA' } }],
          }),
        ),
    }).recognize(image);
    assert.deepEqual(ocr, { kind: 'SUCCEEDED', text: 'AQUA' });
    const llm = await createDeepSeekLlmProvider({
      enabled: true,
      apiKey: 'test',
      beforeDispatch,
      fetch: async () => new Response('', { status: 401 }),
    }).transform(text);
    assert.equal(
      llm.kind === 'FALLBACK' && llm.code,
      'LLM_AUTHENTICATION_FAILED',
    );
  },
);
