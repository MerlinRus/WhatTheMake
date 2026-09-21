import type {
  CreatePrivateProductSnapshotInput,
  CreatePrivateProductSnapshotResponse,
  PrivateProductListResponse,
  PrivateProductSnapshot as ContractSnapshot,
  PrivateProductSnapshotResponse,
} from '@wtm/contracts';
import {
  hasUnsupportedMascaraCategory,
  normalizeCatalogPromotionIdentity,
  type AuthenticatedIdentity,
  type PrivateProductRepository,
  type PrivateProductSnapshot,
  type PrivateProductSnapshotId,
  type ProductObservationId,
  type ProductObservationInciRevisionId,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';

export interface PrivateProductService {
  create(
    token: string | null,
    observationId: string,
    input: CreatePrivateProductSnapshotInput,
  ): Promise<CreatePrivateProductSnapshotResponse>;
  get(
    token: string | null,
    snapshotId: string,
  ): Promise<PrivateProductSnapshotResponse>;
  list(
    token: string | null,
    limit?: number,
  ): Promise<PrivateProductListResponse>;
}

function notFound(): AppError {
  return new AppError({
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'Private product not found',
  });
}

export function privateProductSnapshotContract(
  snapshot: PrivateProductSnapshot,
): ContractSnapshot {
  const identity = snapshot.identity;
  return {
    ...snapshot,
    identity: {
      brandName: identity.brandName,
      familyName: identity.familyName,
      variantName: identity.variantName,
      shadeName: identity.shadeName,
      netQuantity:
        identity.netQuantityValue !== null && identity.netQuantityUnit !== null
          ? { value: identity.netQuantityValue, unit: identity.netQuantityUnit }
          : null,
      isWaterproof: identity.waterproof,
    },
    revision: {
      ...snapshot.revision,
      createdAt: snapshot.revision.createdAt.toISOString(),
    },
    createdAt: snapshot.createdAt.toISOString(),
  };
}

export function createPrivateProductService(options: {
  identity: Pick<IdentityService, 'current'>;
  repository: PrivateProductRepository;
}): PrivateProductService {
  async function owner(token: string | null): Promise<AuthenticatedIdentity> {
    const current = await options.identity.current(token);
    if (!current)
      throw new AppError({
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    return current;
  }

  return {
    async create(token, observationId, input) {
      const current = await owner(token);
      const identity = normalizeCatalogPromotionIdentity(input.identity);
      if (!identity)
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Invalid packaging identity',
        });
      if (
        hasUnsupportedMascaraCategory(identity.familyName, identity.variantName)
      ) {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Only mascara products are supported',
          details: { reason: 'UNSUPPORTED_CATEGORY' },
        });
      }
      if (
        identity.waterproof === false &&
        input.claimKinds.includes('WATERPROOF')
      ) {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Waterproof fields contradict each other',
          details: { reason: 'CONFLICTING_PACKAGING_FIELDS' },
        });
      }
      const result = await options.repository.createSnapshot({
        observationId: observationId as ProductObservationId,
        owner: current,
        category: input.category,
        identity,
        identityConfirmed: input.identityConfirmed,
        revisionId: input.revisionId as ProductObservationInciRevisionId,
        formulaComplete: input.formulaComplete ?? false,
        claimKinds: input.claimKinds,
        priceKopecks: input.priceKopecks,
      });
      switch (result.kind) {
        case 'OBSERVATION_NOT_FOUND':
        case 'REVISION_NOT_FOUND':
          throw notFound();
        case 'LIMIT_REACHED':
          throw new AppError({
            statusCode: 409,
            code: 'CONFLICT',
            message: 'Private product snapshot limit reached',
            details: { reason: 'SNAPSHOT_LIMIT_REACHED' },
          });
        default:
          return {
            resultKind: result.kind,
            snapshot: privateProductSnapshotContract(result.snapshot),
          };
      }
    },
    async get(token, snapshotId) {
      const snapshot = await options.repository.findOwned(
        snapshotId as PrivateProductSnapshotId,
        await owner(token),
      );
      if (!snapshot) throw notFound();
      return { snapshot: privateProductSnapshotContract(snapshot) };
    },
    async list(token, limit) {
      const snapshots = await options.repository.listOwned(
        await owner(token),
        limit,
      );
      return { snapshots: snapshots.map(privateProductSnapshotContract) };
    },
  };
}
