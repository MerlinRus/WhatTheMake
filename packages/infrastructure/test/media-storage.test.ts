import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MediaStorageCapacityError } from '@wtm/domain';

import { createLocalMediaStorage } from '../src/local-media-storage.js';

test('local media storage derives private paths from server UUIDs', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'wtm-media-storage-'));
  const storage = createLocalMediaStorage({ rootDirectory });
  const assetId = '79df91cc-f632-4ad2-9b81-d50d9dff8d53';
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

  try {
    await storage.put(assetId, bytes);
    assert.deepEqual(await storage.read(assetId), Buffer.from(bytes));
    await assert.rejects(storage.put(assetId, Uint8Array.from([1, 2, 3])), {
      code: 'EEXIST',
    });
    assert.deepEqual(await storage.read(assetId), Buffer.from(bytes));
    await assert.rejects(
      storage.put('../../etc/passwd', bytes),
      /Invalid media asset ID/,
    );
    await storage.delete(assetId);
    await storage.delete(assetId);
    await assert.rejects(storage.read(assetId), { code: 'ENOENT' });
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test('media disk reserve serializes admission and keeps reads/deletes available below the floor', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'wtm-media-capacity-'));
  const firstId = '79df91cc-f632-4ad2-9b81-d50d9dff8d53';
  const secondId = '79df91cc-f632-4ad2-9b81-d50d9dff8d54';
  let available = 14n;
  let opened = 0;
  let checks = 0;
  const storage = createLocalMediaStorage({
    rootDirectory,
    minimumFreeBytes: 10,
    filesystem: {
      async statfs() {
        checks += 1;
        return { bsize: 1n, bavail: available };
      },
      async open(path, flags, mode) {
        opened += 1;
        const handle = await open(path, flags, mode);
        return {
          async writeFile(bytes) {
            await handle.writeFile(bytes);
            available -= 4n;
          },
          close: () => handle.close(),
        };
      },
    },
  });
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  try {
    const results = await Promise.allSettled([
      storage.put(firstId, bytes),
      storage.put(secondId, bytes),
    ]);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, 'rejected');
    if (results[1]?.status === 'rejected')
      assert.ok(results[1].reason instanceof MediaStorageCapacityError);
    assert.equal(checks, 2);
    assert.equal(opened, 1);
    await assert.rejects(storage.read(secondId), { code: 'ENOENT' });
    available = 0n;
    assert.deepEqual(await storage.read(firstId), Buffer.from(bytes));
    await storage.delete(firstId);
    await storage.delete(firstId);
    available = 14n;
    await storage.put(secondId, bytes);
    assert.deepEqual(await storage.read(secondId), Buffer.from(bytes));
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test('media capacity check fails closed and rejects invalid reserve configuration', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'wtm-media-statfs-'));
  const id = '79df91cc-f632-4ad2-9b81-d50d9dff8d53';
  let opened = false;
  try {
    for (const minimumFreeBytes of [
      -1,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      assert.throws(() =>
        createLocalMediaStorage({ rootDirectory, minimumFreeBytes }),
      );
    const storage = createLocalMediaStorage({
      rootDirectory,
      minimumFreeBytes: 10,
      filesystem: {
        async statfs() {
          throw new Error('statfs failed');
        },
        async open(path, flags, mode) {
          opened = true;
          return open(path, flags, mode);
        },
      },
    });
    await assert.rejects(
      storage.put(id, Uint8Array.from([1])),
      /statfs failed/,
    );
    assert.equal(opened, false);
    await assert.rejects(storage.read(id), { code: 'ENOENT' });
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

test('media partial-write failure removes only its own new file and does not poison the queue', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'wtm-media-partial-'));
  const id = '79df91cc-f632-4ad2-9b81-d50d9dff8d53';
  let fail = true;
  const storage = createLocalMediaStorage({
    rootDirectory,
    filesystem: {
      async statfs() {
        throw new Error('Disabled default floor must not call statfs');
      },
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        return {
          async writeFile(bytes) {
            await handle.writeFile(bytes);
            if (fail)
              throw Object.assign(new Error('No space left'), {
                code: 'ENOSPC',
              });
          },
          close: () => handle.close(),
        };
      },
    },
  });
  try {
    await assert.rejects(storage.put(id, Uint8Array.from([1, 2])), {
      code: 'ENOSPC',
    });
    await assert.rejects(storage.read(id), { code: 'ENOENT' });
    fail = false;
    await storage.put(id, Uint8Array.from([3]));
    await assert.rejects(storage.put(id, Uint8Array.from([4])), {
      code: 'EEXIST',
    });
    assert.deepEqual(await storage.read(id), Buffer.from([3]));
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
