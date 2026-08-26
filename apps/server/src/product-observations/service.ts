import type {
  MediaAsset as ContractMediaAsset,
  MediaCollection as ContractMediaCollection,
  ProductObservation as ContractProductObservation,
} from '@wtm/contracts';
import {
  normalizeGtin,
  type AuthenticatedIdentity,
  type MediaAsset,
  type MediaCollection,
  type ProductObservation,
  type ProductObservationId,
  type ProductObservationRepository,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';

export interface ProductObservationService {
  create(
    token: string | null,
    gtin: string,
  ): Promise<{
    kind: 'CREATED' | 'REUSED';
    observation: ContractProductObservation;
  }>;
  get(
    token: string | null,
    observationId: string,
  ): Promise<ContractProductObservation>;
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
    message: 'Product observation not found',
  });
}

function contractAsset(asset: MediaAsset): ContractMediaAsset {
  return {
    assetId: asset.assetId,
    role: asset.role,
    mediaType: asset.mediaType,
    byteSize: asset.byteSize,
    createdAt: asset.createdAt.toISOString(),
  };
}

function contractCollection(
  collection: MediaCollection,
): ContractMediaCollection {
  return {
    collectionId: collection.collectionId,
    assets: collection.assets.map(contractAsset),
    createdAt: collection.createdAt.toISOString(),
  };
}

function contractObservation(
  observation: ProductObservation,
): ContractProductObservation {
  return {
    schemaVersion: 1,
    observationId: observation.observationId,
    barcode: observation.barcode,
    mediaCollection: contractCollection(observation.mediaCollection),
    createdAt: observation.createdAt.toISOString(),
    updatedAt: observation.updatedAt.toISOString(),
  };
}

export function createProductObservationService(options: {
  identity: IdentityService;
  repository: ProductObservationRepository;
}): ProductObservationService {
  const identity = async (
    token: string | null,
  ): Promise<AuthenticatedIdentity> => {
    const current = await options.identity.current(token);
    if (!current) throw unauthenticated();
    return current;
  };

  return {
    async create(token, gtin) {
      const normalized = normalizeGtin(gtin);
      if (normalized.kind === 'INVALID') {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid GTIN',
          details: { reason: normalized.reason },
        });
      }
      const result = await options.repository.createOrReuse(
        await identity(token),
        normalized.gtin,
      );
      return {
        kind: result.kind,
        observation: contractObservation(result.observation),
      };
    },

    async get(token, observationId) {
      const found = await options.repository.findOwned(
        observationId as ProductObservationId,
        await identity(token),
      );
      if (!found) throw notFound();
      return contractObservation(found);
    },
  };
}
