import { createHash } from 'node:crypto';

import {
  CatalogSeedManifestEnvelopeSchema,
  CatalogSeedProductSchema,
  type CatalogSeedManifestEnvelope,
  type CatalogSeedProduct,
} from '@wtm/contracts';
import {
  normalizeGtin,
  type CatalogImportCandidate,
  type CatalogImportInput,
  type CatalogImportQuarantineCode,
  type CatalogImportQuarantineRow,
} from '@wtm/domain';
import { Value } from 'typebox/value';

export class CatalogSeedValidationError extends Error {
  constructor(public readonly code: 'INVALID_JSON' | 'INVALID_MANIFEST') {
    super(
      code === 'INVALID_JSON'
        ? 'Seed is not valid JSON'
        : 'Seed manifest is invalid',
    );
    this.name = 'CatalogSeedValidationError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rowSha256(value: unknown): string {
  return sha256(JSON.stringify(value) ?? 'null');
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function safeString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizedText(value);
  if (normalized.length === 0 || normalized.length > maximumLength) return null;
  return normalized;
}

function rowIdentity(value: unknown): {
  sourceRecordId: string | null;
  gtin: string | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { sourceRecordId: null, gtin: null };
  }
  const row = value as Record<string, unknown>;
  return {
    sourceRecordId: safeString(row.sourceRecordId, 500),
    gtin: safeString(row.gtin, 100),
  };
}

function quarantinedRow(
  rowNumber: number,
  value: unknown,
  code: CatalogImportQuarantineCode,
): CatalogImportQuarantineRow {
  const identity = rowIdentity(value);
  return {
    rowNumber,
    sourceRecordId: identity.sourceRecordId,
    gtin: identity.gtin,
    rowSha256: rowSha256(value),
    code,
  };
}

function normalizedCandidate(
  rowNumber: number,
  raw: unknown,
  product: CatalogSeedProduct,
): CatalogImportCandidate | CatalogImportQuarantineRow {
  const sourceRecordId = normalizedText(product.sourceRecordId);
  const brandName = normalizedText(product.brandName);
  const familyName = normalizedText(product.familyName);
  const variantName = normalizedText(product.variantName);
  const shadeName =
    product.shadeName === null ? null : normalizedText(product.shadeName);
  if (
    sourceRecordId.length === 0 ||
    brandName.length === 0 ||
    familyName.length === 0 ||
    variantName.length === 0 ||
    shadeName === ''
  ) {
    return quarantinedRow(rowNumber, raw, 'INVALID_ROW');
  }

  const gtin = normalizeGtin(product.gtin);
  if (gtin.kind === 'INVALID') {
    return quarantinedRow(rowNumber, raw, 'INVALID_GTIN');
  }
  const quantityValue = product.netQuantity?.value ?? null;
  if (
    quantityValue !== null &&
    (Number(quantityValue) <= 0 || Number(quantityValue) > 99_999_999.9999)
  ) {
    return quarantinedRow(rowNumber, raw, 'INVALID_ROW');
  }

  return {
    rowNumber,
    sourceRecordId,
    rowSha256: rowSha256(raw),
    gtin: gtin.gtin,
    brandName,
    familyName,
    variantName,
    shadeName,
    netQuantityValue: quantityValue,
    netQuantityUnit: product.netQuantity?.unit ?? null,
    isWaterproof: product.isWaterproof,
  };
}

function duplicateRows(
  candidates: CatalogImportCandidate[],
  key: (candidate: CatalogImportCandidate) => string,
): Set<number> {
  const groups = new Map<string, number[]>();
  for (const candidate of candidates) {
    const value = key(candidate);
    const rows = groups.get(value) ?? [];
    rows.push(candidate.rowNumber);
    groups.set(value, rows);
  }
  return new Set(
    [...groups.values()]
      .filter((rows) => rows.length > 1)
      .flatMap((rows) => rows),
  );
}

export function prepareCatalogImport(rawManifest: string): CatalogImportInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest) as unknown;
  } catch {
    throw new CatalogSeedValidationError('INVALID_JSON');
  }
  if (!Value.Check(CatalogSeedManifestEnvelopeSchema, parsed)) {
    throw new CatalogSeedValidationError('INVALID_MANIFEST');
  }
  const envelope = parsed as CatalogSeedManifestEnvelope;
  const preliminary: CatalogImportCandidate[] = [];
  const quarantinedRows: CatalogImportQuarantineRow[] = [];

  envelope.products.forEach((raw, index) => {
    const rowNumber = index + 1;
    if (!Value.Check(CatalogSeedProductSchema, raw)) {
      quarantinedRows.push(quarantinedRow(rowNumber, raw, 'INVALID_ROW'));
      return;
    }
    const candidate = normalizedCandidate(
      rowNumber,
      raw,
      raw as CatalogSeedProduct,
    );
    if ('code' in candidate) quarantinedRows.push(candidate);
    else preliminary.push(candidate);
  });

  const duplicateSourceRows = duplicateRows(
    preliminary,
    ({ sourceRecordId }) => sourceRecordId,
  );
  const duplicateGtinRows = duplicateRows(
    preliminary,
    ({ gtin }) => gtin.gtin14,
  );
  const candidates: CatalogImportCandidate[] = [];
  for (const candidate of preliminary) {
    const duplicateCode = duplicateSourceRows.has(candidate.rowNumber)
      ? 'DUPLICATE_SOURCE_RECORD_ID'
      : duplicateGtinRows.has(candidate.rowNumber)
        ? 'DUPLICATE_GTIN'
        : null;
    if (duplicateCode === null) {
      candidates.push(candidate);
    } else {
      quarantinedRows.push({
        rowNumber: candidate.rowNumber,
        sourceRecordId: candidate.sourceRecordId,
        gtin: candidate.gtin.value,
        rowSha256: candidate.rowSha256,
        code: duplicateCode,
      });
    }
  }

  const retrievedAt = new Date(envelope.source.retrievedAt);
  if (Number.isNaN(retrievedAt.getTime())) {
    throw new CatalogSeedValidationError('INVALID_MANIFEST');
  }
  const sourceLabel = normalizedText(envelope.source.label);
  const licenseName = normalizedText(envelope.source.licenseName);
  const attribution = normalizedText(envelope.source.attribution);
  if (
    sourceLabel.length === 0 ||
    licenseName.length === 0 ||
    attribution.length === 0
  ) {
    throw new CatalogSeedValidationError('INVALID_MANIFEST');
  }

  return {
    importKey: `${envelope.datasetId}@${envelope.datasetVersion}`,
    datasetId: envelope.datasetId,
    datasetVersion: envelope.datasetVersion,
    manifestSha256: sha256(rawManifest),
    source: {
      label: sourceLabel,
      uri: envelope.source.uri,
      licenseName,
      licenseUri: envelope.source.licenseUri,
      attribution,
      rightsStatus: envelope.source.rightsStatus,
      retrievedAt,
    },
    totalRows: envelope.products.length,
    candidates,
    quarantinedRows: quarantinedRows.toSorted(
      (left, right) => left.rowNumber - right.rowNumber,
    ),
  };
}
