import assert from 'node:assert/strict';
import test from 'node:test';

import type { OcrTelemetryEvent } from '@wtm/domain';

import {
  createFakeOcrProvider,
  createGoogleVisionOcrProvider,
} from '../src/index.js';

const request = {
  operation: 'DOCUMENT_TEXT_DETECTION' as const,
  imageBytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
  mediaType: 'image/jpeg' as const,
  languageHints: ['ru', 'en'],
};

test('Google Vision adapter sends a bounded document OCR request and reports safe telemetry', async () => {
  const apiKey = 'vision-test-secret';
  const telemetry: OcrTelemetryEvent[] = [];
  let capturedUrl = '';
  let capturedHeaders = new Headers();
  let capturedBody: unknown;

  const requestFetch: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        responses: [
          {
            fullTextAnnotation: {
              text: 'AQUA, CERA ALBA',
              pages: [{ width: 100, height: 200 }],
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const provider = createGoogleVisionOcrProvider({
    apiKey,
    fetch: requestFetch,
    onTelemetry: (event) => telemetry.push(event),
  });

  assert.deepEqual(await provider.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'AQUA, CERA ALBA',
  });
  assert.equal(capturedUrl, 'https://vision.googleapis.com/v1/images:annotate');
  assert.equal(capturedHeaders.get('x-goog-api-key'), apiKey);
  assert.deepEqual(capturedBody, {
    requests: [
      {
        image: { content: '/9j/2Q==' },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
        imageContext: { languageHints: ['ru', 'en'] },
      },
    ],
  });
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]?.outcome, 'SUCCEEDED');
  assert.equal(telemetry[0]?.providerId, 'GOOGLE_VISION');
  assert.equal(JSON.stringify(telemetry).includes(apiKey), false);
  assert.equal(JSON.stringify(telemetry).includes('/9j/2Q=='), false);
  assert.equal(JSON.stringify(telemetry).includes('AQUA'), false);
});

test('Google Vision adapter rejects malformed provider fixtures', async () => {
  const fixtures: unknown[] = [
    null,
    {},
    { responses: [] },
    { responses: [{ fullTextAnnotation: { text: 42 } }] },
    { responses: [{ error: { code: '8', message: 'quota' } }] },
  ];

  for (const fixture of fixtures) {
    const provider = createGoogleVisionOcrProvider({
      apiKey: 'test-key',
      fetch: async () => new Response(JSON.stringify(fixture), { status: 200 }),
    });
    assert.deepEqual(await provider.recognize(request), {
      kind: 'FAILED',
      code: 'OCR_INVALID_RESPONSE',
      retryable: false,
    });
  }
});

test('Google Vision adapter maps provider failures to stable codes', async () => {
  const rateLimited = createGoogleVisionOcrProvider({
    apiKey: 'test-key',
    fetch: async () => new Response('', { status: 429 }),
  });
  assert.deepEqual(await rateLimited.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_RATE_LIMITED',
    retryable: true,
  });

  const permissionDenied = createGoogleVisionOcrProvider({
    apiKey: 'test-key',
    fetch: async () =>
      new Response(
        JSON.stringify({
          responses: [
            { error: { code: 7, message: 'provider-controlled text' } },
          ],
        }),
        { status: 200 },
      ),
  });
  assert.deepEqual(await permissionDenied.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_PERMISSION_DENIED',
    retryable: false,
  });
});

function abortAwareFetch(): typeof fetch {
  return async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('Missing abort signal'));
        return;
      }
      const rejectAbort = (): void => reject(signal.reason);
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      signal.addEventListener('abort', rejectAbort, { once: true });
    });
}

test('Google Vision adapter enforces timeout', async () => {
  const provider = createGoogleVisionOcrProvider({
    apiKey: 'test-key',
    timeoutMs: 5,
    fetch: abortAwareFetch(),
  });

  assert.deepEqual(await provider.recognize(request), {
    kind: 'FAILED',
    code: 'OCR_TIMEOUT',
    retryable: true,
  });
});

test('Google Vision adapter propagates caller abort', async () => {
  const controller = new AbortController();
  const provider = createGoogleVisionOcrProvider({
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      controller.abort();
      throw init?.signal?.reason;
    },
  });

  assert.deepEqual(
    await provider.recognize({ ...request, signal: controller.signal }),
    {
      kind: 'FAILED',
      code: 'OCR_ABORTED',
      retryable: false,
    },
  );
});

test('fake OCR adapter captures calls and returns scripted results', async () => {
  const provider = createFakeOcrProvider((_input, index) => ({
    kind: 'SUCCEEDED',
    text: `fixture-${index}`,
  }));

  assert.deepEqual(await provider.recognize(request), {
    kind: 'SUCCEEDED',
    text: 'fixture-0',
  });
  assert.equal(provider.providerId, 'FAKE');
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0], request);
});
