import assert from 'node:assert/strict';
import test from 'node:test';

import { Value } from 'typebox/value';

import {
  ApiErrorEnvelopeSchema,
  CatalogBarcodeParamsSchema,
  CatalogVariantResponseSchema,
  CursorPageInfoSchema,
  CursorQuerySchema,
  LoginInputSchema,
  MascaraBriefInputSchema,
  MascaraBriefResponseSchema,
  MediaAssetParamsSchema,
  MediaCollectionResponseSchema,
  ProductObservationResponseSchema,
  ReadyResponseSchema,
  SessionResponseSchema,
} from '../src/index.js';

test('API error envelope accepts stable error shape', () => {
  assert.equal(
    Value.Check(ApiErrorEnvelopeSchema, {
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found',
        requestId: 'request-1',
      },
    }),
    true,
  );
});

test('catalog lookup contract keeps exact variant and public provenance', () => {
  const source = {
    sourceKind: 'MANUFACTURER',
    sourceLabel: 'Official catalog',
    sourceUrl: 'https://manufacturer.example/catalog',
    observedAt: '2026-08-26T08:00:00.000Z',
    importedAt: '2026-08-26T08:01:00.000Z',
  };
  const response = {
    variant: {
      schemaVersion: 1,
      identification: { method: 'GTIN', confidence: 'EXACT' },
      barcode: {
        value: '4006381333931',
        format: 'EAN_13',
        gtin14: '04006381333931',
      },
      productVariantId: 'b0f9bf8f-c1d6-4803-8899-73ca3359eae2',
      productFamilyId: 'c85f8055-d0b2-4a06-8a6d-306f3c81ed1e',
      category: 'MASCARA',
      brandName: 'Example Beauty',
      familyName: 'Decision Mascara',
      variantName: 'Black / 10 ml',
      shadeName: 'Black',
      netQuantity: { value: '10.0000', unit: 'MILLILITER' },
      isWaterproof: false,
      formula: {
        formulaRevisionId: 'f4dcb2df-eb59-4568-9330-ad2e24499f42',
        revisionNumber: 1,
        inciText: 'AQUA, WAX',
        source,
      },
      claims: [
        {
          productClaimId: 'd2a03d59-4f2f-49a0-b718-ae491cc67b97',
          kind: 'VOLUME',
          text: 'Visible volume',
          source,
        },
      ],
      identitySources: { family: source, variant: source, barcode: source },
    },
  };

  assert.equal(Value.Check(CatalogVariantResponseSchema, response), true);
  assert.equal(
    Value.Check(CatalogVariantResponseSchema, {
      variant: { ...response.variant, rightsStatus: 'ALLOWED' },
    }),
    false,
  );
  assert.equal(
    Value.Check(CatalogBarcodeParamsSchema, { gtin: '4006381333931' }),
    true,
  );
  assert.equal(
    Value.Check(CatalogBarcodeParamsSchema, { gtin: '4006381333931\n' }),
    false,
  );
});

test('API error envelope rejects unknown error codes and fields', () => {
  assert.equal(
    Value.Check(ApiErrorEnvelopeSchema, {
      error: {
        code: 'SOMETHING_RANDOM',
        message: 'No',
        requestId: 'request-1',
        internalStack: 'must not leak',
      },
    }),
    false,
  );
});

test('cursor query enforces server page-size limits', () => {
  assert.equal(Value.Check(CursorQuerySchema, { pageSize: 100 }), true);
  assert.equal(Value.Check(CursorQuerySchema, { pageSize: 101 }), false);
  assert.equal(Value.Check(CursorQuerySchema, { pageSize: 0 }), false);
});

test('cursor page info distinguishes an exhausted page', () => {
  assert.equal(
    Value.Check(CursorPageInfoSchema, { nextCursor: null, hasNextPage: false }),
    true,
  );
});

test('readiness contract requires database status and version', () => {
  assert.equal(
    Value.Check(ReadyResponseSchema, {
      status: 'UP',
      now: '2026-08-25T17:00:00.000Z',
      version: { name: 'what-the-make', version: '0.1.0', buildSha: 'dev' },
      checks: { database: { status: 'UP', latencyMs: 1.2 } },
    }),
    true,
  );
});

test('identity input enforces password bounds and rejects extra fields', () => {
  assert.equal(
    Value.Check(LoginInputSchema, {
      email: 'buyer@example.ru',
      password: 'correct horse battery staple',
    }),
    true,
  );
  assert.equal(
    Value.Check(LoginInputSchema, {
      email: 'buyer@example.ru',
      password: 'too-short',
    }),
    false,
  );
  assert.equal(
    Value.Check(LoginInputSchema, {
      email: 'buyer@example.ru',
      password: 'correct horse battery staple',
      role: 'ADMIN',
    }),
    false,
  );
});

