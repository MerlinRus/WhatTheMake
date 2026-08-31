import { createHash } from 'node:crypto';

import {
  INCI_LOOKUP_NORMALIZER_VERSION,
  normalizeInciLookupText,
  serializeInciDictionarySnapshot,
  type CanonicalIngredientId,
  type InciDictionaryAliasId,
  type InciDictionaryPublicationInput,
  type InciDictionarySnapshot,
  type InciDictionaryVersion,
} from '@wtm/domain';

const DICTIONARY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAXIMUM_INGREDIENTS = 5_000;
const MAXIMUM_TEXT_LENGTH = 300;

export type InciDictionaryValidationCode =
  | 'INVALID_JSON'
  | 'INVALID_SHAPE'
  | 'INVALID_VERSION'
  | 'INVALID_NORMALIZER_VERSION'
  | 'INVALID_ENTRY_COUNT'
  | 'INVALID_UUID'
  | 'INVALID_NAME'
  | 'INVALID_LOOKUP_KEY'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_CANONICAL_KEY'
  | 'DUPLICATE_ALIAS_MAPPING'
  | 'NON_DETERMINISTIC_ORDER';

export class InciDictionaryValidationError extends Error {
  constructor(
    public readonly code: InciDictionaryValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'InciDictionaryValidationError';
  }
}

type JsonObject = Record<string, unknown>;

function fail(code: InciDictionaryValidationCode, message: string): never {
  throw new InciDictionaryValidationError(code, message);
}

function strictObject(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('INVALID_SHAPE', `${path} must be an object`);
  }
  const object = value as JsonObject;
  const actualKeys = Object.keys(object);
  if (
    actualKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(object, key))
  ) {
    return fail(
      'INVALID_SHAPE',
      `${path} must contain exactly: ${expectedKeys.join(', ')}`,
    );
  }
  return object;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    return fail('INVALID_SHAPE', `${path} must be a string`);
  }
  return value;
}

function uuid(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!UUID_PATTERN.test(parsed)) {
    return fail('INVALID_UUID', `${path} must be a lowercase UUID`);
  }
  return parsed;
}

function name(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (
    parsed.length === 0 ||
    parsed.length > MAXIMUM_TEXT_LENGTH ||
    parsed !== parsed.trim()
  ) {
    return fail(
      'INVALID_NAME',
      `${path} must be trimmed and contain 1..300 characters`,
    );
  }
  return parsed;
}

