import type { AuthenticatedIdentity } from './identity.js';
import type { MediaCollection } from './media.js';
import type { NormalizedGtin } from './gtin.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export type ProductObservationId = TaggedString<'ProductObservationId'>;

export interface ProductObservation {
  observationId: ProductObservationId;
  barcode: NormalizedGtin;
  mediaCollection: MediaCollection;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateProductObservationResult = {
  kind: 'CREATED' | 'REUSED';
  observation: ProductObservation;
};

export interface ProductObservationRepository {
  createOrReuse(
    owner: AuthenticatedIdentity,
    barcode: NormalizedGtin,
  ): Promise<CreateProductObservationResult>;
  findOwned(
    observationId: ProductObservationId,
    owner: AuthenticatedIdentity,
  ): Promise<ProductObservation | null>;
}
