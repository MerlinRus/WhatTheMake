import { createHash, randomUUID } from 'node:crypto';

import type {
  ImageMediaType as ContractImageMediaType,
  MediaAsset as ContractMediaAsset,
  MediaCollection as ContractMediaCollection,
  MediaRole as ContractMediaRole,
} from '@wtm/contracts';
import type {
  AuthenticatedIdentity,
  ImageMediaType,
  MediaAsset,
  MediaCollection,
  MediaRepository,
  MediaStorage,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';

export interface MediaFile {
  asset: ContractMediaAsset;
  bytes: Uint8Array;
}

export interface MediaService {
  createCollection(token: string | null): Promise<ContractMediaCollection>;
  collection(
    token: string | null,
    collectionId: string,
  ): Promise<ContractMediaCollection>;
  upload(
    token: string | null,
    input: {
      collectionId: string;
      role: ContractMediaRole;
      mediaType: ContractImageMediaType;
      bytes: Uint8Array;
    },
  ): Promise<ContractMediaAsset>;
  file(token: string | null, assetId: string): Promise<MediaFile>;
  delete(token: string | null, assetId: string): Promise<void>;
}

function unauthenticated(): AppError {
  return new AppError({
    statusCode: 401,
    code: 'UNAUTHENTICATED',
    message: 'Authentication required',
  });
}

function notFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Media resource not found',
  });
}

function capacityReached(): AppError {
  return new AppError({
    statusCode: 409,
    code: 'CONFLICT',
    message: 'Media collection already contains five images',
  });
}

function mediaAsset(asset: MediaAsset): ContractMediaAsset {
  return {
    assetId: asset.assetId,
    role: asset.role,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    createdAt: asset.createdAt.toISOString(),
  };
}

function mediaCollection(collection: MediaCollection): ContractMediaCollection {
  return {
    collectionId: collection.collectionId,
    assets: collection.assets.map(mediaAsset),
    createdAt: collection.createdAt.toISOString(),
  };
}

function hasImageSignature(
  bytes: Uint8Array,
  mediaType: ImageMediaType,
): boolean {
  if (mediaType === 'image/jpeg') {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (mediaType === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return (
      bytes.length >= signature.length &&
      signature.every((byte, index) => bytes[index] === byte)
    );
  }
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  );
}

export function createMediaService(options: {
  identity: IdentityService;
  repository: MediaRepository;
  storage: MediaStorage;
  maxBytes: number;
  recoveryDelayMs: number;
}): MediaService {
  const identity = async (
    token: string | null,
  ): Promise<AuthenticatedIdentity> => {
    const current = await options.identity.current(token);
    if (!current) throw unauthenticated();
    return current;
  };

  return {
    async createCollection(token) {
      return mediaCollection(
        await options.repository.createCollection(await identity(token)),
      );
    },

    async collection(token, collectionId) {
      const collection = await options.repository.findOwnedCollection(
        collectionId,
        await identity(token),
      );
      if (!collection) throw notFound();
      return mediaCollection(collection);
    },

    async upload(token, input) {
      const owner = await identity(token);
      if (
        input.bytes.byteLength === 0 ||
        input.bytes.byteLength > options.maxBytes
      ) {
        throw new AppError({
          statusCode: 413,
          code: 'VALIDATION_ERROR',
          message: 'Image exceeds upload size limit',
        });
      }
      if (!hasImageSignature(input.bytes, input.mediaType)) {
        throw new AppError({
          statusCode: 415,
          code: 'VALIDATION_ERROR',
          message: 'Image bytes do not match Content-Type',
        });
      }

      const assetId = randomUUID();
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const prepared = await options.repository.prepareAssetUpload({
        assetId,
        collectionId: input.collectionId,
        owner,
        recoveryDelayMs: options.recoveryDelayMs,
      });
      if (prepared.kind === 'COLLECTION_NOT_FOUND') throw notFound();
      if (prepared.kind === 'CAPACITY_REACHED') throw capacityReached();

      try {
        await options.storage.put(assetId, input.bytes);
      } catch {
        throw new AppError({
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Media storage is temporarily unavailable',
        });
      }

      const result = await options.repository.commitAssetUpload({
        assetId,
        collectionId: input.collectionId,
        owner,
        role: input.role,
        mediaType: input.mediaType,
        byteSize: input.bytes.byteLength,
        sha256,
      });
      if (result.kind === 'CREATED') return mediaAsset(result.asset);

      if (result.kind === 'ROLE_OCCUPIED') {
        try {
          await options.storage.delete(assetId);
          await options.repository.completePreparedAssetUpload(assetId);
        } catch {
          // Pending recovery keeps cleanup durable when immediate deletion fails.
        }
        throw new AppError({
          statusCode: 409,
          code: 'CONFLICT',
          message: 'Media role already has an image',
        });
      }
      await options.storage.delete(assetId).catch(() => {});
      throw new AppError({
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Media upload could not be committed',
      });
    },

    async file(token, assetId) {
      const asset = await options.repository.findOwnedAsset(
        assetId,
        await identity(token),
      );
      if (!asset) throw notFound();
      const bytes = await options.storage.read(assetId);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (
        bytes.byteLength !== asset.byteSize ||
        actualSha256 !== asset.sha256
      ) {
        throw new AppError({
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'Media object is temporarily unavailable',
        });
      }
      return {
        asset: mediaAsset(asset),
        bytes,
      };
    },

    async delete(token, assetId): Promise<void> {
      const owner = await identity(token);
      await options.repository.scheduleOwnedAssetDeletion(assetId, owner);
    },
  };
}
