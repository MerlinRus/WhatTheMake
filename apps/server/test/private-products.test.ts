import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from 'typebox/value';

import {
  PrivateProductSnapshotSchema,
  type CreatePrivateProductSnapshotInput as ContractInput,
} from '@wtm/contracts';
import type {
  AuthenticatedIdentity,
  CreatePrivateProductSnapshotInput,
  CreatePrivateProductSnapshotResult,
  PrivateProductRepository,
  PrivateProductSnapshot,
} from '@wtm/domain';

import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import { createPrivateProductService } from '../src/private-products/service.js';
import { registerPrivateProductRoutes } from '../src/routes/private-products.js';

const token = 'a'.repeat(43);
const owner: AuthenticatedIdentity = {
  kind: 'GUEST',
  guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
};
const observationId = '11111111-1111-4111-8111-111111111111';
const snapshotId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const input: ContractInput = {
  category: 'MASCARA',
  identityConfirmed: true,
  identity: {
    brandName: '  Test   Brand  ',
    familyName: 'Mascara',
    variantName: 'Black',
    shadeName: null,
    netQuantity: { value: '08.500', unit: 'MILLILITER' },
    isWaterproof: null,
  },
  revisionId,
  claimKinds: ['LENGTH'],
  priceKopecks: 59900,
};
const snapshot = {
  snapshotId,
  observationId,
  snapshotNumber: 1,
  category: 'MASCARA',
  barcode: {
    value: '4006381333931',
    format: 'EAN_13',
    gtin14: '04006381333931',
  },
  identity: {
    brandName: 'Test Brand',
    familyName: 'Mascara',
    variantName: 'Black',
    shadeName: null,
    netQuantityValue: '8.5',
    netQuantityUnit: 'MILLILITER',
    waterproof: null,
  },
  identitySource: 'USER_CONFIRMED_PACKAGING',
  revision: {
    revisionId,
    revisionNumber: 1,
    source: { kind: 'USER_TRANSCRIPTION' },
    sourceText: 'Aqua',
    sourceSha256: 'f'.repeat(64),
    authorKind: 'GUEST',
    createdAt: owner.createdAt,
  },
  formulaComplete: false,
  claimKinds: ['LENGTH'],
  claimsSource: 'USER_CONFIRMED_PACKAGING',
  priceKopecks: 59900,
  priceSource: 'USER_ENTERED',
  createdAt: owner.createdAt,
} as PrivateProductSnapshot;

function fixture() {
  const calls: CreatePrivateProductSnapshotInput[] = [];
  let result: CreatePrivateProductSnapshotResult = {
    kind: 'CREATED',
    snapshot,
  };
  let visible = true;
  const repository: PrivateProductRepository = {
    async createSnapshot(value) {
      calls.push(value);
      return result;
    },
    async findOwned(id, current) {
      assert.equal(current, owner);
      return visible && id === snapshotId ? snapshot : null;
    },
    async listOwned(current, limit) {
      assert.equal(current, owner);
      assert.ok(limit === undefined || limit === 5);
      return visible ? [snapshot] : [];
    },
  };
  const service = createPrivateProductService({
    identity: {
      async current(value) {
        return value === token ? owner : null;
      },
    },
    repository,
  });
  return {
    service,
    calls,
    setResult(value: CreatePrivateProductSnapshotResult) {
      result = value;
    },
    hide() {
      visible = false;
    },
  };
}

