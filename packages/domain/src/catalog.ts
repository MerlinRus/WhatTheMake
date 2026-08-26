import type { Gtin14, NormalizedGtin } from './gtin.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export type ProductFamilyId = TaggedString<'ProductFamilyId'>;
export type ProductVariantId = TaggedString<'ProductVariantId'>;
export type CatalogProvenanceId = TaggedString<'CatalogProvenanceId'>;
export type FormulaRevisionId = TaggedString<'FormulaRevisionId'>;
export type ProductClaimId = TaggedString<'ProductClaimId'>;

export type ProductCategory = 'MASCARA';
export type CatalogStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type FormulaRevisionStatus = 'CURRENT' | 'SUPERSEDED';
export type ProductClaimStatus = 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';
export type NetQuantityUnit = 'MILLILITER' | 'GRAM';

export type CatalogSourceKind =
  | 'MANUFACTURER'
  | 'REGULATOR'
  | 'CONTROLLED_IMPORT'
  | 'USER_OBSERVATION'
  | 'ADMIN';

export type CatalogRightsStatus = 'ALLOWED' | 'UNKNOWN' | 'RESTRICTED';

export type ProductClaimKind =
  | 'VOLUME'
  | 'LENGTH'
  | 'SEPARATION'
  | 'NATURAL_LOOK'
  | 'WATERPROOF'
  | 'EASY_REMOVAL'
  | 'OTHER';

export interface CatalogProvenanceInput {
  sourceKind: CatalogSourceKind;
  sourceLabel: string;
  sourceUri: string | null;
  sourceRecordId: string | null;
  observedAt: Date | null;
  rightsStatus: CatalogRightsStatus;
}

