import type {
  MascaraBrief,
  MascaraBriefInput,
  MascaraPreferenceResponse,
} from '@wtm/contracts';
import type {
  MascaraBriefSnapshot,
  PreferencesRepository,
  SavedMascaraPreference,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';

export interface MascaraPreferencesService {
  ephemeralBrief(
    token: string | null,
    input: MascaraBriefInput,
  ): Promise<MascaraBrief>;
  current(token: string | null): Promise<MascaraPreferenceResponse>;
  save(token: string | null, input: MascaraBriefInput): Promise<MascaraBrief>;
}

function unauthenticated(): AppError {
  return new AppError({
    statusCode: 401,
    code: 'UNAUTHENTICATED',
    message: 'Authentication required',
  });
}

function accountRequired(): AppError {
  return new AppError({
    statusCode: 403,
    code: 'FORBIDDEN',
    message: 'Account session required',
  });
}

function normalizeIngredient(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

function snapshot(input: MascaraBriefInput): MascaraBriefSnapshot {
  const avoidedIngredients = [
    ...new Set(input.avoidedIngredients.map(normalizeIngredient)),
  ];
  if (
    avoidedIngredients.some(
      (ingredient) => ingredient.length === 0 || ingredient.length > 128,
    )
  ) {
    throw new AppError({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid avoided ingredient',
    });
  }

  const shared = {
    schemaVersion: 1 as const,
    waterproof: input.waterproof,
    removal: input.removal,
    sensitiveEyes: input.sensitiveEyes,
    contactLenses: input.contactLenses,
    avoidedIngredients,
  };
  return input.mode === 'PERSONALIZED'
    ? { ...shared, mode: 'PERSONALIZED', goals: [...input.goals] }
    : { ...shared, mode: 'UNKNOWN_GOALS', goals: [] };
}

function ephemeralBrief(
  value: MascaraBriefSnapshot,
  createdAt: Date,
): MascaraBrief {
  return {
    ...value,
    source: 'EPHEMERAL',
    profileVersion: null,
    createdAt: createdAt.toISOString(),
  };
}

function savedBrief(value: SavedMascaraPreference): MascaraBrief {
  return {
    ...value.snapshot,
    source: 'ACCOUNT_PROFILE',
    profileVersion: value.profileVersion,
    createdAt: value.createdAt.toISOString(),
  };
}

export function createMascaraPreferencesService(options: {
  identity: IdentityService;
  repository: PreferencesRepository;
  now?: () => Date;
}): MascaraPreferencesService {
  const now = options.now ?? (() => new Date());

  return {
    async ephemeralBrief(token, input): Promise<MascaraBrief> {
      const identity = await options.identity.current(token);
      if (!identity) throw unauthenticated();
      return ephemeralBrief(snapshot(input), now());
    },

    async current(token): Promise<MascaraPreferenceResponse> {
      const identity = await options.identity.current(token);
      if (!identity) throw unauthenticated();
      if (identity.kind !== 'ACCOUNT') throw accountRequired();
      const preference = await options.repository.currentMascaraPreference(
        identity.accountId,
      );
      return { preference: preference ? savedBrief(preference) : null };
    },

    async save(token, input): Promise<MascaraBrief> {
      const identity = await options.identity.current(token);
      if (!identity) throw unauthenticated();
      if (identity.kind !== 'ACCOUNT') throw accountRequired();
      const saved = await options.repository.saveMascaraPreference(
        identity.accountId,
        snapshot(input),
      );
      if (!saved) throw unauthenticated();
      return savedBrief(saved);
    },
  };
}
