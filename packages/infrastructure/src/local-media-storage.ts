import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { MediaStorage } from '@wtm/domain';

const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function createLocalMediaStorage(options: {
  rootDirectory: string;
}): MediaStorage {
  const rootDirectory = resolve(options.rootDirectory);

  const assetPath = (assetId: string): string => {
    if (!ASSET_ID_PATTERN.test(assetId)) {
      throw new Error('Invalid media asset ID');
    }
    const path = resolve(
      rootDirectory,
      assetId.slice(0, 2),
      assetId.slice(2, 4),
      assetId,
    );
    if (!path.startsWith(`${rootDirectory}${sep}`)) {
      throw new Error('Media path escaped storage root');
    }
    return path;
  };

  return {
    async put(assetId, bytes): Promise<void> {
      const path = assetPath(assetId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    },

    async read(assetId): Promise<Uint8Array> {
      return readFile(assetPath(assetId));
    },

    async delete(assetId): Promise<void> {
      try {
        await unlink(assetPath(assetId));
      } catch (error) {
        if (isFileSystemError(error) && error.code === 'ENOENT') return;
        throw error;
      }
    },
  };
}