export interface ProductFamily {
  productFamilyId: ProductFamilyId;
  category: ProductCategory;
  brandName: string;
  name: string;
  status: CatalogStatus;
  provenanceId: CatalogProvenanceId;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductVariant {
  productVariantId: ProductVariantId;
  productFamilyId: ProductFamilyId;
  name: string;
  shadeName: string | null;
  netQuantityValue: string | null;
  netQuantityUnit: NetQuantityUnit | null;
  waterproof: boolean | null;
  status: CatalogStatus;
  provenanceId: CatalogProvenanceId;
  createdAt: Date;
  updatedAt: Date;
}

export interface FormulaRevision {
  formulaRevisionId: FormulaRevisionId;
  productVariantId: ProductVariantId;
  revisionNumber: number;
  inciText: string;
  status: FormulaRevisionStatus;
  provenanceId: CatalogProvenanceId;
  createdAt: Date;
  supersededAt: Date | null;
}

export interface ProductClaim {
  productClaimId: ProductClaimId;
  productVariantId: ProductVariantId;
  formulaRevisionId: FormulaRevisionId | null;
  kind: ProductClaimKind;
  text: string;
  status: ProductClaimStatus;
  provenanceId: CatalogProvenanceId;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublishedCatalogSource {
  sourceKind: CatalogSourceKind;
  sourceLabel: string;
  sourceUri: string | null;
  observedAt: Date | null;
  importedAt: Date;
}

export interface PublishedCatalogFormula {
  formulaRevisionId: FormulaRevisionId;
  revisionNumber: number;
  inciText: string;
  source: PublishedCatalogSource;
}

export interface PublishedCatalogClaim {
  productClaimId: ProductClaimId;
  kind: ProductClaimKind;
  text: string;
  source: PublishedCatalogSource;
}

export interface PublishedCatalogVariant {
  productVariantId: ProductVariantId;
  productFamilyId: ProductFamilyId;
  category: ProductCategory;
  brandName: string;
  familyName: string;
  variantName: string;
  shadeName: string | null;
  netQuantityValue: string | null;
  netQuantityUnit: NetQuantityUnit | null;
  waterproof: boolean | null;
  formula: PublishedCatalogFormula | null;
  claims: PublishedCatalogClaim[];
  identitySources: {
    family: PublishedCatalogSource;
    variant: PublishedCatalogSource;
    barcode: PublishedCatalogSource;
  };
}

export interface CreateProductFamilyInput {
  category: ProductCategory;
  brandName: string;
  name: string;
}

export interface CreateProductVariantInput {
  productFamilyId: ProductFamilyId;
  name: string;
  shadeName: string | null;
  netQuantityValue: string | null;
  netQuantityUnit: NetQuantityUnit | null;
  waterproof: boolean | null;
}

export type CreateProductVariantResult =
  | { kind: 'CREATED'; variant: ProductVariant }
  | { kind: 'FAMILY_NOT_FOUND' }
  | { kind: 'FAMILY_NOT_EDITABLE' };

export type AttachProductBarcodeResult =
  | {
      kind: 'ATTACHED' | 'ALREADY_ATTACHED';
      productVariantId: ProductVariantId;
      gtin: NormalizedGtin;
    }
  | {
      kind: 'GTIN_CONFLICT';
      productVariantId: ProductVariantId;
      existingProductVariantId: ProductVariantId;
      gtin: NormalizedGtin;
    }
  | { kind: 'VARIANT_NOT_FOUND' | 'VARIANT_NOT_EDITABLE' };

export type CreateFormulaRevisionResult =
  | { kind: 'CREATED' | 'UNCHANGED'; revision: FormulaRevision }
  | { kind: 'VARIANT_NOT_FOUND' | 'VARIANT_NOT_EDITABLE' };

export interface CreateProductClaimInput {
  productVariantId: ProductVariantId;
  formulaRevisionId: FormulaRevisionId | null;
  kind: ProductClaimKind;
  text: string;
}

export type CreateProductClaimResult =
  | { kind: 'CREATED'; claim: ProductClaim }
  | { kind: 'VARIANT_NOT_FOUND' | 'VARIANT_NOT_EDITABLE' }
  | { kind: 'FORMULA_REVISION_NOT_FOUND' };

export type CatalogStatusTransitionResult =
  | { kind: 'UPDATED' | 'UNCHANGED'; status: CatalogStatus }
  | {
      kind:
        | 'NOT_FOUND'
        | 'INVALID_TRANSITION'
        | 'PROVENANCE_NOT_ALLOWED'
        | 'PARENT_NOT_PUBLISHED'
        | 'ACTIVE_VARIANTS_EXIST';
    };

export function canTransitionCatalogStatus(
  current: CatalogStatus,
  target: CatalogStatus,
): boolean {
  if (current === 'DRAFT') {
    return target === 'PUBLISHED' || target === 'ARCHIVED';
  }
  return current === 'PUBLISHED' && target === 'ARCHIVED';
}

export interface CatalogRepository {
  findPublishedVariantByGtin(
    gtin14: Gtin14,
  ): Promise<PublishedCatalogVariant | null>;
  createFamily(
    input: CreateProductFamilyInput,
    provenance: CatalogProvenanceInput,
  ): Promise<ProductFamily>;
  createVariant(
    input: CreateProductVariantInput,
    provenance: CatalogProvenanceInput,
  ): Promise<CreateProductVariantResult>;
  attachBarcode(
    productVariantId: ProductVariantId,
    gtin: NormalizedGtin,
    provenance: CatalogProvenanceInput,
  ): Promise<AttachProductBarcodeResult>;
  createFormulaRevision(
    productVariantId: ProductVariantId,
    inciText: string,
    provenance: CatalogProvenanceInput,
  ): Promise<CreateFormulaRevisionResult>;
  createClaim(
    input: CreateProductClaimInput,
    provenance: CatalogProvenanceInput,
  ): Promise<CreateProductClaimResult>;
  transitionFamilyStatus(
    productFamilyId: ProductFamilyId,
    target: CatalogStatus,
  ): Promise<CatalogStatusTransitionResult>;
  transitionVariantStatus(
    productVariantId: ProductVariantId,
    target: CatalogStatus,
  ): Promise<CatalogStatusTransitionResult>;
}
