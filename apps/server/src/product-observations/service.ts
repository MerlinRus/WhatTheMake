import { createHash } from 'node:crypto';

import type {
  CatalogPromotion as ContractCatalogPromotion,
  CatalogPromotionIdentity as ContractCatalogPromotionIdentity,
  MediaAsset as ContractMediaAsset,
  MediaCollection as ContractMediaCollection,
  ProductObservation as ContractProductObservation,
} from '@wtm/contracts';
import {
  catalogPromotionFingerprintMaterial,
  normalizeGtin,
  normalizeCatalogPromotionIdentity,
  type AuthenticatedIdentity,
  type CatalogIdentityFingerprint,
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
  confirm(
    token: string | null,
    observationId: string,
    input: ContractCatalogPromotionIdentity,
  ): Promise<{
    kind: 'CREATED' | 'REUSED';
    promotion: ContractCatalogPromotion;
  }>;
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

function forbidden(): AppError {
  return new AppError({
    statusCode: 403,
    code: 'FORBIDDEN',
    message: 'Account session required',
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

    async confirm(token, observationId, input) {
      const owner = await identity(token);
      if (owner.kind !== 'ACCOUNT') throw forbidden();
      const normalizedIdentity = normalizeCatalogPromotionIdentity(input);
      if (!normalizedIdentity) {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid catalog identity',
        });
      }
      const observation = await options.repository.findOwned(
        observationId as ProductObservationId,
        owner,
      );
      if (!observation) throw notFound();
      const fingerprint = createHash('sha256')
        .update(
          catalogPromotionFingerprintMaterial(
            observation.barcode.gtin14,
            normalizedIdentity,
          ),
          'utf8',
        )
        .digest('hex') as CatalogIdentityFingerprint;
      const result = await options.repository.submitCatalogConfirmation({
        observationId: observation.observationId,
        accountId: owner.accountId,
        fingerprint,
        identity: normalizedIdentity,
      });
      if (result.kind === 'NOT_FOUND') throw notFound();
      if (result.kind === 'ALREADY_CONFIRMED') {
        throw new AppError({
          statusCode: 409,
          code: 'CONFLICT',
          message: 'Account already confirmed another identity',
          details: { reason: 'IDENTITY_ALREADY_CONFIRMED' },
        });
      }
      if (result.kind === 'PROMOTION_CLOSED') {
        throw new AppError({
          statusCode: 409,
          code: 'CONFLICT',
          message: 'Catalog promotion is already closed',
          details: { reason: 'PROMOTION_CLOSED' },
        });
      }
      return { kind: result.kind, promotion: result.promotion };
    },
  };
}
