import type { ProductClaimKind } from './catalog.js';
import type { NormalizedGtin } from './gtin.js';
import type { AuthenticatedIdentity } from './identity.js';
import type {
  ProductObservationInciRevision,
  ProductObservationInciRevisionId,
} from './inci-correction.js';
import type {
  CatalogPromotionIdentity,
  ProductObservationId,
} from './product-observation.js';

export const MAX_PRIVATE_PRODUCT_SNAPSHOTS = 50;
export const MAX_PRIVATE_PRODUCT_PRICE_KOPECKS = 100_000_000;

export type PrivateProductSnapshotId = string & {
  readonly __brand: 'PrivateProductSnapshotId';
};

export interface PrivateProductSnapshot {
  snapshotId: PrivateProductSnapshotId;
  observationId: ProductObservationId;
  snapshotNumber: number;
  category: 'MASCARA';
  barcode: NormalizedGtin;
  identity: CatalogPromotionIdentity;
  identitySource: 'USER_CONFIRMED_PACKAGING';
  revision: ProductObservationInciRevision;
  formulaComplete: boolean;
  claimKinds: ProductClaimKind[];
  claimsSource: 'USER_CONFIRMED_PACKAGING';
  priceKopecks: number | null;
  priceSource: 'USER_ENTERED' | null;
  createdAt: Date;
}

export interface CreatePrivateProductSnapshotInput {
  observationId: ProductObservationId;
  owner: AuthenticatedIdentity;
  category: 'MASCARA';
  identity: CatalogPromotionIdentity;
  identityConfirmed: true;
  revisionId: ProductObservationInciRevisionId;
  formulaComplete?: boolean;
  claimKinds: ProductClaimKind[];
  priceKopecks: number | null;
}

export type CreatePrivateProductSnapshotResult =
  | { kind: 'CREATED' | 'REUSED'; snapshot: PrivateProductSnapshot }
  | {
      kind: 'OBSERVATION_NOT_FOUND' | 'REVISION_NOT_FOUND' | 'LIMIT_REACHED';
    };

export interface PrivateProductRepository {
  createSnapshot(
    input: CreatePrivateProductSnapshotInput,
  ): Promise<CreatePrivateProductSnapshotResult>;
  findOwned(
    snapshotId: PrivateProductSnapshotId,
    owner: AuthenticatedIdentity,
  ): Promise<PrivateProductSnapshot | null>;
  /** Newest first; implementation clamps the requested count to 1..30. */
  listOwned(
    owner: AuthenticatedIdentity,
    limit?: number,
  ): Promise<PrivateProductSnapshot[]>;
}
