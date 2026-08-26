import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createLocalMediaStorage } from '../src/local-media-storage.js';

test('local media storage derives private paths from server UUIDs', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'wtm-media-storage-'));
  const storage = createLocalMediaStorage({ rootDirectory });
  const assetId = '79df91cc-f632-4ad2-9b81-d50d9dff8d53';
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

  try {
    await storage.put(assetId, bytes);
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
