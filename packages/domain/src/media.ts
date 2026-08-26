import type { AuthenticatedIdentity } from './identity.js';

export type MediaRole =
  'FRONT' | 'INGREDIENTS' | 'CLAIMS' | 'BARCODE' | 'PRICE_TAG';

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface MediaAsset {
  assetId: string;
  role: MediaRole;
  mediaType: ImageMediaType;
  byteSize: number;
  sha256: string;
  createdAt: Date;
}

export interface MediaCollection {
  collectionId: string;
  assets: MediaAsset[];
  createdAt: Date;
}

export interface CreateMediaAssetInput {
  assetId: string;
  collectionId: string;
  owner: AuthenticatedIdentity;
  role: MediaRole;
  mediaType: ImageMediaType;
  byteSize: number;
  sha256: string;
}

export interface PrepareMediaAssetUploadInput {
  assetId: string;
  collectionId: string;
  owner: AuthenticatedIdentity;
  recoveryDelayMs: number;
}

export type PrepareMediaAssetUploadResult =
  | { kind: 'PREPARED' }
  | { kind: 'COLLECTION_NOT_FOUND' }
  | { kind: 'CAPACITY_REACHED' };

export type CommitMediaAssetUploadResult =
  | { kind: 'CREATED'; asset: MediaAsset }
  | { kind: 'RECOVERY_NOT_PENDING' | 'ROLE_OCCUPIED' };

export type MediaRecoveryKind = 'ABANDONED_UPLOAD' | 'DELETE_ASSET';

export interface MediaRecoveryJob {
  jobId: string;
  kind: MediaRecoveryKind;
  assetId: string;
  attempts: number;
}

export interface MediaRecoveryRepository {
  claimRecoveryJob(leaseMs: number): Promise<MediaRecoveryJob | null>;
  completeRecoveryJob(jobId: string, attempt: number): Promise<void>;
  retryRecoveryJob(
    jobId: string,
    attempt: number,
    delayMs: number,
    errorCode: string,
  ): Promise<void>;
}

export interface MediaRepository extends MediaRecoveryRepository {
  createCollection(owner: AuthenticatedIdentity): Promise<MediaCollection>;
  findOwnedCollection(
    collectionId: string,
    owner: AuthenticatedIdentity,
  ): Promise<MediaCollection | null>;
  prepareAssetUpload(
    input: PrepareMediaAssetUploadInput,
  ): Promise<PrepareMediaAssetUploadResult>;
  commitAssetUpload(
    input: CreateMediaAssetInput,
  ): Promise<CommitMediaAssetUploadResult>;
  completePreparedAssetUpload(assetId: string): Promise<void>;
  findOwnedAsset(
    assetId: string,
    owner: AuthenticatedIdentity,
  ): Promise<MediaAsset | null>;
  scheduleOwnedAssetDeletion(
    assetId: string,
    owner: AuthenticatedIdentity,
  ): Promise<boolean>;
}

export interface MediaStorage {
  put(assetId: string, bytes: Uint8Array): Promise<void>;
  read(assetId: string): Promise<Uint8Array>;
  delete(assetId: string): Promise<void>;
}
