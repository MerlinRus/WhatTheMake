import type {
  ExternalProductDiscoveryProvider,
  ExternalProductDiscoveryResult,
  NormalizedGtin,
} from '@wtm/domain';

const API_ORIGIN = 'https://world.openbeautyfacts.org';
const DEFAULT_USER_AGENT = 'WhatTheMake/0.1 (https://whatthemake.ru)';

type FetchTransport = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface CacheEntry {
  expiresAt: number;
  result: ExternalProductDiscoveryResult;
}

export interface OpenBeautyFactsProductProviderOptions {
  fetch?: FetchTransport;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxCacheEntries?: number;
  foundTtlMs?: number;
  notFoundTtlMs?: number;
  userAgent?: string;
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0 || normalized.length > maximum) return null;
  return normalized;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('json')) throw new Error('INVALID_RESPONSE');
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw new Error('INVALID_RESPONSE');
  }

  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('INVALID_RESPONSE');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('INVALID_RESPONSE');
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('INVALID_RESPONSE');
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProduct(
  payload: unknown,
  gtin: NormalizedGtin,
  fetchedAt: Date,
): ExternalProductDiscoveryResult {
  const root = object(payload);
  const product = object(root?.product);
  if (root === null || product === null) {
    return {
      kind: 'UNAVAILABLE',
      gtin: gtin.value,
      reason: 'INVALID_RESPONSE',
    };
  }
  const responseCode = boundedText(product.code ?? root.code, 14);
  if (responseCode === null || !/^\d{8,14}$/.test(responseCode)) {
    return {
      kind: 'UNAVAILABLE',
      gtin: gtin.value,
      reason: 'INVALID_RESPONSE',
    };
  }
  const normalizedResponse = responseCode.padStart(14, '0');
  if (normalizedResponse !== gtin.gtin14) {
    return {
      kind: 'UNAVAILABLE',
      gtin: gtin.value,
      reason: 'INVALID_RESPONSE',
    };
  }

  const productName =
    boundedText(product.product_name_ru, 300) ??
    boundedText(product.product_name, 300);
  if (productName === null) {
    return {
      kind: 'UNAVAILABLE',
      gtin: gtin.value,
      reason: 'INVALID_RESPONSE',
    };
  }
  return {
    kind: 'FOUND',
    gtin: gtin.value,
    brandName: boundedText(product.brands, 200),
    productName,
    quantity: boundedText(product.quantity, 100),
    fetchedAt,
  };
}

export function createOpenBeautyFactsProductProvider(
  options: OpenBeautyFactsProductProviderOptions = {},
): ExternalProductDiscoveryProvider {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 6_000;
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  const maxCacheEntries = options.maxCacheEntries ?? 256;
  const foundTtlMs = options.foundTtlMs ?? 30 * 60_000;
  const notFoundTtlMs = options.notFoundTtlMs ?? 5 * 60_000;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ExternalProductDiscoveryResult>>();

  function cacheResult(result: ExternalProductDiscoveryResult): void {
    if (maxCacheEntries === 0 || result.kind === 'UNAVAILABLE') return;
    while (cache.size >= maxCacheEntries) {
      const first = cache.keys().next().value as string | undefined;
      if (first === undefined) break;
      cache.delete(first);
    }
    cache.set(result.gtin, {
      result,
      expiresAt:
        now().getTime() +
        (result.kind === 'FOUND' ? foundTtlMs : notFoundTtlMs),
    });
  }

  async function request(
    gtin: NormalizedGtin,
  ): Promise<ExternalProductDiscoveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = new URL(`/api/v3/product/${gtin.value}`, API_ORIGIN);
      url.searchParams.set('product_type', 'beauty');
      url.searchParams.set(
        'fields',
        'code,product_name,product_name_ru,brands,quantity',
      );
      const response = await transport(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': userAgent,
        },
      });
      if (response.status === 404) {
        return { kind: 'NOT_FOUND', gtin: gtin.value };
      }
      if (response.status === 429) {
        return {
          kind: 'UNAVAILABLE',
          gtin: gtin.value,
          reason: 'RATE_LIMITED',
        };
      }
      if (response.status >= 300 && response.status < 400) {
        return {
          kind: 'UNAVAILABLE',
          gtin: gtin.value,
          reason: 'INVALID_RESPONSE',
        };
      }
      if (!response.ok) {
        return {
          kind: 'UNAVAILABLE',
          gtin: gtin.value,
          reason: 'UPSTREAM_ERROR',
        };
      }
      return parseProduct(
        await readBoundedJson(response, maxResponseBytes),
        gtin,
        now(),
      );
    } catch (error) {
      return {
        kind: 'UNAVAILABLE',
        gtin: gtin.value,
        reason:
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
            ? 'TIMEOUT'
            : error instanceof Error && error.message === 'INVALID_RESPONSE'
              ? 'INVALID_RESPONSE'
              : 'UPSTREAM_ERROR',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async discover(gtin) {
      const cached = cache.get(gtin.value);
      if (cached !== undefined) {
        if (cached.expiresAt > now().getTime()) return cached.result;
        cache.delete(gtin.value);
      }
      const pending = inFlight.get(gtin.value);
      if (pending !== undefined) return pending;
      const operation = request(gtin).then((result) => {
        cacheResult(result);
        return result;
      });
      inFlight.set(gtin.value, operation);
      try {
        return await operation;
      } finally {
        inFlight.delete(gtin.value);
      }
    },
  };
}
