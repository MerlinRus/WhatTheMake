import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Pool } from 'pg';
import { normalizeGtin, type InciSourceSha256 } from '@wtm/domain';
import { createPostgresDatabase } from '../src/postgres.js';

const url = process.env.TEST_DATABASE_URL;
test(
  'a pending guest deletion cannot erase private data after the guest is claimed',
  { skip: url === undefined, timeout: 15_000 },
  async () => {
    assert.ok(url);
    const applicationName = `wtm-guest-claim-${randomUUID()}`;
    const database = createPostgresDatabase({
      connectionString: url,
      maxConnections: 2,
      applicationName,
    });
    const pool = new Pool({ connectionString: url, max: 2 });
    const claim = await pool.connect();
    const hash = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    let deletion: Promise<void> | undefined;
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const tokenHash = hash(randomUUID());
      const guest = await database.identity.createGuestSession(tokenHash);
      const account = await database.identity.createAccount({
        email: `claim-erasure-${randomUUID()}@example.test`,
        passwordHash: 'test-only-password-hash',
        sessionTokenHash: hash(randomUUID()),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const gtin = normalizeGtin('5901234123457');
      assert.equal(gtin.kind, 'VALID');
      if (gtin.kind !== 'VALID') throw new Error('Invalid test GTIN');
      const { observation } = await database.productObservations.createOrReuse(
        guest,
        gtin.gtin,
      );
      const assetId = randomUUID();
      await pool.query(
        "INSERT INTO wtm_media_assets(id, collection_id, role, media_type, byte_size, sha256) VALUES($1,$2,'FRONT','image/png',1,$3)",
        [assetId, observation.mediaCollection.collectionId, hash('x')],
      );

      // Reproduce claimGuestSession's transaction while deliberately retaining
      // its guest lock. The deletion sees the old unclaimed guest/session snapshot.
      await claim.query('BEGIN');
      await claim.query(
        'UPDATE wtm_guests SET claimed_by_account_id=$2 WHERE id=$1',
        [guest.guestId, account.accountId],
      );
      await claim.query(
        'UPDATE wtm_identity_sessions SET revoked_at=now() WHERE guest_id=$1',
        [guest.guestId],
      );
      deletion = database.identity.deleteGuestBySession(tokenHash);
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const blocked = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF guest%'",
          [applicationName],
        );
        if (blocked.rowCount === 1) {
          waiting = true;
          break;
        }
        await setTimeout(25);
      }
      assert.equal(waiting, true, 'Deletion must be waiting on the claim lock');
      await claim.query('COMMIT');
      await deletion;

      const preserved = await pool.query(
        'SELECT deleted_at, claimed_by_account_id FROM wtm_guests WHERE id=$1',
        [guest.guestId],
      );
      assert.equal(preserved.rows[0]?.deleted_at, null);
      assert.equal(preserved.rows[0]?.claimed_by_account_id, account.accountId);
      assert.equal(await database.identity.resolveSession(tokenHash), null);
      assert.ok(
        await database.productObservations.findOwned(
          observation.observationId,
          account,
        ),
      );
      assert.ok(await database.media.findOwnedAsset(assetId, account));
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM wtm_media_recovery_jobs WHERE operation_kind='DELETE_ASSET' AND resource_id=$1",
            [assetId],
          )
        ).rowCount,
        0,
      );
    } finally {
      await claim.query('ROLLBACK');
      await deletion?.catch(() => undefined);
      claim.release();
      await Promise.all([database.close(), pool.end()]);
    }
  },
);

