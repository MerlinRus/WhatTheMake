import type { NormalizedGtin } from './gtin.js';

export type ProductDiscoveryUnavailableReason =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INVALID_RESPONSE'
  | 'DISABLED';

export type ExternalProductDiscoveryResult = (
  | {
      kind: 'FOUND';
      gtin: string;
      brandName: string | null;
      productName: string;
      quantity: string | null;
      category?: 'MASCARA' | 'OTHER' | 'UNKNOWN';
      fetchedAt: Date;
    }
  | { kind: 'NOT_FOUND'; gtin: string }
  | {
      kind: 'UNAVAILABLE';
      gtin: string;
      reason: ProductDiscoveryUnavailableReason;
    }
) & { provider?: 'OPEN_BEAUTY_FACTS' | 'UPCITEMDB' | 'EXTERNAL_CATALOGS' };

export interface ExternalProductDiscoveryProvider {
  discover(gtin: NormalizedGtin): Promise<ExternalProductDiscoveryResult>;
}