test('private packaging cannot relabel a primer or brow product as mascara', async () => {
  const f = fixture();
  for (const familyName of ['Lash Paradise Mascara Primer', 'Brow Mascara']) {
    await assert.rejects(
      f.service.create(token, observationId, {
        ...input,
        identity: { ...input.identity, familyName },
      }),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
  }
  assert.equal(f.calls.length, 0);
});

test('contradictory waterproof fields cannot enter a private snapshot', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.create(token, observationId, {
      ...input,
      identity: { ...input.identity, isWaterproof: false },
      claimKinds: ['WATERPROOF'],
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
  assert.equal(f.calls.length, 0);
});

test('private product service normalizes identity, defaults incomplete and serializes provenance', async () => {
  const f = fixture();
  const result = await f.service.create(token, observationId, input);
  assert.equal(result.resultKind, 'CREATED');
  assert.equal(f.calls[0]?.owner, owner);
  assert.equal(f.calls[0]?.identity.brandName, 'Test Brand');
  assert.equal(f.calls[0]?.identity.netQuantityValue, '8.5');
  assert.equal(f.calls[0]?.formulaComplete, false);
  assert.equal(
    Value.Check(PrivateProductSnapshotSchema, result.snapshot),
    true,
  );
  assert.equal(result.snapshot.createdAt, owner.createdAt.toISOString());
  assert.equal(result.snapshot.revision.sourceSha256, 'f'.repeat(64));
  assert.equal(
    result.snapshot.revision.createdAt,
    owner.createdAt.toISOString(),
  );
  assert.equal(result.snapshot.claimsSource, 'USER_CONFIRMED_PACKAGING');
  assert.equal(result.snapshot.priceSource, 'USER_ENTERED');
  assert.deepEqual(result.snapshot.identity.netQuantity, {
    value: '8.5',
    unit: 'MILLILITER',
  });
  f.setResult({ kind: 'REUSED', snapshot });
  assert.equal(
    (
      await f.service.create(token, observationId, {
        ...input,
        formulaComplete: true,
      })
    ).resultKind,
    'REUSED',
  );
  assert.equal(f.calls[1]?.formulaComplete, true);
});

test('private product service requires identity and hides missing or foreign resources uniformly', async () => {
  const f = fixture();
  for (const operation of [
    () => f.service.create(null, observationId, input),
    () => f.service.get(null, snapshotId),
    () => f.service.list(null),
  ]) {
    await assert.rejects(
      operation,
      (error: unknown) => error instanceof AppError && error.statusCode === 401,
    );
  }
  assert.equal(f.calls.length, 0);
  for (const kind of ['OBSERVATION_NOT_FOUND', 'REVISION_NOT_FOUND'] as const) {
    f.setResult({ kind });
    await assert.rejects(
      () => f.service.create(token, observationId, input),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 404 &&
        error.message === 'Private product not found' &&
        error.details === undefined,
    );
  }
  f.setResult({ kind: 'LIMIT_REACHED' });
  await assert.rejects(
    () => f.service.create(token, observationId, input),
    (error: unknown) => error instanceof AppError && error.statusCode === 409,
  );
  await assert.rejects(
    () =>
      f.service.create(token, observationId, {
        ...input,
        identity: { ...input.identity, brandName: '   ' },
      }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
  assert.equal((await f.service.list(token, 5)).snapshots.length, 1);
  f.hide();
  assert.deepEqual(await f.service.list(token), { snapshots: [] });
  await assert.rejects(
    () => f.service.get(token, snapshotId),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});

test('private product routes protect writes and serialize private responses with no-store', async () => {
  const f = fixture();
  const app = await buildApp();
  await registerPrivateProductRoutes(app, {
    service: f.service,
    publicOrigin: 'https://whatthemake.test',
    cookieName: 'wtm_session',
  });
  const headers = {
    origin: 'https://whatthemake.test',
    cookie: `wtm_session=${token}`,
  };
  const url = `/api/v1/product-observations/${observationId}/private-snapshots`;
  try {
    const created = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: input,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.headers['cache-control'], 'private, no-store');
    assert.equal(created.json().snapshot.identity.netQuantity.value, '8.5');
    f.setResult({ kind: 'REUSED', snapshot });
    assert.equal(
      (await app.inject({ method: 'POST', url, headers, payload: input }))
        .statusCode,
      200,
    );
    for (const options of [
      {
        headers: { ...headers, origin: 'https://other.test' },
        payload: input,
        status: 403,
      },
      { headers: { origin: headers.origin }, payload: input, status: 401 },
      { headers, payload: { ...input, identityConfirmed: false }, status: 400 },
      { headers, payload: { ...input, category: 'LIPSTICK' }, status: 400 },
      { headers, payload: { ...input, priceKopecks: 1.5 }, status: 400 },
      {
        headers,
        payload: { ...input, priceKopecks: 100_000_001 },
        status: 400,
      },
      {
        headers,
        payload: { ...input, claimKinds: ['LENGTH', 'LENGTH'] },
        status: 400,
      },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: options.headers,
        payload: options.payload,
      });
      assert.equal(response.statusCode, options.status, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'text/plain' },
          payload: JSON.stringify(input),
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/private-products?limit=5', headers }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/private-products?limit=31', headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/private-products',
          headers: { cookie: 'wtm_session=invalid' },
        })
      ).statusCode,
      401,
    );
    const found = await app.inject({
      url: `/api/v1/private-products/${snapshotId}`,
      headers,
    });
    assert.equal(found.statusCode, 200);
    assert.equal(found.headers['cache-control'], 'private, no-store');
    f.hide();
    const missing = await app.inject({
      url: `/api/v1/private-products/${snapshotId}`,
      headers,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.headers['cache-control'], 'private, no-store');
  } finally {
    await app.close();
  }
});

test('private snapshot creation has a bounded HTTP rate limit', async () => {
  const f = fixture();
  const app = await buildApp();
  await registerPrivateProductRoutes(app, {
    service: f.service,
    publicOrigin: 'https://whatthemake.test',
    cookieName: 'wtm_session',
  });
  try {
    for (let index = 0; index < 51; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/product-observations/${observationId}/private-snapshots`,
        headers: {
          origin: 'https://whatthemake.test',
          cookie: `wtm_session=${token}`,
        },
        payload: input,
      });
      assert.equal(response.statusCode, index < 50 ? 201 : 429, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
    }
    assert.equal(f.calls.length, 50);
  } finally {
    await app.close();
  }
});
