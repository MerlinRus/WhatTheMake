import { createHash } from 'node:crypto';

import type {
  CreateProductObservationInciRevisionInput,
  CreateProductObservationInciRevisionResponse,
  ProductObservationInciAnalysisResponse,
  ProductObservationInciRevision as ContractInciRevision,
  ProductObservationInciWorkspaceResponse,
} from '@wtm/contracts';
import {
  canonicalizeInci,
  MAX_INCI_SOURCE_LENGTH,
  parseInci,
  type AuthenticatedIdentity,
  type CreateProductObservationInciRevisionResult,
  type InciDictionaryRepository,
  type InciSourceSha256,
  type OcrFailureCode,
  type OcrProvider,
  type ProductObservationId,
  type ProductObservationInciRepository,
  type ProductObservationInciRevision,
  type ProductObservationInciRevisionId,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import type { MediaService } from '../media/service.js';
import type { ProductObservationService } from '../product-observations/service.js';

export interface InciCorrectionService {
  workspace(
    token: string | null,
    observationId: string,
  ): Promise<ProductObservationInciWorkspaceResponse>;
  createRevision(
    token: string | null,
    observationId: string,
    input: CreateProductObservationInciRevisionInput,
  ): Promise<CreateProductObservationInciRevisionResponse>;
  recognize(
    token: string | null,
    observationId: string,
    mediaAssetId: string,
    signal?: AbortSignal,
  ): Promise<CreateProductObservationInciRevisionResponse>;
  analysis(
    token: string | null,
    observationId: string,
    revisionId: string,
  ): Promise<ProductObservationInciAnalysisResponse>;
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
    message: 'INCI revision not found',
  });
}

function conflict(reason: string, message: string): AppError {
  return new AppError({
    statusCode: 409,
    code: 'CONFLICT',
    message,
    details: { reason },
  });
}

function contractRevision(
  revision: ProductObservationInciRevision,
): ContractInciRevision {
  return {
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    source: revision.source,
    sourceText: revision.sourceText,
    sourceSha256: revision.sourceSha256,
    authorKind: revision.authorKind,
    createdAt: revision.createdAt.toISOString(),
  };
}

function validSourceText(value: string): boolean {
  return (
    value.trim().length > 0 &&
    value.length <= MAX_INCI_SOURCE_LENGTH &&
    !value.includes('\0')
  );
}

function sourceSha256(value: string): InciSourceSha256 {
  return createHash('sha256')
    .update(value, 'utf8')
    .digest('hex') as InciSourceSha256;
}

function revisionResponse(
  result: CreateProductObservationInciRevisionResult,
): CreateProductObservationInciRevisionResponse {
  switch (result.kind) {
    case 'OBSERVATION_NOT_FOUND':
    case 'REVISION_NOT_FOUND':
      throw notFound();
    case 'SOURCE_ALREADY_EXISTS':
      throw conflict(
        'SOURCE_ALREADY_EXISTS',
        'Original INCI source already exists',
      );
    case 'SAME_TEXT':
      throw conflict('SAME_TEXT', 'Correction matches selected revision');
    case 'LIMIT_REACHED':
      throw conflict('LIMIT_REACHED', 'INCI revision limit reached');
    case 'CREATED':
    case 'REUSED':
      return {
        resultKind: result.kind,
        revision: contractRevision(result.revision),
      };
  }
}

function ocrFailure(code: OcrFailureCode, retryable: boolean): AppError {
  const capacityFailure = [
    'OCR_RATE_LIMITED',
    'OCR_OVERLOADED',
    'OCR_QUEUE_TIMEOUT',
  ].includes(code);
  return new AppError({
    statusCode: capacityFailure ? 429 : 503,
    code: capacityFailure ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE',
    message: capacityFailure
      ? 'OCR capacity is temporarily unavailable'
      : 'OCR is temporarily unavailable',
    details: { reason: code, retryable },
  });
}

