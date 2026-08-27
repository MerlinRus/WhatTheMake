import type { AuthenticatedIdentity } from './identity.js';
import type { ProductObservationId } from './product-observation.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export const MAX_PRODUCT_OBSERVATION_INCI_REVISIONS = 50;

export type ProductObservationInciRevisionId =
  TaggedString<'ProductObservationInciRevisionId'>;
export type InciSourceSha256 = TaggedString<'InciSourceSha256'>;

export type ProductObservationInciRevisionSource =
  | {
      kind: 'OCR';
      mediaAssetId: string;
      providerId: string;
      providerVersion: string;
    }
  | { kind: 'USER_TRANSCRIPTION' }
  | {
      kind: 'USER_CORRECTION';
      basedOnRevisionId: ProductObservationInciRevisionId;
    };

export interface ProductObservationInciRevision {
  revisionId: ProductObservationInciRevisionId;
  revisionNumber: number;
  source: ProductObservationInciRevisionSource;
  sourceText: string;
  sourceSha256: InciSourceSha256;
  authorKind: 'SYSTEM' | AuthenticatedIdentity['kind'];
  createdAt: Date;
}

export interface ProductObservationInciWorkspace {
  original: ProductObservationInciRevision | null;
  latest: ProductObservationInciRevision | null;
  revisionCount: number;
  maxRevisions: typeof MAX_PRODUCT_OBSERVATION_INCI_REVISIONS;
}

export type CreateProductObservationInciRevisionInput = {
  observationId: ProductObservationId;
  owner: AuthenticatedIdentity;
  sourceText: string;
  sourceSha256: InciSourceSha256;
} & (
  | { kind: 'USER_TRANSCRIPTION' }
  | {
      kind: 'USER_CORRECTION';
      basedOnRevisionId: ProductObservationInciRevisionId;
    }
);

export type CreateProductObservationInciRevisionResult =
  | {
      kind: 'CREATED' | 'REUSED';
      revision: ProductObservationInciRevision;
    }
  | {
      kind:
        | 'OBSERVATION_NOT_FOUND'
        | 'REVISION_NOT_FOUND'
        | 'SOURCE_ALREADY_EXISTS'
        | 'SAME_TEXT'
        | 'LIMIT_REACHED';
    };

export interface ProductObservationInciRepository {
  findWorkspace(
    observationId: ProductObservationId,
    owner: AuthenticatedIdentity,
  ): Promise<ProductObservationInciWorkspace | null>;
  createRevision(
    input: CreateProductObservationInciRevisionInput,
  ): Promise<CreateProductObservationInciRevisionResult>;
  findOwnedRevision(
    observationId: ProductObservationId,
    revisionId: ProductObservationInciRevisionId,
    owner: AuthenticatedIdentity,
  ): Promise<ProductObservationInciRevision | null>;
}
