import {
  hasUnsupportedMascaraCategory,
  normalizeGtin,
  type ExternalProductDiscoveryProvider,
  type ExternalProductDiscoveryResult,
  type NormalizedGtin,
  type ProductDiscoveryUnavailableReason,
} from '@wtm/domain';

const API_ENDPOINT = 'https://api.upcitemdb.com/prod/trial/lookup';
const MINIMUM_REQUEST_INTERVAL_MS = 10_100;
const MAXIMUM_COOLDOWN_MS = 86_400_000;

export interface UpcItemDbRequestAdmission {
  complete(result: ExternalProductDiscoveryResult): Promise<void>;
}

export interface UpcItemDbProductProviderOptions {
  /** Must reserve against the shared persistent daily budget before returning. */
  admitRequest(): Promise<UpcItemDbRequestAdmission | null>;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return normalized.length > 0 && normalized.length <= maximum
    ? normalized
    : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unavailable(
  gtin: NormalizedGtin,
  reason: ProductDiscoveryUnavailableReason,
): ExternalProductDiscoveryResult {
  return {
    kind: 'UNAVAILABLE',
    provider: 'UPCITEMDB',
    gtin: gtin.value,
    reason,
  };
}

async function readJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('json'))
    throw new Error('INVALID_RESPONSE');
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maximum)
    throw new Error('INVALID_RESPONSE');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_RESPONSE');
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new Error('INVALID_RESPONSE');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error('INVALID_RESPONSE');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parse(
  payload: unknown,
  gtin: NormalizedGtin,
  fetchedAt: Date,
): ExternalProductDiscoveryResult {
  const root = object(payload);
  if (
    !root ||
    root.code !== 'OK' ||
    !Number.isSafeInteger(root.total) ||
    !Array.isArray(root.items)
  )
    return unavailable(gtin, 'INVALID_RESPONSE');
  if (root.total === 0 && root.items.length === 0)
    return { kind: 'NOT_FOUND', provider: 'UPCITEMDB', gtin: gtin.value };
  if (root.total !== 1 || root.items.length !== 1)
    return unavailable(gtin, 'INVALID_RESPONSE');
  const item = object(root.items[0]);
  if (!item || typeof item.ean !== 'string' || !/^\d{13}$/.test(item.ean))
    return unavailable(gtin, 'INVALID_RESPONSE');
  for (const field of ['ean', 'upc', 'gtin']) {
    const value = item[field];
    if (
      field !== 'ean' &&
      (value === undefined || value === null || value === '')
    )
      continue;
    if (typeof value !== 'string') return unavailable(gtin, 'INVALID_RESPONSE');
    const normalized = normalizeGtin(value);
    if (normalized.kind !== 'VALID' || normalized.gtin.gtin14 !== gtin.gtin14)
      return unavailable(gtin, 'INVALID_RESPONSE');
  }
  const productName = text(item.title, 300);
  if (productName === null) return unavailable(gtin, 'INVALID_RESPONSE');
  const categoryText = text(item.category, 500);
  const category = hasUnsupportedMascaraCategory(
    productName,
    categoryText ?? '',
  )
    ? 'OTHER'
    : categoryText?.split('>').some((part) => /^mascaras?$/i.test(part.trim()))
      ? 'MASCARA'
      : 'UNKNOWN';
  return {
    kind: 'FOUND',
    provider: 'UPCITEMDB',
    gtin: gtin.value,
    brandName: text(item.brand, 200),
    productName,
    quantity: text(item.size, 100),
    category,
    fetchedAt,
  };
}

function cooldown(headers: Headers, instant: number): number {
  const candidates = [60_000];
  const retry = headers.get('retry-after');
  if (retry !== null && retry.length <= 100) {
    const delay = /^\d+$/.test(retry)
      ? Number(retry) * 1000
      : Date.parse(retry) - instant;
    if (Number.isFinite(delay) && delay > 0) candidates.push(delay);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && /^\d{1,16}$/.test(reset)) {
    const delay = Number(reset) * 1000 - instant;
    if (delay > 0) candidates.push(delay);
  }
  return instant + Math.min(MAXIMUM_COOLDOWN_MS, Math.max(...candidates));
}

/** Candidate-only free lookup; never fetches returned image/offer URLs. */
export function createUpcItemDbProductProvider(
  options: UpcItemDbProductProviderOptions,
): ExternalProductDiscoveryProvider {
  if (typeof options.admitRequest !== 'function')
    throw new Error('UPCitemdb requires shared budget admission');
  const transport = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 6000;
  const maximum = options.maxResponseBytes ?? 64 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 6000 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 64 * 1024
  )
    throw new Error('Invalid UPCitemdb request bounds');
  let inFlight = false;
  let nextRequestAt = Number.NEGATIVE_INFINITY;

  async function request(
    gtin: NormalizedGtin,
  ): Promise<ExternalProductDiscoveryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      const url = new URL(API_ENDPOINT);
      url.searchParams.set('upc', gtin.value);
      response = await transport(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'WhatTheMake/0.1 (https://whatthemake.ru)',
        },
      });
      if (
        response.status === 429 ||
        response.headers.get('x-ratelimit-remaining') === '0'
      )
        nextRequestAt = Math.max(
          nextRequestAt,
          cooldown(response.headers, now().getTime()),
        );
      if (response.status === 429) return unavailable(gtin, 'RATE_LIMITED');
      if (response.status === 404)
        return { kind: 'NOT_FOUND', provider: 'UPCITEMDB', gtin: gtin.value };
      if (response.status >= 300 && response.status < 400)
        return unavailable(gtin, 'INVALID_RESPONSE');
      if (!response.ok) return unavailable(gtin, 'UPSTREAM_ERROR');
      return parse(await readJson(response, maximum), gtin, now());
    } catch (error) {
      return unavailable(
        gtin,
        controller.signal.aborted
          ? 'TIMEOUT'
          : error instanceof Error && error.message === 'INVALID_RESPONSE'
            ? 'INVALID_RESPONSE'
            : 'UPSTREAM_ERROR',
      );
    } finally {
      await response?.body?.cancel().catch(() => {});
      clearTimeout(timer);
    }
  }

  return {
    async discover(gtin) {
      const normalized = normalizeGtin(gtin.value);
      if (normalized.kind !== 'VALID' || normalized.gtin.gtin14 !== gtin.gtin14)
        return unavailable(gtin, 'INVALID_RESPONSE');
      if (inFlight || now().getTime() < nextRequestAt)
        return unavailable(gtin, 'RATE_LIMITED');
      inFlight = true;
      try {
        const admission = await options.admitRequest();
        if (!admission) return unavailable(gtin, 'RATE_LIMITED');
        nextRequestAt = now().getTime() + MINIMUM_REQUEST_INTERVAL_MS;
        const result = await request(gtin);
        try {
          await admission.complete(result);
        } catch {
          /* Telemetry failure must not alter product evidence. */
        }
        return result;
      } catch {
        return unavailable(gtin, 'UPSTREAM_ERROR');
      } finally {
        inFlight = false;
      }
    },
  };
}
