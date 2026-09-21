import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from 'typebox/value';
import {
  PrivateComparisonResponseSchema,
  type PrivateComparisonInput,
  type CatalogVariantResponse,
} from '@wtm/contracts';
import type {
  AuthenticatedIdentity,
  InciDictionarySnapshot,
  PrivateProductSnapshot,
} from '@wtm/domain';
import { buildApp } from '../src/app.js';
import { createPrivateComparisonService } from '../src/comparison/private-service.js';
import { AppError } from '../src/errors.js';
import { registerPrivateComparisonRoutes } from '../src/routes/private-comparisons.js';

const token = 'a'.repeat(43);
const now = new Date('2026-09-20T00:00:00.000Z');
const owner: AuthenticatedIdentity = {
  kind: 'GUEST',
  guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: now,
};
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
function snapshot(id: string, gtin: string): PrivateProductSnapshot {
  return {
    snapshotId: id,
    observationId: '33333333-3333-4333-8333-333333333333',
    snapshotNumber: 1,
    category: 'MASCARA',
    barcode: { value: gtin, format: 'EAN_13', gtin14: gtin.padStart(14, '0') },
    identity: {
      brandName: 'Private Brand',
      familyName: 'Mascara',
      variantName: 'Black',
      shadeName: null,
      netQuantityValue: null,
      netQuantityUnit: null,
      waterproof: false,
    },
    identitySource: 'USER_CONFIRMED_PACKAGING',
    revision: {
      revisionId: '44444444-4444-4444-8444-444444444444',
      revisionNumber: 1,
      source: { kind: 'USER_TRANSCRIPTION' },
      sourceText: 'Aqua',
      sourceSha256: 'f'.repeat(64),
      authorKind: 'GUEST',
      createdAt: now,
    },
    formulaComplete: false,
    claimKinds: [],
    claimsSource: 'USER_CONFIRMED_PACKAGING',
    priceKopecks: null,
    priceSource: null,
    createdAt: now,
  } as PrivateProductSnapshot;
}
const dictionary = {
  dictionaryVersion: 'test-v1',
  normalizerVersion: 'inci-lookup-v1',
  ingredients: [
    {
      ingredientId: 'aqua',
      canonicalName: 'Aqua',
      canonicalLookupKey: 'aqua',
      aliases: [],
    },
    {
      ingredientId: 'beeswax',
      canonicalName: 'Beeswax',
      canonicalLookupKey: 'beeswax',
      aliases: [],
    },
  ],
} as unknown as InciDictionarySnapshot;
const brief: PrivateComparisonInput['brief'] = {
  mode: 'UNKNOWN_GOALS',
  waterproof: 'NO_PREFERENCE',
  removal: 'NO_PREFERENCE',
  sensitiveEyes: false,
  contactLenses: false,
  avoidedIngredients: [],
};
const input: PrivateComparisonInput = {
  schemaVersion: 1,
  slots: [
    { kind: 'PRIVATE', snapshotId: firstId },
    { kind: 'PRIVATE', snapshotId: secondId },
  ],
  brief,
};

function fixture() {
  const snapshots = new Map<string, PrivateProductSnapshot>([
    [firstId, snapshot(firstId, '4006381333931')],
    [secondId, snapshot(secondId, '5901234123457')],
  ]);
  const catalogs = new Map<string, CatalogVariantResponse>();
  let reviewRequests: readonly string[] = [];
  let ownedCalls = 0;
  const service = createPrivateComparisonService({
    identity: {
      async current(value) {
        return value === token ? owner : null;
      },
    },
    privateProducts: {
      async findOwned(id, current) {
        assert.equal(current, owner);
        ownedCalls += 1;
        return snapshots.get(id) ?? null;
      },
    },
    catalog: {
      async byGtin(gtin) {
        const found = catalogs.get(gtin);
        if (found) return found;
        throw new AppError({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Not found',
        });
      },
    },
    reviews: {
      async findByProductVariantIds(ids) {
        reviewRequests = ids;
        return new Map();
      },
    },
    dictionary: {
      async findPublishedSnapshot() {
        return dictionary;
      },
    },
    now: () => now,
  });
  return {
    service,
    snapshots,
    catalogs,
    reviewRequests: () => reviewRequests,
    ownedCalls: () => ownedCalls,
  };
}

test('private comparison preserves personal identity and maps claims winner to slot, never catalog UUID', async () => {
  const f = fixture();
  f.snapshots.get(firstId)!.claimKinds = ['LENGTH'];
  const response = await f.service.preview(token, {
    ...input,
    brief: { ...brief, mode: 'PERSONALIZED', goals: ['LENGTH'] },
  });
  assert.equal(Value.Check(PrivateComparisonResponseSchema, response), true);
  assert.deepEqual(response.comparison.recommendation, {
    kind: 'PREFERRED',
    slotIndex: 0,
    framing: 'BETTER_FIT',
    confidence: 'MEDIUM',
    reasonCodes: ['GOAL_CLAIM_MATCH'],
  });
  assert.equal(response.comparison.slots[0]?.state, 'PRIVATE_READY');
  assert.deepEqual(f.reviewRequests(), []);
  const identity = response.comparison.criteria.find(
    (c) => c.kind === 'IDENTITY_AND_DATA',
  );
  assert.equal(
    identity?.observations[0]?.reasonCode,
    'USER_CONFIRMED_IDENTITY',
  );
  assert.ok(
    response.comparison.warnings.some((w) =>
      w.includes('не проверены независимо'),
    ),
  );
  assert.ok(
    !JSON.stringify(response.comparison.criteria).includes('productVariantId'),
  );
});

