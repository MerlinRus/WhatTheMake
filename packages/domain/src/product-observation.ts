import type { AuthenticatedIdentity } from './identity.js';
import type { Gtin14 } from './gtin.js';
import type { MediaCollection } from './media.js';
import type { NormalizedGtin } from './gtin.js';
import type { NetQuantityUnit, ProductVariantId } from './catalog.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export type ProductObservationId = TaggedString<'ProductObservationId'>;
export type CatalogPromotionCaseId = TaggedString<'CatalogPromotionCaseId'>;
export type ProductObservationConfirmationId =
  TaggedString<'ProductObservationConfirmationId'>;
export type CatalogIdentityFingerprint =
  TaggedString<'CatalogIdentityFingerprint'>;

export interface ProductObservation {
  observationId: ProductObservationId;
  barcode: NormalizedGtin;
  mediaCollection: MediaCollection;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateProductObservationResult = {
  kind: 'CREATED' | 'REUSED';
  observation: ProductObservation;
};

export interface CatalogPromotionIdentityInput {
  brandName: string;
  familyName: string;
  variantName: string;
  shadeName: string | null;
  netQuantity: {
    value: string;
    unit: NetQuantityUnit;
  } | null;
  isWaterproof: boolean | null;
}

export interface CatalogPromotionIdentity {
  brandName: string;
  familyName: string;
  variantName: string;
  shadeName: string | null;
  netQuantityValue: string | null;
  netQuantityUnit: NetQuantityUnit | null;
  waterproof: boolean | null;
}

export type CatalogPromotionState =
  | {
      state: 'WAITING_FOR_MATCH' | 'NEEDS_MODERATION';
      matchingAccountCount: number;
      productVariantId: null;
    }
  | {
      state: 'PUBLISHED';
      matchingAccountCount: number;
      productVariantId: ProductVariantId;
    };

export type SubmitCatalogConfirmationResult =
  | {
      kind: 'CREATED' | 'REUSED';
      promotion: CatalogPromotionState;
      confirmationId: ProductObservationConfirmationId;
    }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_CONFIRMED' }
  | { kind: 'PROMOTION_CLOSED' };

export type ModerateCatalogPromotionResult =
  | { kind: 'PUBLISHED'; promotion: CatalogPromotionState }
  | { kind: 'CASE_NOT_FOUND' }
  | { kind: 'CONFIRMATION_NOT_FOUND' }
  | { kind: 'PROMOTION_CLOSED' }
  | { kind: 'CATALOG_CONFLICT' };

function normalizedLabel(value: string, maxLength: number): string | null {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized.length > 0 && normalized.length <= maxLength
    ? normalized
    : null;
}

function normalizedDecimal(value: string): string | null {
  if (!/^[0-9]{1,8}(?:\.[0-9]{1,4})?$/.test(value)) return null;
  const [rawInteger = '', rawFraction] = value.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/, '');
  const fraction = rawFraction?.replace(/0+$/, '') ?? '';
  const normalized = fraction.length > 0 ? `${integer}.${fraction}` : integer;
  return /^0(?:\.0*)?$/.test(normalized) ? null : normalized;
}

export function normalizeCatalogPromotionIdentity(
  input: CatalogPromotionIdentityInput,
): CatalogPromotionIdentity | null {
  const brandName = normalizedLabel(input.brandName, 200);
  const familyName = normalizedLabel(input.familyName, 300);
  const variantName = normalizedLabel(input.variantName, 300);
  const shadeName =
    input.shadeName === null ? null : normalizedLabel(input.shadeName, 200);
  const netQuantityValue =
    input.netQuantity === null
      ? null
      : normalizedDecimal(input.netQuantity.value);

  if (
    !brandName ||
    !familyName ||
    !variantName ||
    (input.shadeName !== null && !shadeName) ||
    (input.netQuantity !== null && !netQuantityValue)
  ) {
    return null;
  }

  return {
    brandName,
    familyName,
    variantName,
    shadeName,
    netQuantityValue,
    netQuantityUnit: input.netQuantity?.unit ?? null,
    waterproof: input.isWaterproof,
  };
}

export function catalogPromotionFingerprintMaterial(
  gtin14: Gtin14,
  identity: CatalogPromotionIdentity,
): string {
  return JSON.stringify([
    'catalog-promotion-v1',
    gtin14,
    identity.brandName.toLowerCase(),
    identity.familyName.toLowerCase(),
    identity.variantName.toLowerCase(),
    identity.shadeName?.toLowerCase() ?? null,
    identity.netQuantityValue,
    identity.netQuantityUnit,
    identity.waterproof,
  ]);
}

export interface ProductObservationRepository {
  createOrReuse(
    owner: AuthenticatedIdentity,
    barcode: NormalizedGtin,
  ): Promise<CreateProductObservationResult>;
  findOwned(
    observationId: ProductObservationId,
    owner: AuthenticatedIdentity,
  ): Promise<ProductObservation | null>;
  submitCatalogConfirmation(input: {
    observationId: ProductObservationId;
    accountId: string;
    fingerprint: CatalogIdentityFingerprint;
    identity: CatalogPromotionIdentity;
  }): Promise<SubmitCatalogConfirmationResult>;
  moderateCatalogPromotion(input: {
    promotionCaseId: CatalogPromotionCaseId;
    confirmationId: ProductObservationConfirmationId;
    moderatorAccountId: string;
  }): Promise<ModerateCatalogPromotionResult>;
}
