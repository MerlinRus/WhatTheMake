import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { TextDecoder } from 'node:util';
const { fetch, AbortSignal } = globalThis;

// Server-only, explicit opt-in. One OCR request through normal durable quotas.
// This proves a synthetic happy path, not real-camera accuracy or latency p95.
const ORIGIN = 'https://whatthemake.ru';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COOKIE = /^__Host-wtm_session=[A-Za-z0-9_-]{43}$/;

class SmokeFailure extends Error {
  constructor(code, cause) {
    super(code, { cause });
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new SmokeFailure(code);
}

async function main() {
  const codes = [];
  let browser;
  let cookie = null;
  let guestAttempted = false;
  let observationId = null;
  let stage = 'OPT_IN';
  let failed = false;

  async function request(code, path, options = {}) {
    const {
      method = 'GET',
      json,
      bytes,
      expected = 200,
      readJson = true,
      captureCookie = false,
      timeoutMs = 15_000,
    } = options;
    let response;
    try {
      response = await fetch(ORIGIN + path, {
        method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Origin: ORIGIN,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(bytes ? { 'Content-Type': 'image/png' } : {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
        ...(bytes ? { body: bytes } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (captureCookie) {
        const issued = response.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .find((value) => COOKIE.test(value));
        if (issued) cookie = issued;
      }
      requireCondition(
        response.status === expected,
        `${code}_HTTP_${response.status}`,
      );
      if (!readJson) return null;
      requireCondition(
        response.headers.get('content-type')?.includes('application/json'),
        `${code}_CONTENT_TYPE`,
      );
      const reader = response.body?.getReader();
      requireCondition(reader, `${code}_BODY_MISSING`);
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          requireCondition(size <= 512 * 1024, `${code}_BODY_TOO_LARGE`);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch (error) {
      if (error instanceof SmokeFailure) throw error;
      throw new SmokeFailure(`${code}_REQUEST_FAILED`, error);
    } finally {
      await response?.body?.cancel().catch(() => {});
    }
  }

  try {
    requireCondition(process.env.RUN_LIVE_OCR_SMOKE === '1', 'OPT_IN_REQUIRED');
    stage = 'SYNTHETIC_IMAGE';
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
    const page = await browser.newPage({
      viewport: { width: 1200, height: 240 },
    });
    page.setDefaultTimeout(15_000);
    await page.route('**/*', (route) => route.abort());
    await page.setContent(
      '<html><body style="margin:0"><canvas width="1200" height="240"></canvas></body></html>',
      { timeout: 15_000 },
    );
    await page.evaluate(
      (noise) => {
        const canvas = globalThis.document.querySelector('canvas');
        const context = canvas.getContext('2d');
        context.fillStyle = 'white';
        context.fillRect(0, 0, 1200, 240);
        context.fillStyle = 'black';
        context.font = 'bold 42px Arial, sans-serif';
        context.fillText('INGREDIENTS: AQUA, GLYCERIN, MICA.', 45, 120);
        // Unique image digest avoids proving only an earlier shared OCR cache hit.
        // Tiny synthetic corner pixels add no user data or additional ingredient text.
        noise.forEach((value, index) => {
          context.fillStyle = `rgb(${value},${value},${value})`;
          context.fillRect(index, 239, 1, 1);
        });
      },
      [...randomBytes(32)],
    );
    const png = await page
      .locator('canvas')
      .screenshot({ type: 'png', timeout: 15_000 });
    requireCondition(
      png.length > 0 &&
        png.length <= 8 * 1024 * 1024 &&
        png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
      'SYNTHETIC_IMAGE_INVALID',
    );
    codes.push('SYNTHETIC_IMAGE_OK');

    stage = 'GUEST';
    guestAttempted = true;
    const guest = await request('GUEST', '/api/v1/guest-sessions', {
      method: 'POST',
      expected: 201,
      captureCookie: true,
    });
    requireCondition(
      cookie &&
        guest?.principal?.kind === 'GUEST' &&
        UUID.test(guest.principal.guestId),
      'GUEST_SHAPE_INVALID',
    );
    codes.push('GUEST_CREATED');

    stage = 'OBSERVATION';
    const created = await request(
      'OBSERVATION',
      '/api/v1/product-observations',
      { method: 'POST', json: { gtin: '9999999999994' }, expected: 201 },
    );
    requireCondition(
      UUID.test(created?.observation?.observationId),
      'OBSERVATION_ID_INVALID',
    );
    observationId = created.observation.observationId;
    const collectionId = created.observation.mediaCollection?.collectionId;
    requireCondition(UUID.test(collectionId), 'COLLECTION_ID_INVALID');
    const base = `/api/v1/product-observations/${observationId}`;

    stage = 'UPLOAD';
    const uploaded = await request(
      'UPLOAD',
      `/api/v1/media-collections/${collectionId}/assets?role=INGREDIENTS`,
      { method: 'POST', bytes: png, expected: 201 },
    );
    const assetId = uploaded?.asset?.assetId;
    requireCondition(
      UUID.test(assetId) && uploaded.asset.role === 'INGREDIENTS',
      'UPLOAD_SHAPE_INVALID',
    );
    codes.push('INGREDIENTS_UPLOADED');

    stage = 'OCR';
    const recognized = await request('OCR', `${base}/inci-ocr`, {
      method: 'POST',
      json: { mediaAssetId: assetId },
      expected: 201,
      timeoutMs: 25_000,
    });
    const revision = recognized?.revision;
    requireCondition(
      recognized?.resultKind === 'CREATED' &&
        UUID.test(revision?.revisionId) &&
        revision?.source?.kind === 'OCR',
      'OCR_REVISION_INVALID',
    );
    requireCondition(
      typeof revision.sourceText === 'string' &&
        /\bAQUA\b/i.test(revision.sourceText) &&
        /\bGLYCERIN\b/i.test(revision.sourceText),
      'OCR_EXPECTED_WORDS_MISSING',
    );
    codes.push('OCR_EXPECTED_WORDS_OK');

    stage = 'ANALYSIS';
    const analyzed = await request(
      'ANALYSIS',
      `${base}/inci-revisions/${revision.revisionId}/analysis`,
    );
    const analysis = analyzed?.analysis;
    requireCondition(
      analysis?.selectedRevisionId === revision.revisionId &&
        analysis?.sourceSha256 === revision.sourceSha256 &&
        analysis?.parse?.kind === 'PARSED' &&
        analysis.parse.tokenCount >= 2 &&
        analysis?.normalization?.kind === 'COMPLETED' &&
        analysis.normalization.resolvedCount >= 2,
      'ANALYSIS_INVALID',
    );
    codes.push('ANALYSIS_OK');
  } catch (error) {
    failed = true;
    codes.push(error instanceof SmokeFailure ? error.code : `${stage}_FAILED`);
  } finally {
    if (cookie) {
      let erased = false;
      let cleanupFailureCode = null;
      // Deletion is idempotent; one bounded retry also covers a lost 204 response.
      for (let attempt = 0; attempt < 2 && !erased; attempt += 1) {
        try {
          await request('CLEANUP', '/api/v1/guest-sessions/current', {
            method: 'DELETE',
            expected: 204,
            readJson: false,
          });
          erased = true;
        } catch (error) {
          cleanupFailureCode =
            error instanceof SmokeFailure
              ? error.code
              : 'CLEANUP_UNKNOWN_FAILURE';
        }
      }
      if (!erased) {
        failed = true;
        codes.push('GUEST_CLEANUP_UNCONFIRMED');
        codes.push(cleanupFailureCode ?? 'CLEANUP_NO_RESULT');
      } else {
        codes.push('GUEST_DELETED');
        try {
          // Reuse the revoked cookie, rather than merely omitting credentials.
          await request(
            'REVOKED_ACCESS',
            observationId
              ? `/api/v1/product-observations/${observationId}/inci-revisions`
              : '/api/v1/private-products',
            { expected: 401, readJson: false },
          );
          codes.push('PRIVATE_ACCESS_REVOKED');
        } catch {
          failed = true;
          codes.push('PRIVATE_ACCESS_REVOCATION_UNCONFIRMED');
        }
      }
    } else if (guestAttempted) {
      failed = true;
      codes.push('GUEST_CLEANUP_NO_SESSION');
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        failed = true;
        codes.push('BROWSER_CLOSE_FAILED');
      }
    }
  }
  process.stdout.write(
    `${JSON.stringify({ kind: 'LIVE_OCR_SMOKE', passed: !failed, codes })}\n`,
  );
  process.exitCode = failed ? 1 : 0;
}

await main().catch(() => {
  process.stdout.write(
    '{"kind":"LIVE_OCR_SMOKE","passed":false,"codes":["SMOKE_INTERNAL_FAILURE"]}\n',
  );
  process.exitCode = 1;
});