test(
  'guest erasure removes OCR revisions before their source media',
  { skip: url === undefined },
  async () => {
    assert.ok(url);
    const database = createPostgresDatabase({
      connectionString: url,
      maxConnections: 2,
      applicationName: 'wtm-ocr-guest-erasure',
    });
    const pool = new Pool({ connectionString: url, max: 1 });
    const hash = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const tokenHash = hash(randomUUID());
      const owner = await database.identity.createGuestSession(tokenHash);
      const gtin = normalizeGtin('5901234123457');
      assert.equal(gtin.kind, 'VALID');
      if (gtin.kind !== 'VALID') throw new Error('Invalid fixture GTIN');
      const { observation } = await database.productObservations.createOrReuse(
        owner,
        gtin.gtin,
      );
      const assetId = randomUUID();
      await pool.query(
        "INSERT INTO wtm_media_assets(id, collection_id, role, media_type, byte_size, sha256) VALUES ($1,$2,'INGREDIENTS','image/png',1,$3)",
        [assetId, observation.mediaCollection.collectionId, hash('ocr-image')],
      );
      const revision = await database.productObservationInci.createRevision({
        owner,
        observationId: observation.observationId,
        kind: 'OCR',
        mediaAssetId: assetId,
        providerId: 'TEST_OCR',
        providerVersion: 'fixture-v1',
        sourceText: 'Aqua, Glycerin',
        sourceSha256: hash('Aqua, Glycerin') as InciSourceSha256,
      });
      assert.equal(revision.kind, 'CREATED');

      await database.identity.deleteGuestBySession(tokenHash);

      assert.equal(await database.identity.resolveSession(tokenHash), null);
      for (const [table, column, id] of [
        ['wtm_product_observations', 'id', observation.observationId],
        [
          'wtm_product_observation_inci_revisions',
          'observation_id',
          observation.observationId,
        ],
        ['wtm_media_assets', 'id', assetId],
      ]) {
        const remaining = await pool.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`,
          [id],
        );
        assert.equal(remaining.rows[0].count, 0, table);
      }
      const jobs = await pool.query(
        "SELECT status FROM wtm_media_recovery_jobs WHERE operation_kind='DELETE_ASSET' AND resource_id=$1",
        [assetId],
      );
      assert.equal(jobs.rows[0]?.status, 'PENDING');
    } finally {
      await Promise.all([database.close(), pool.end()]);
    }
  },
);

test(
  'guest erasure purges private text and journals media cleanup without touching another owner',
  { skip: url === undefined },
  async () => {
    assert.ok(url);
    const database = createPostgresDatabase({
      connectionString: url,
      maxConnections: 3,
      applicationName: 'wtm-private-erasure',
    });
    const pool = new Pool({ connectionString: url, max: 1 });
    const hash = (text: string) =>
      createHash('sha256').update(text).digest('hex');
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const tokenHash = hash(randomUUID());
      const owner = await database.identity.createGuestSession(tokenHash);
      const stranger = await database.identity.createGuestSession(
        hash(randomUUID()),
      );
      const gtin = normalizeGtin('5901234123457');
      assert.equal(gtin.kind, 'VALID');
      if (gtin.kind !== 'VALID') throw new Error('Invalid test GTIN');
      const { observation } = await database.productObservations.createOrReuse(
        owner,
        gtin.gtin,
      );
      const other = await database.productObservations.createOrReuse(
        stranger,
        gtin.gtin,
      );
      const revision = await database.productObservationInci.createRevision({
        owner,
        observationId: observation.observationId,
        kind: 'USER_TRANSCRIPTION',
        sourceText: 'Aqua',
        sourceSha256: hash('Aqua') as InciSourceSha256,
      });
      assert.equal(revision.kind, 'CREATED');
      const assetId = randomUUID();
      await pool.query(
        "INSERT INTO wtm_media_assets(id, collection_id, role, media_type, byte_size, sha256) VALUES($1,$2,'FRONT','image/png',1,$3)",
        [assetId, observation.mediaCollection.collectionId, hash('x')],
      );
      await database.identity.deleteGuestBySession(tokenHash);
      assert.equal(await database.identity.resolveSession(tokenHash), null);
      await assert.rejects(database.media.createCollection(owner), {
        code: '23503',
      });
      for (const [table, column, id] of [
        ['wtm_product_observations', 'id', observation.observationId],
        [
          'wtm_product_observation_inci_revisions',
          'observation_id',
          observation.observationId,
        ],
        [
          'wtm_media_collections',
          'id',
          observation.mediaCollection.collectionId,
        ],
        ['wtm_media_assets', 'id', assetId],
      ]) {
        // Identifiers are fixed test literals, never request data.
        const remaining = await pool.query(
          'SELECT count(*)::int AS count FROM ' +
            table +
            ' WHERE ' +
            column +
            ' = $1',
          [id],
        );
        assert.equal(remaining.rows[0].count, 0, table);
      }
      const jobs = await pool.query(
        "SELECT status FROM wtm_media_recovery_jobs WHERE operation_kind='DELETE_ASSET' AND resource_id=$1",
        [assetId],
      );
      assert.equal(jobs.rowCount, 1);
      assert.equal(jobs.rows[0].status, 'PENDING');
      assert.ok(
        await database.productObservations.findOwned(
          other.observation.observationId,
          stranger,
        ),
      );
      await database.identity.deleteGuestBySession(tokenHash);
    } finally {
      await Promise.all([database.close(), pool.end()]);
    }
  },
);
