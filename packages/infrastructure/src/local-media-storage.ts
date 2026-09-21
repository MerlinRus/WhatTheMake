import {
  mkdir,
  open,
  readFile,
  statfs,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { MediaStorageCapacityError, type MediaStorage } from '@wtm/domain';

const ASSET_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function createLocalMediaStorage(options: {
  rootDirectory: string;
  /** Soft filesystem reserve. Production explicitly configures 4 GiB. */
  minimumFreeBytes?: number;
  /** Narrow I/O seam for deterministic capacity/partial-write tests. */
  filesystem?: {
    statfs(path: string): Promise<{ bavail: bigint; bsize: bigint }>;
    open(
      path: string,
      flags: string,
      mode: number,
    ): Promise<Pick<FileHandle, 'writeFile' | 'close'>>;
  };
}): MediaStorage {
  const rootDirectory = resolve(options.rootDirectory);
  const minimumFreeBytes = options.minimumFreeBytes ?? 0;
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0)
    throw new Error('Invalid media storage reserve');
  const filesystem = options.filesystem ?? {
    statfs: (path: string) => statfs(path, { bigint: true }),
    open,
  };
  let previousWrite: Promise<void> = Promise.resolve();

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
      const operation = previousWrite.then(async () => {
        await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
        if (minimumFreeBytes > 0) {
          const capacity = await filesystem.statfs(rootDirectory);
          if (capacity.bsize <= 0n || capacity.bavail < 0n)
            throw new Error('Invalid media filesystem capacity');
          if (
            capacity.bavail * capacity.bsize <
            BigInt(minimumFreeBytes) + BigInt(bytes.byteLength)
          )
            throw new MediaStorageCapacityError();
        }
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        // Open outside cleanup: EEXIST must never remove an earlier object.
        const handle = await filesystem.open(path, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.close();
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(path).catch(() => {});
          // Failed unlink remains covered by the durable abandoned-upload job.
          throw error;
        }
      });
      previousWrite = operation.catch(() => {});
      return operation;
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
