import type {
  ExternalProductDiscoveryProvider,
  ExternalProductDiscoveryResult,
  NormalizedGtin,
} from '@wtm/domain';

/** Sequential, attributed fallback; an unavailable source never becomes a clean miss. */
export function createFallbackProductDiscoveryProvider(options: {
  primary: ExternalProductDiscoveryProvider;
  secondary: ExternalProductDiscoveryProvider;
}): ExternalProductDiscoveryProvider {
  async function call(
    provider: ExternalProductDiscoveryProvider,
    gtin: NormalizedGtin,
  ): Promise<ExternalProductDiscoveryResult> {
    try {
      const result = await provider.discover(gtin);
      if (result.gtin === gtin.value) return result;
      return {
        kind: 'UNAVAILABLE',
        gtin: gtin.value,
        reason: 'INVALID_RESPONSE',
      };
    } catch {
      return {
        kind: 'UNAVAILABLE',
        gtin: gtin.value,
        reason: 'UPSTREAM_ERROR',
      };
    }
  }
  return {
    async discover(gtin) {
      const primary = await call(options.primary, gtin);
      if (
        primary.kind === 'FOUND' ||
        (primary.kind === 'UNAVAILABLE' &&
          primary.reason === 'INVALID_RESPONSE')
      ) {
        return { ...primary, provider: 'OPEN_BEAUTY_FACTS' };
      }
      const secondary = await call(options.secondary, gtin);
      if (secondary.kind === 'FOUND')
        return { ...secondary, provider: 'UPCITEMDB' };
      if (primary.kind === 'NOT_FOUND' && secondary.kind === 'NOT_FOUND') {
        return {
          kind: 'NOT_FOUND',
          gtin: gtin.value,
          provider: 'EXTERNAL_CATALOGS',
        };
      }
      const unavailable =
        secondary.kind === 'UNAVAILABLE' ? secondary : primary;
      return {
        kind: 'UNAVAILABLE',
        gtin: gtin.value,
        provider: 'EXTERNAL_CATALOGS',
        reason:
          unavailable.kind === 'UNAVAILABLE'
            ? unavailable.reason
            : 'UPSTREAM_ERROR',
      };
    },
  };
}
