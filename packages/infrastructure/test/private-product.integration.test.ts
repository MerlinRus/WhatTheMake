import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';

import {
  normalizeCatalogPromotionIdentity,
  normalizeGtin,
  type CreatePrivateProductSnapshotInput,
  type InciSourceSha256,
} from '@wtm/domain';

import { createPostgresDatabase } from '../src/postgres.js';
import { createPostgresPrivateProductRepository } from '../src/private-product-repository.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

test(
  'private snapshots enforce ownership, immutable provenance, idempotency, bounds and privacy',
  { skip: testDatabaseUrl === undefined },
  async () => {
    assert.ok(testDatabaseUrl);
    const database = createPostgresDatabase({
      connectionString: testDatabaseUrl,
      maxConnections: 3,
      applicationName: 'wtm-private-snapshot-test',
    });
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
    const snapshots = createPostgresPrivateProductRepository(pool);
    try {
      await database.migrate(resolve('apps/server/migrations'));
      const guestToken = hash(randomUUID());
      const guest = await database.identity.createGuestSession(guestToken);
      const stranger = await database.identity.createGuestSession(
        hash(randomUUID()),
      );
      const gtin = normalizeGtin('4006381333931');
      assert.equal(gtin.kind, 'VALID');
      if (gtin.kind !== 'VALID') throw new Error('Invalid test GTIN');
      const { observation } = await database.productObservations.createOrReuse(
        guest,
        gtin.gtin,
      );
      const otherObservation = (
        await database.productObservations.createOrReuse(stranger, gtin.gtin)
      ).observation;
      const original = await database.productObservationInci.createRevision({
        observationId: observation.observationId,
        owner: guest,
        kind: 'USER_TRANSCRIPTION',
        sourceText: 'Aqua, Glycerin',
        sourceSha256: hash('Aqua, Glycerin') as InciSourceSha256,
      });
      assert.equal(original.kind, 'CREATED');
      if (!('revision' in original)) throw new Error('Revision missing');
      const identity = normalizeCatalogPromotionIdentity({
        brandName: 'Private Brand',
        familyName: 'Private Mascara',
        variantName: 'Black',
        shadeName: null,
        netQuantity: { value: '8.5', unit: 'MILLILITER' },
        isWaterproof: null,
      });
      assert.ok(identity);
      const input: CreatePrivateProductSnapshotInput = {
        observationId: observation.observationId,
        owner: guest,
        category: 'MASCARA',
        identity,
        identityConfirmed: true,
        revisionId: original.revision.revisionId,
        claimKinds: ['LENGTH', 'VOLUME'],
        priceKopecks: 59900,
      };
      const concurrent = await Promise.all([
        snapshots.createSnapshot(input),
        snapshots.createSnapshot({
          ...input,
          claimKinds: ['VOLUME', 'LENGTH'],
        }),
      ]);
      assert.deepEqual(concurrent.map((result) => result.kind).sort(), [
        'CREATED',
        'REUSED',
      ]);
      const created = concurrent.find((result) => result.kind === 'CREATED');
      assert.ok(created && 'snapshot' in created);
      const snapshot = created.snapshot;
      assert.equal(snapshot.formulaComplete, false);
      assert.equal(snapshot.identitySource, 'USER_CONFIRMED_PACKAGING');
      assert.equal(snapshot.priceSource, 'USER_ENTERED');
      assert.deepEqual(snapshot.revision, original.revision);
      assert.deepEqual(snapshot.barcode, gtin.gtin);
      assert.equal(
        await snapshots.findOwned(snapshot.snapshotId, stranger),
        null,
      );
      assert.deepEqual(await snapshots.listOwned(stranger), []);
      assert.deepEqual(
        await snapshots.createSnapshot({ ...input, owner: stranger }),
        { kind: 'OBSERVATION_NOT_FOUND' },
      );
      assert.deepEqual(
        await snapshots.createSnapshot({
          ...input,
          owner: stranger,
          observationId: otherObservation.observationId,
        }),
        { kind: 'REVISION_NOT_FOUND' },
      );
      await assert.rejects(
        pool.query(
          'UPDATE wtm_private_product_snapshots SET formula_complete = true WHERE id = $1',
          [snapshot.snapshotId],
        ),
        { code: '23514' },
      );
      await assert.rejects(
        pool.query('DELETE FROM wtm_private_product_snapshots WHERE id = $1', [
          snapshot.snapshotId,
        ]),
        { code: '23514' },
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO wtm_private_product_snapshots (observation_id, revision_id, snapshot_number, fingerprint, category, identity_confirmed, brand_name, family_name, variant_name) VALUES ($1,$2,1,$3,'MASCARA',true,'B','F','V')`,
          [
            otherObservation.observationId,
            original.revision.revisionId,
            hash('cross-observation'),
          ],
        ),
        { code: '23503' },
      );

      const correction = await database.productObservationInci.createRevision({
        observationId: observation.observationId,
        owner: guest,
        kind: 'USER_CORRECTION',
        basedOnRevisionId: original.revision.revisionId,
        sourceText: 'Aqua, Beeswax',
        sourceSha256: hash('Aqua, Beeswax') as InciSourceSha256,
      });
      assert.equal(correction.kind, 'CREATED');
      assert.equal(
        (await snapshots.findOwned(snapshot.snapshotId, guest))?.revision
          .sourceText,
        'Aqua, Glycerin',
      );
      for (let index = 1; index < 49; index += 1) {
        assert.equal(
          (await snapshots.createSnapshot({ ...input, priceKopecks: index }))
            .kind,
          'CREATED',
        );
      }
      const atLimit = await Promise.all([
        snapshots.createSnapshot({ ...input, priceKopecks: 100 }),
        snapshots.createSnapshot({ ...input, priceKopecks: 101 }),
      ]);
      assert.deepEqual(atLimit.map((result) => result.kind).sort(), [
        'CREATED',
        'LIMIT_REACHED',
      ]);
      assert.equal((await snapshots.createSnapshot(input)).kind, 'REUSED');
      assert.equal((await snapshots.listOwned(guest, 1000)).length, 30);
      assert.equal((await snapshots.listOwned(guest, 0)).length, 1);

      const account = await database.identity.createAccount({
        email: `${randomUUID()}@example.test`,
        passwordHash: 'integration-test-only',
        sessionTokenHash: hash(randomUUID()),
        guestSessionTokenHash: guestToken,
        expiresAt: new Date(Date.now() + 60_000),
      });
      assert.ok(await snapshots.findOwned(snapshot.snapshotId, account));
      assert.equal(await snapshots.findOwned(snapshot.snapshotId, guest), null);
      assert.equal(
        (await snapshots.createSnapshot({ ...input, owner: account })).kind,
        'REUSED',
      );
      await pool.query(
        'UPDATE wtm_media_collections SET deleted_at = now() WHERE id = $1',
        [observation.mediaCollection.collectionId],
      );
      assert.equal(
        await snapshots.findOwned(snapshot.snapshotId, account),
        null,
      );
      assert.deepEqual(await snapshots.listOwned(account), []);
      assert.deepEqual(
        await snapshots.createSnapshot({ ...input, owner: account }),
        { kind: 'OBSERVATION_NOT_FOUND' },
      );
      await pool.query('DELETE FROM wtm_product_observations WHERE id = $1', [
        observation.observationId,
      ]);
      const remaining = await pool.query(
        'SELECT id FROM wtm_private_product_snapshots WHERE observation_id = $1',
        [observation.observationId],
      );
      assert.equal(remaining.rowCount, 0);
    } finally {
      await Promise.all([database.close(), pool.end()]);
    }
  },
);