export function createInciCorrectionService(options: {
  identity: IdentityService;
  repository: ProductObservationInciRepository;
  dictionary: InciDictionaryRepository;
  ocr?: OcrProvider;
  media?: MediaService;
  observations?: ProductObservationService;
}): InciCorrectionService {
  const identity = async (
    token: string | null,
  ): Promise<AuthenticatedIdentity> => {
    const current = await options.identity.current(token);
    if (!current) throw unauthenticated();
    return current;
  };

  return {
    async workspace(token, observationId) {
      const found = await options.repository.findWorkspace(
        observationId as ProductObservationId,
        await identity(token),
      );
      if (!found) throw notFound();
      return {
        workspace: {
          original: found.original ? contractRevision(found.original) : null,
          latest: found.latest ? contractRevision(found.latest) : null,
          revisionCount: found.revisionCount,
          maxRevisions: found.maxRevisions,
        },
      };
    },

    async createRevision(token, observationId, input) {
      if (!validSourceText(input.sourceText)) {
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'INCI source text is empty or too large',
        });
      }
      const result = await options.repository.createRevision({
        observationId: observationId as ProductObservationId,
        owner: await identity(token),
        sourceText: input.sourceText,
        sourceSha256: sourceSha256(input.sourceText),
        ...(input.kind === 'USER_TRANSCRIPTION'
          ? { kind: 'USER_TRANSCRIPTION' as const }
          : {
              kind: 'USER_CORRECTION' as const,
              basedOnRevisionId:
                input.basedOnRevisionId as ProductObservationInciRevisionId,
            }),
      });
      return revisionResponse(result);
    },

    async recognize(token, observationId, mediaAssetId, signal) {
      if (!options.ocr || !options.media || !options.observations) {
        throw new AppError({
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'OCR is not configured',
          details: { reason: 'OCR_DISABLED', retryable: false },
        });
      }
      const owner = await identity(token);
      const observation = await options.observations.get(token, observationId);
      const observedAsset = observation.mediaCollection.assets.find(
        (asset) => asset.assetId === mediaAssetId,
      );
      if (!observedAsset || observedAsset.role !== 'INGREDIENTS') {
        throw notFound();
      }
      const file = await options.media.file(token, mediaAssetId);
      if (file.asset.role !== 'INGREDIENTS') throw notFound();

      const result = await options.ocr.recognize({
        operation: 'DOCUMENT_TEXT_DETECTION',
        imageBytes: file.bytes,
        mediaType: file.asset.mediaType,
        languageHints: ['ru', 'en'],
        ...(signal ? { signal } : {}),
      });
      if (result.kind === 'FAILED') {
        throw ocrFailure(result.code, result.retryable);
      }
      if (!validSourceText(result.text)) {
        throw new AppError({
          statusCode: 422,
          code: 'VALIDATION_ERROR',
          message: 'No usable INCI text was recognized',
          details: { reason: 'OCR_TEXT_NOT_FOUND' },
        });
      }

      return revisionResponse(
        await options.repository.createRevision({
          observationId: observationId as ProductObservationId,
          owner,
          kind: 'OCR',
          mediaAssetId,
          providerId: options.ocr.providerId,
          providerVersion: options.ocr.version,
          sourceText: result.text,
          sourceSha256: sourceSha256(result.text),
        }),
      );
    },

    async analysis(token, observationId, revisionId) {
      const selected = await options.repository.findOwnedRevision(
        observationId as ProductObservationId,
        revisionId as ProductObservationInciRevisionId,
        await identity(token),
      );
      if (!selected) throw notFound();
      const parsed = parseInci(selected.sourceText);
      if (parsed.kind === 'REJECTED') {
        return {
          analysis: {
            schemaVersion: 1,
            selectedRevisionId: selected.revisionId,
            sourceSha256: selected.sourceSha256,
            parserVersion: parsed.parserVersion,
            parse: { kind: 'REJECTED', reason: parsed.reason },
            normalization: { kind: 'NOT_RUN', reason: 'PARSE_REJECTED' },
          },
        };
      }

      const parse = {
        kind: 'PARSED' as const,
        tokenCount: parsed.tokens.length,
        uncertainTokenCount: parsed.tokens.filter(
          (token) =>
            token.kind === 'UNRESOLVED' || token.uncertaintyReasons.length > 0,
        ).length,
      };
      const dictionary = await options.dictionary.findPublishedSnapshot();
      if (!dictionary) {
        return {
          analysis: {
            schemaVersion: 1,
            selectedRevisionId: selected.revisionId,
            sourceSha256: selected.sourceSha256,
            parserVersion: parsed.parserVersion,
            parse,
            normalization: {
              kind: 'NOT_RUN',
              reason: 'NO_PUBLISHED_DICTIONARY',
            },
          },
        };
      }

      const snapshot = canonicalizeInci(parsed, dictionary);
      const decisions = snapshot.tokens.flatMap((token) =>
        token.components.map((component) => component.decision),
      );
      return {
        analysis: {
          schemaVersion: 1,
          selectedRevisionId: selected.revisionId,
          sourceSha256: selected.sourceSha256,
          parserVersion: snapshot.parserVersion,
          parse,
          normalization: {
            kind: 'COMPLETED',
            canonicalizerVersion: snapshot.canonicalizerVersion,
            dictionaryVersion: snapshot.dictionaryVersion,
            normalizerVersion: snapshot.normalizerVersion,
            componentCount: decisions.length,
            resolvedCount: decisions.filter(
              (decision) => decision.kind === 'RESOLVED',
            ).length,
            ambiguousCount: decisions.filter(
              (decision) => decision.kind === 'AMBIGUOUS',
            ).length,
            unresolvedCount: decisions.filter(
              (decision) => decision.kind === 'UNRESOLVED',
            ).length,
          },
        },
      };
    },
  };
}
