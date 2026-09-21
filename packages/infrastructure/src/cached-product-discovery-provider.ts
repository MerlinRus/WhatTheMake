import {
  normalizeGtin,
  type ExternalProductDiscoveryProvider,
  type ExternalProductDiscoveryResult,
  type NormalizedGtin,
} from '@wtm/domain';

const FOUND_TTL_MS = 6 * 60 * 60_000;
const NOT_FOUND_TTL_MS = 15 * 60_000;

export interface CachedProductDiscoveryProviderOptions {
  provider: ExternalProductDiscoveryProvider;
  /** Epoch milliseconds; injected for deterministic expiry tests. */
  now?: () => number;
  maxCacheEntries?: number;
  maxConcurrentRequests?: number;
  foundTtlMs?: number;
  notFoundTtlMs?: number;
}

type CacheableResult = Exclude<
  ExternalProductDiscoveryResult,
  { kind: 'UNAVAILABLE' }
>;
interface CacheEntry {
  expiresAt: number;
  result: CacheableResult;
}

function boundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function clone(
  result: ExternalProductDiscoveryResult,
  gtin: NormalizedGtin,
): ExternalProductDiscoveryResult {
  return result.kind === 'FOUND'
    ? {
        ...result,
        gtin: gtin.value,
        fetchedAt: new Date(result.fetchedAt.getTime()),
      }
    : { ...result, gtin: gtin.value };
}

/** Wrap one provider instance; the provider retains responsibility for its I/O deadline. */
export function createCachedProductDiscoveryProvider(
  options: CachedProductDiscoveryProviderOptions,
): ExternalProductDiscoveryProvider {
  const now = options.now ?? Date.now;
  const maxEntries = boundedInteger(
    'maxCacheEntries',
    options.maxCacheEntries ?? 500,
    0,
    500,
  );
  const maxConcurrent = boundedInteger(
    'maxConcurrentRequests',
    options.maxConcurrentRequests ?? 16,
    1,
    16,
  );
  const foundTtl = boundedInteger(
    'foundTtlMs',
    options.foundTtlMs ?? FOUND_TTL_MS,
    1,
    FOUND_TTL_MS,
  );
  const notFoundTtl = boundedInteger(
    'notFoundTtlMs',
    options.notFoundTtlMs ?? NOT_FOUND_TTL_MS,
    1,
    NOT_FOUND_TTL_MS,
  );
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ExternalProductDiscoveryResult>>();

  function remember(key: string, result: ExternalProductDiscoveryResult): void {
    if (maxEntries === 0 || result.kind === 'UNAVAILABLE') return;
    const instant = now();
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt <= instant) cache.delete(entryKey);
    }
    cache.delete(key);
    cache.set(key, {
      expiresAt: instant + (result.kind === 'FOUND' ? foundTtl : notFoundTtl),
      result,
    });
    while (cache.size > maxEntries) {
      const leastRecent = cache.keys().next().value;
      if (leastRecent === undefined) break;
      cache.delete(leastRecent);
    }
  }

  return {
    async discover(input) {
      const gtin = { ...input };
      const key = gtin.gtin14;
      const cached = cache.get(key);
      if (cached) {
        if (cached.expiresAt > now()) {
          cache.delete(key);
          cache.set(key, cached);
          return clone(cached.result, gtin);
        }
        cache.delete(key);
      }
      const pending = inFlight.get(key);
      if (pending) return clone(await pending, gtin);
      if (inFlight.size >= maxConcurrent)
        return {
          kind: 'UNAVAILABLE',
          gtin: gtin.value,
          reason: 'RATE_LIMITED',
        };

      // Install the promise before calling the provider, including synchronously throwing providers.
      const operation: Promise<ExternalProductDiscoveryResult> =
        Promise.resolve()
          .then(() => options.provider.discover({ ...gtin }))
          .then((result) => {
            const responseGtin = normalizeGtin(result.gtin);
            if (
              responseGtin.kind !== 'VALID' ||
              responseGtin.gtin.gtin14 !== key
            ) {
              return {
                kind: 'UNAVAILABLE',
                gtin: gtin.value,
                reason: 'INVALID_RESPONSE',
              } as const;
            }
            const stableResult = clone(result, gtin);
            remember(key, stableResult);
            return stableResult;
          })
          .catch((): ExternalProductDiscoveryResult => ({
            kind: 'UNAVAILABLE',
            gtin: gtin.value,
            reason: 'UPSTREAM_ERROR',
          }))
          .finally(() => {
            inFlight.delete(key);
          });
      inFlight.set(key, operation);
      return clone(await operation, gtin);
    },
  };
}