test('private comparison authenticates first and treats foreign/missing snapshots identically', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.service.preview(null, input),
    (error: unknown) => error instanceof AppError && error.statusCode === 401,
  );
  assert.equal(f.ownedCalls(), 0);
  f.snapshots.delete(secondId);
  await assert.rejects(
    () => f.service.preview(token, input),
    (error: unknown) =>
      error instanceof AppError &&
      error.statusCode === 404 &&
      error.message === 'Private product not found' &&
      error.details === undefined,
  );
});

test('private incomplete composition cannot prove absence or win by claims', async () => {
  const f = fixture();
  f.snapshots.get(firstId)!.claimKinds = ['LENGTH'];
  f.snapshots.get(secondId)!.formulaComplete = true;
  const result = await f.service.preview(token, {
    ...input,
    brief: {
      ...brief,
      mode: 'PERSONALIZED',
      goals: ['LENGTH'],
      avoidedIngredients: ['Beeswax'],
    },
  });
  assert.equal(result.comparison.recommendation.kind, 'NO_CLEAR_WINNER');
  assert.ok(
    result.comparison.recommendation.reasonCodes.includes(
      'HARD_CONSTRAINT_DATA_MISSING',
    ),
  );
  const hard = result.comparison.criteria.find(
    (c) => c.kind === 'HARD_CONSTRAINTS',
  );
  assert.equal(hard?.observations[0]?.outcome, 'NO_DATA');
});

test('private comparison blocks duplicate GTIN across snapshots and missing catalog slots', async () => {
  const f = fixture();
  f.snapshots.get(secondId)!.barcode = f.snapshots.get(firstId)!.barcode;
  const duplicate = await f.service.preview(token, input);
  assert.deepEqual(duplicate.comparison.slots[1], {
    state: 'UNAVAILABLE',
    slotIndex: 1,
    reason: 'DUPLICATE_VARIANT',
  });
  assert.equal(duplicate.comparison.recommendation.kind, 'NO_CLEAR_WINNER');
  const missing = await f.service.preview(token, {
    ...input,
    slots: [
      ...input.slots.slice(0, 1),
      { kind: 'CATALOG', gtin: '9999999999994' },
    ],
  });
  assert.deepEqual(missing.comparison.slots[1], {
    state: 'UNAVAILABLE',
    slotIndex: 1,
    reason: 'NOT_FOUND',
  });
  assert.equal(missing.comparison.recommendation.kind, 'NO_CLEAR_WINNER');
});

test('mixed comparison deduplicates published variant against personal GTIN and has no invented review', async () => {
  const f = fixture();
  const source = {
    sourceKind: 'MANUFACTURER' as const,
    sourceLabel: 'Test source',
    sourceUrl: 'https://example.test/product',
    observedAt: now.toISOString(),
    importedAt: now.toISOString(),
  };
  f.catalogs.set('4006381333931', {
    variant: {
      schemaVersion: 1,
      identification: { method: 'GTIN', confidence: 'EXACT' },
      barcode: {
        value: '4006381333931',
        gtin14: '04006381333931',
        format: 'EAN_13',
      },
      productVariantId: '55555555-5555-4555-8555-555555555555',
      productFamilyId: '66666666-6666-4666-8666-666666666666',
      category: 'MASCARA',
      brandName: 'Catalog Brand',
      familyName: 'Mascara',
      variantName: 'Black',
      shadeName: null,
      netQuantity: null,
      isWaterproof: false,
      formula: null,
      claims: [],
      identitySources: { family: source, variant: source, barcode: source },
    },
  });
  const response = await f.service.preview(token, {
    ...input,
    slots: [
      { kind: 'PRIVATE', snapshotId: firstId },
      { kind: 'CATALOG', gtin: '4006381333931' },
    ],
  });
  assert.equal(Value.Check(PrivateComparisonResponseSchema, response), true);
  assert.deepEqual(response.comparison.slots[1], {
    state: 'UNAVAILABLE',
    slotIndex: 1,
    reason: 'DUPLICATE_VARIANT',
  });
  assert.equal(response.comparison.recommendation.kind, 'NO_CLEAR_WINNER');
  const distinct = await f.service.preview(token, {
    ...input,
    slots: [
      { kind: 'PRIVATE', snapshotId: secondId },
      { kind: 'CATALOG', gtin: '4006381333931' },
    ],
  });
  assert.equal(Value.Check(PrivateComparisonResponseSchema, distinct), true);
  assert.equal(distinct.comparison.recommendation.kind, 'NO_CLEAR_WINNER');
  assert.deepEqual(f.reviewRequests(), [
    '55555555-5555-4555-8555-555555555555',
  ]);
});

test('private comparison route enforces same-origin authentication, bounded slots and no-store', async () => {
  const f = fixture();
  const app = await buildApp();
  await registerPrivateComparisonRoutes(app, {
    service: f.service,
    publicOrigin: 'https://whatthemake.test',
    cookieName: 'wtm_session',
  });
  const url = '/api/v1/comparisons/private-preview';
  const headers = {
    origin: 'https://whatthemake.test',
    cookie: `wtm_session=${token}`,
  };
  try {
    for (const [requestHeaders, payload, status] of [
      [headers, input, 200],
      [{ ...headers, origin: 'https://foreign.test' }, input, 403],
      [{ origin: headers.origin }, input, 401],
      [headers, { ...input, slots: input.slots.slice(0, 1) }, 400],
      [headers, { ...input, slots: [...input.slots, ...input.slots] }, 400],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: requestHeaders,
        payload,
      });
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    f.snapshots.delete(secondId);
    const missing = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: input,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers['cache-control'], 'private, no-store');
    assert.ok(!missing.body.includes(secondId));
  } finally {
    await app.close();
  }
});