test('session response never contains a capability token', () => {
  assert.equal(
    Value.Check(SessionResponseSchema, {
      principal: {
        kind: 'GUEST',
        guestId: '31a8a00f-a3a0-4ac8-abf1-5852b9ecab71',
        createdAt: '2026-08-26T07:00:00.000Z',
      },
    }),
    true,
  );
  assert.equal(
    Value.Check(SessionResponseSchema, {
      principal: {
        kind: 'GUEST',
        guestId: '31a8a00f-a3a0-4ac8-abf1-5852b9ecab71',
        createdAt: '2026-08-26T07:00:00.000Z',
        token: 'must-not-leak',
      },
    }),
    false,
  );
});

test('mascara brief contract separates personalized and unknown-goals modes', () => {
  const shared = {
    waterproof: 'NO_PREFERENCE',
    removal: 'EASY_REQUIRED',
    sensitiveEyes: true,
    contactLenses: false,
    avoidedIngredients: ['PARAFFIN'],
  };
  assert.equal(
    Value.Check(MascaraBriefInputSchema, {
      ...shared,
      mode: 'PERSONALIZED',
      goals: ['VOLUME', 'SEPARATION'],
    }),
    true,
  );
  assert.equal(
    Value.Check(MascaraBriefInputSchema, {
      ...shared,
      mode: 'PERSONALIZED',
      goals: ['VOLUME', 'VOLUME'],
    }),
    false,
  );
  assert.equal(
    Value.Check(MascaraBriefInputSchema, {
      ...shared,
      mode: 'UNKNOWN_GOALS',
      goals: ['VOLUME'],
    }),
    false,
  );
});

test('mascara brief response is versioned and rejects hidden fields', () => {
  const response = {
    brief: {
      schemaVersion: 1,
      mode: 'UNKNOWN_GOALS',
      goals: [],
      waterproof: 'AVOID',
      removal: 'NO_PREFERENCE',
      sensitiveEyes: false,
      contactLenses: true,
      avoidedIngredients: [],
      source: 'EPHEMERAL',
      profileVersion: null,
      createdAt: '2026-08-26T07:00:00.000Z',
    },
  };
  assert.equal(Value.Check(MascaraBriefResponseSchema, response), true);
  assert.equal(
    Value.Check(MascaraBriefResponseSchema, {
      brief: { ...response.brief, profileVersion: 1 },
    }),
    false,
  );
  assert.equal(
    Value.Check(MascaraBriefResponseSchema, {
      brief: { ...response.brief, accountId: 'must-not-leak' },
    }),
    false,
  );
});

test('private media contract limits metadata and rejects path-like IDs', () => {
  const response = {
    collection: {
      collectionId: '2c194f26-e733-4c30-8e33-fc589be25099',
      assets: [
        {
          assetId: '79df91cc-f632-4ad2-9b81-d50d9dff8d53',
          role: 'INGREDIENTS',
          mediaType: 'image/jpeg',
          byteSize: 1024,
          createdAt: '2026-08-26T08:00:00.000Z',
        },
      ],
      createdAt: '2026-08-26T08:00:00.000Z',
    },
  };
  assert.equal(Value.Check(MediaCollectionResponseSchema, response), true);
  assert.equal(
    Value.Check(MediaCollectionResponseSchema, {
      collection: {
        ...response.collection,
        assets: [{ ...response.collection.assets[0], sha256: 'hidden' }],
      },
    }),
    false,
  );
  assert.equal(
    Value.Check(MediaAssetParamsSchema, { assetId: '../../etc/passwd' }),
    false,
  );
});

test('private product observation exposes barcode and role-scoped media only', () => {
  const response = {
    observation: {
      schemaVersion: 1,
      observationId: 'f85bf269-76ce-47f5-8b2a-312cb93c653b',
      barcode: {
        value: '5901234123457',
        format: 'EAN_13',
        gtin14: '05901234123457',
      },
      mediaCollection: {
        collectionId: '36463885-1770-4823-9298-85bca3d8eeb9',
        assets: [],
        createdAt: '2026-08-26T10:00:00.000Z',
      },
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:00:00.000Z',
    },
  };
  assert.equal(Value.Check(ProductObservationResponseSchema, response), true);
  assert.equal(
    Value.Check(ProductObservationResponseSchema, {
      observation: { ...response.observation, ownerKind: 'GUEST' },
    }),
    false,
  );
});
