import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import type { MediaStorage } from '@wtm/domain';

import {
  createLocalMediaStorage,
  createMediaRecoveryWorker,
  createPostgresDatabase,
} from '../src/index.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0xff, 0xd9]);
}

test(
  'media recovery retries deletion and resumes stale work after restart',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const mediaRoot = await mkdtemp(join(tmpdir(), 'wtm-media-recovery-'));
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 5,
      applicationName: 'wtm-media-recovery-integration',
    });
    const adminPool = new Pool({ connectionString: testDatabaseUrl, max: 1 });
    const storage = createLocalMediaStorage({ rootDirectory: mediaRoot });

    await database.migrate(resolve('apps/server/migrations'));
    await adminPool.query(
      'TRUNCATE wtm_media_recovery_jobs, wtm_media_assets, wtm_media_collections, wtm_identity_sessions, wtm_guests, wtm_accounts CASCADE',
    );

    try {
      const owner = await database.identity.createGuestSession(
        randomBytes(32).toString('hex'),
      );
      const collection = await database.media.createCollection(owner);

      const abandonedAssetId = randomUUID();
      assert.deepEqual(
        await database.media.prepareAssetUpload({
          assetId: abandonedAssetId,
          collectionId: collection.collectionId,
          owner,
          recoveryDelayMs: 0,
        }),
        { kind: 'PREPARED' },
      );
      await storage.put(abandonedAssetId, jpeg());

      const orphanWorker = createMediaRecoveryWorker({
        repository: database.media,
        storage,
        pollIntervalMs: 60_000,
        leaseMs: 1,
        retryBaseMs: 1,
        retryMaxMs: 1,
      });
      assert.equal(await orphanWorker.runOnce(), true);
      await assert.rejects(storage.read(abandonedAssetId), { code: 'ENOENT' });

      const assetId = randomUUID();
      assert.deepEqual(
        await database.media.prepareAssetUpload({
          assetId,
          collectionId: collection.collectionId,
          owner,
          recoveryDelayMs: 60_000,
        }),
        { kind: 'PREPARED' },
      );
      await storage.put(assetId, jpeg());
      const committed = await database.media.commitAssetUpload({
        assetId,
        collectionId: collection.collectionId,
        owner,
        role: 'FRONT',
        mediaType: 'image/jpeg',
        byteSize: jpeg().byteLength,
        sha256: createHash('sha256').update(jpeg()).digest('hex'),
      });
      assert.equal(committed.kind, 'CREATED');

      assert.equal(
        await database.media.scheduleOwnedAssetDeletion(assetId, owner),
        true,
      );
      assert.equal(await database.media.findOwnedAsset(assetId, owner), null);
      assert.deepEqual(await storage.read(assetId), jpeg());
      assert.equal(
        await database.media.scheduleOwnedAssetDeletion(assetId, owner),
        false,
      );

      let failDelete = true;
      const flakyStorage: MediaStorage = {
        put: (id, bytes) => storage.put(id, bytes),
        read: (id) => storage.read(id),
        async delete(id): Promise<void> {
          if (failDelete) {
            failDelete = false;
            throw new Error('simulated delete failure');
          }
          await storage.delete(id);
        },
      };
      const firstWorker = createMediaRecoveryWorker({
        repository: database.media,
        storage: flakyStorage,
        pollIntervalMs: 60_000,
        leaseMs: 30_000,
        retryBaseMs: 1,
        retryMaxMs: 1,
      });
      assert.equal(await firstWorker.runOnce(), true);

      const retried = await adminPool.query<{
        id: string;
        status: string;
        attempts: number;
        last_error_code: string;
      }>(
        `
          SELECT id, status, attempts, last_error_code
          FROM wtm_media_recovery_jobs
          WHERE operation_kind = 'DELETE_ASSET' AND resource_id = $1
        `,
        [assetId],
      );
      assert.equal(retried.rows[0]?.status, 'PENDING');
      assert.equal(retried.rows[0]?.attempts, 1);
      assert.equal(retried.rows[0]?.last_error_code, 'MEDIA_DELETE_FAILED');

      await adminPool.query(
        `
          UPDATE wtm_media_recovery_jobs
          SET available_at = now()
          WHERE operation_kind = 'DELETE_ASSET' AND resource_id = $1
        `,
        [assetId],
      );
      const abandonedClaim = await database.media.claimRecoveryJob(30_000);
      assert.equal(abandonedClaim?.kind, 'DELETE_ASSET');
      assert.equal(abandonedClaim?.attempts, 2);
      await adminPool.query(
        `
          UPDATE wtm_media_recovery_jobs
          SET locked_at = now() - interval '1 minute'
          WHERE id = $1
        `,
        [abandonedClaim?.jobId],
      );

      const restartedWorker = createMediaRecoveryWorker({
        repository: database.media,
        storage,
        pollIntervalMs: 60_000,
        leaseMs: 1,
        retryBaseMs: 1,
        retryMaxMs: 1,
      });
      assert.equal(await restartedWorker.runOnce(), true);
      assert.equal(await restartedWorker.runOnce(), false);
      await assert.rejects(storage.read(assetId), { code: 'ENOENT' });

      const completed = await adminPool.query<{
        status: string;
        attempts: number;
        completed_at: Date | null;
      }>(
        `
          SELECT status, attempts, completed_at
          FROM wtm_media_recovery_jobs
          WHERE operation_kind = 'DELETE_ASSET' AND resource_id = $1
        `,
        [assetId],
      );
      assert.equal(completed.rows[0]?.status, 'COMPLETED');
      assert.equal(completed.rows[0]?.attempts, 3);
      assert.ok(completed.rows[0]?.completed_at instanceof Date);
    } finally {
      await database.close();
      await adminPool.end();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  },
);
