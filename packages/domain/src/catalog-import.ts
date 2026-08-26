import type {
  CatalogRightsStatus,
  NetQuantityUnit,
  ProductFamilyId,
  ProductVariantId,
} from './catalog.js';
import type { NormalizedGtin } from './gtin.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export type CatalogImportBatchId = TaggedString<'CatalogImportBatchId'>;

export type CatalogImportOperation = 'DRY_RUN' | 'PUBLISH' | 'ROLLBACK';
export type CatalogImportResultKind =
  | 'READY'
  | 'PUBLISHED'
  | 'ALREADY_PUBLISHED'
  | 'QUARANTINED'
  | 'ALREADY_QUARANTINED'
  | 'ROLLED_BACK'
  | 'ALREADY_ROLLED_BACK'
  | 'VERSION_CONFLICT'
  | 'NOT_FOUND'
  | 'ROLLBACK_CONFLICT';

export type CatalogImportQuarantineCode =
  | 'INVALID_ROW'
  | 'INVALID_GTIN'
  | 'DUPLICATE_SOURCE_RECORD_ID'
  | 'DUPLICATE_GTIN'
  | 'RIGHTS_NOT_ALLOWED'
  | 'GTIN_CONFLICT';

export interface CatalogImportSource {
  label: string;
  uri: string;
  licenseName: string;
  licenseUri: string;
  attribution: string;
  rightsStatus: CatalogRightsStatus;
  retrievedAt: Date;
}

export interface CatalogImportCandidate {
  rowNumber: number;
  sourceRecordId: string;
  rowSha256: string;
  gtin: NormalizedGtin;
  brandName: string;
  familyName: string;
  variantName: string;
  shadeName: string | null;
  netQuantityValue: string | null;
  netQuantityUnit: NetQuantityUnit | null;
  isWaterproof: boolean | null;
}

export interface CatalogImportQuarantineRow {
  rowNumber: number;
  sourceRecordId: string | null;
  gtin: string | null;
  rowSha256: string;
  code: CatalogImportQuarantineCode;
}

export interface CatalogImportInput {
  importKey: string;
  datasetId: string;
  datasetVersion: string;
  manifestSha256: string;
  source: CatalogImportSource;
  totalRows: number;
  candidates: CatalogImportCandidate[];
  quarantinedRows: CatalogImportQuarantineRow[];
}

export interface CatalogImportCounts {
  total: number;
  ready: number;
  published: number;
  quarantined: number;
  conflicts: number;
  rolledBack: number;
}

export interface CatalogImportReport {
  schemaVersion: 1;
  operation: CatalogImportOperation;
  kind: CatalogImportResultKind;
  importKey: string;
  manifestSha256: string | null;
  counts: CatalogImportCounts;
  quarantine: CatalogImportQuarantineRow[];
}

export interface PublishedCatalogImportItem {
  rowNumber: number;
  productFamilyId: ProductFamilyId;
  productVariantId: ProductVariantId;
}

export interface CatalogImportRepository {
  preview(input: CatalogImportInput): Promise<CatalogImportReport>;
  publish(input: CatalogImportInput): Promise<CatalogImportReport>;
  rollback(importKey: string): Promise<CatalogImportReport>;
}