function lookupKey(value: unknown, sourceText: string, path: string): string {
  const parsed = stringValue(value, path);
  if (
    parsed.length === 0 ||
    parsed.length > MAXIMUM_TEXT_LENGTH ||
    parsed !== normalizeInciLookupText(sourceText)
  ) {
    return fail(
      'INVALID_LOOKUP_KEY',
      `${path} must equal normalizeInciLookupText(source text)`,
    );
  }
  return parsed;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTuple(
  leftPrimary: string,
  leftSecondary: string,
  rightPrimary: string,
  rightSecondary: string,
): number {
  return (
    compareText(leftPrimary, rightPrimary) ||
    compareText(leftSecondary, rightSecondary)
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function prepareInciDictionaryPublication(
  rawArtifact: string,
): InciDictionaryPublicationInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArtifact) as unknown;
  } catch {
    return fail('INVALID_JSON', 'INCI dictionary artifact is not valid JSON');
  }

  const root = strictObject(parsed, 'dictionary', [
    'dictionaryVersion',
    'normalizerVersion',
    'ingredients',
  ]);
  const dictionaryVersion = stringValue(
    root.dictionaryVersion,
    'dictionary.dictionaryVersion',
  );
  if (!DICTIONARY_VERSION_PATTERN.test(dictionaryVersion)) {
    return fail(
      'INVALID_VERSION',
      'dictionary.dictionaryVersion must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$',
    );
  }
  if (root.normalizerVersion !== INCI_LOOKUP_NORMALIZER_VERSION) {
    return fail(
      'INVALID_NORMALIZER_VERSION',
      `dictionary.normalizerVersion must be ${INCI_LOOKUP_NORMALIZER_VERSION}`,
    );
  }
  if (!Array.isArray(root.ingredients)) {
    return fail('INVALID_SHAPE', 'dictionary.ingredients must be an array');
  }
  if (
    root.ingredients.length < 1 ||
    root.ingredients.length > MAXIMUM_INGREDIENTS
  ) {
    return fail(
      'INVALID_ENTRY_COUNT',
      'dictionary.ingredients must contain 1..5000 entries',
    );
  }

  const ids = new Set<string>();
  const canonicalKeys = new Set<string>();
  const aliasMappings = new Set<string>();
  const ingredients = root.ingredients.map((value, ingredientIndex) => {
    const path = `dictionary.ingredients[${ingredientIndex}]`;
    const ingredient = strictObject(value, path, [
      'ingredientId',
      'canonicalName',
      'canonicalLookupKey',
      'aliases',
    ]);
    const ingredientId = uuid(ingredient.ingredientId, `${path}.ingredientId`);
    if (ids.has(ingredientId)) {
      return fail('DUPLICATE_ID', `${path}.ingredientId is duplicated`);
    }
    ids.add(ingredientId);

    const canonicalName = name(
      ingredient.canonicalName,
      `${path}.canonicalName`,
    );
    const canonicalLookupKey = lookupKey(
      ingredient.canonicalLookupKey,
      canonicalName,
      `${path}.canonicalLookupKey`,
    );
    if (canonicalKeys.has(canonicalLookupKey)) {
      return fail(
        'DUPLICATE_CANONICAL_KEY',
        `${path}.canonicalLookupKey is duplicated`,
      );
    }
    canonicalKeys.add(canonicalLookupKey);

    if (!Array.isArray(ingredient.aliases)) {
      return fail('INVALID_SHAPE', `${path}.aliases must be an array`);
    }
    const aliases = ingredient.aliases.map((value, aliasIndex) => {
      const aliasPath = `${path}.aliases[${aliasIndex}]`;
      const alias = strictObject(value, aliasPath, [
        'aliasId',
        'aliasText',
        'lookupKey',
      ]);
      const aliasId = uuid(alias.aliasId, `${aliasPath}.aliasId`);
      if (ids.has(aliasId)) {
        return fail('DUPLICATE_ID', `${aliasPath}.aliasId is duplicated`);
      }
      ids.add(aliasId);

      const aliasText = name(alias.aliasText, `${aliasPath}.aliasText`);
      const aliasLookupKey = lookupKey(
        alias.lookupKey,
        aliasText,
        `${aliasPath}.lookupKey`,
      );
      const mapping = `${ingredientId}\u0000${aliasLookupKey}`;
      if (aliasMappings.has(mapping)) {
        return fail(
          'DUPLICATE_ALIAS_MAPPING',
          `${aliasPath}.lookupKey duplicates an ingredient alias mapping`,
        );
      }
      aliasMappings.add(mapping);

      return {
        aliasId: aliasId as InciDictionaryAliasId,
        aliasText,
        lookupKey: aliasLookupKey,
      };
    });

    for (let index = 1; index < aliases.length; index += 1) {
      const previous = aliases[index - 1];
      const current = aliases[index];
      if (
        previous &&
        current &&
        compareTuple(
          previous.lookupKey,
          previous.aliasId,
          current.lookupKey,
          current.aliasId,
        ) > 0
      ) {
        return fail(
          'NON_DETERMINISTIC_ORDER',
          `${path}.aliases must be sorted by lookupKey, then aliasId`,
        );
      }
    }

    return {
      ingredientId: ingredientId as CanonicalIngredientId,
      canonicalName,
      canonicalLookupKey,
      aliases,
    };
  });

  for (let index = 1; index < ingredients.length; index += 1) {
    const previous = ingredients[index - 1];
    const current = ingredients[index];
    if (
      previous &&
      current &&
      compareTuple(
        previous.canonicalLookupKey,
        previous.ingredientId,
        current.canonicalLookupKey,
        current.ingredientId,
      ) > 0
    ) {
      return fail(
        'NON_DETERMINISTIC_ORDER',
        'dictionary.ingredients must be sorted by canonicalLookupKey, then ingredientId',
      );
    }
  }

  const snapshot: InciDictionarySnapshot = {
    dictionaryVersion: dictionaryVersion as InciDictionaryVersion,
    normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
    ingredients,
  };
  return {
    snapshot,
    contentSha256: sha256(serializeInciDictionarySnapshot(snapshot)),
  };
}
