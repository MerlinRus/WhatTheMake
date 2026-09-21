import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MediaStorageCapacityError,
  type MediaRepository,
  type MediaStorage,
} from '@wtm/domain';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import type { IdentityService } from '../src/identity/service.js';
import { createMediaService } from '../src/media/service.js';
import { registerMediaRoutes } from '../src/routes/media.js';

const collectionId = '79df91cc-f632-4ad2-9b81-d50d9dff8d53';
const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
function fixture(error: Error, journalFails = false) {
  let releases = 0;
  let deletes = 0;
  let commits = 0;
  const identity = {
    async current() {
      return { kind: 'GUEST', guestId: collectionId, createdAt: new Date() };
    },
  } as IdentityService;
  const repository = {
    async prepareAssetUpload() {
      return { kind: 'PREPARED' };
    },
    async completePreparedAssetUpload() {
      releases += 1;
      if (journalFails) throw new Error('Journal unavailable');
    },
    async commitAssetUpload() {
      commits += 1;
      throw new Error('Unexpected commit');
    },
  } as unknown as MediaRepository;
  const storage: MediaStorage = {
    async put() {
      throw error;
    },
    async read() {
      return bytes;
    },
    async delete() {
      deletes += 1;
    },
  };
  return {
    service: createMediaService({
      identity,
      repository,
      storage,
      maxBytes: 1024,
      recoveryDelayMs: 60_000,
    }),
    counts: () => ({ releases, deletes, commits }),
  };
}

test('capacity refusal releases only the safe unwritten reservation without deleting an object', async () => {
  for (const journalFails of [false, true]) {
    const f = fixture(new MediaStorageCapacityError(), journalFails);
    await assert.rejects(
      () =>
        f.service.upload('a'.repeat(43), {
          collectionId,
          role: 'INGREDIENTS',
          mediaType: 'image/jpeg',
          bytes,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 503);
        assert.deepEqual(error.details, {
          reason: 'MEDIA_STORAGE_CAPACITY',
          retryable: true,
        });
        return true;
      },
    );
    assert.deepEqual(f.counts(), { releases: 1, deletes: 0, commits: 0 });
  }
});

test('unknown storage failures preserve the recovery journal and never blindly delete', async () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EEXIST', 'EACCES']) {
    const f = fixture(
      Object.assign(new Error('Private disk detail'), { code }),
    );
    await assert.rejects(
      () =>
        f.service.upload('a'.repeat(43), {
          collectionId,
          role: 'INGREDIENTS',
          mediaType: 'image/jpeg',
          bytes,
        }),
      (error: unknown) =>
        error instanceof AppError &&
        error.statusCode === 503 &&
        !error.message.includes('Private disk'),
    );
    assert.deepEqual(f.counts(), { releases: 0, deletes: 0, commits: 0 });
  }
});

test('upload capacity API returns safe 503 envelope with no-store and retry guidance', async () => {
  const f = fixture(new MediaStorageCapacityError());
  const app = await buildApp();
  await registerMediaRoutes(app, {
    service: f.service,
    publicOrigin: 'https://whatthemake.test',
    cookieName: 'wtm_session',
    maxBytes: 1024,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/media-collections/${collectionId}/assets?role=INGREDIENTS`,
      headers: {
        origin: 'https://whatthemake.test',
        cookie: `wtm_session=${'a'.repeat(43)}`,
        'content-type': 'image/jpeg',
      },
      payload: Buffer.from(bytes),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '60');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.json().error.code, 'SERVICE_UNAVAILABLE');
    assert.deepEqual(response.json().error.details, {
      reason: 'MEDIA_STORAGE_CAPACITY',
      retryable: true,
    });
    assert.ok(!response.body.includes(collectionId));
    assert.deepEqual(f.counts(), { releases: 1, deletes: 0, commits: 0 });
  } finally {
    await app.close();
  }
});
