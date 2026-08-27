import type { InciToken, ParsedInci } from './inci.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export const INCI_CANONICALIZER_VERSION = 'inci-canonicalizer-v1' as const;
export const INCI_LOOKUP_NORMALIZER_VERSION = 'inci-lookup-v1' as const;
export const INCI_NORMALIZATION_SCHEMA_VERSION =
  'inci-normalization-v1' as const;

export type CanonicalIngredientId = TaggedString<'CanonicalIngredientId'>;
export type InciDictionaryAliasId = TaggedString<'InciDictionaryAliasId'>;
export type InciDictionaryVersion = TaggedString<'InciDictionaryVersion'>;

export interface InciDictionaryAlias {
  aliasId: InciDictionaryAliasId;
  aliasText: string;
  lookupKey: string;
}

export interface InciDictionaryIngredient {
  ingredientId: CanonicalIngredientId;
  canonicalName: string;
  canonicalLookupKey: string;
  aliases: readonly InciDictionaryAlias[];
}

export interface InciDictionarySnapshot {
  dictionaryVersion: InciDictionaryVersion;
  normalizerVersion: typeof INCI_LOOKUP_NORMALIZER_VERSION;
  ingredients: readonly InciDictionaryIngredient[];
}

export interface InciDictionaryRepository {
  findPublishedSnapshot(): Promise<InciDictionarySnapshot | null>;
}

export type InciNormalizationConfidence = 'HIGH' | 'MEDIUM' | 'NONE';

export type InciMatchTrace =
  | {
      kind: 'CANONICAL_NAME';
      matchedText: string;
    }
  | {
      kind: 'ALIAS';
      aliasId: InciDictionaryAliasId;
      matchedText: string;
    };

export interface InciCanonicalIngredientReference {
  ingredientId: CanonicalIngredientId;
  canonicalName: string;
}

export interface InciAmbiguousCandidate {
  ingredient: InciCanonicalIngredientReference;
  matchedBy: InciMatchTrace;
}

export type InciNormalizationDecision =
  | {
      kind: 'RESOLVED';
      confidence: 'HIGH' | 'MEDIUM';
      ingredient: InciCanonicalIngredientReference;
      matchedBy: InciMatchTrace;
    }
  | {
      kind: 'AMBIGUOUS';
      confidence: 'NONE';
      candidates: readonly InciAmbiguousCandidate[];
    }
  | {
      kind: 'UNRESOLVED';
      confidence: 'NONE';
      reason: 'SOURCE_UNCERTAIN' | 'NO_DICTIONARY_MATCH';
    };

export interface InciNormalizationComponent {
  componentPosition: number;
  lookupText: string;
  lookupKey: string;
  decision: InciNormalizationDecision;
}

export interface InciNormalizedToken {
  sourceToken: InciToken;
  components: readonly InciNormalizationComponent[];
}

export interface InciNormalizationSnapshot {
  schemaVersion: typeof INCI_NORMALIZATION_SCHEMA_VERSION;
  parserVersion: ParsedInci['parserVersion'];
  canonicalizerVersion: typeof INCI_CANONICALIZER_VERSION;
  dictionaryVersion: InciDictionaryVersion;
  normalizerVersion: typeof INCI_LOOKUP_NORMALIZER_VERSION;
  tokens: readonly InciNormalizedToken[];
}

interface IndexedMatch {
  ingredient: InciCanonicalIngredientReference;
  matchedBy: InciMatchTrace;
}

export function normalizeInciLookupText(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

function compareIds(left: CanonicalIngredientId, right: CanonicalIngredientId) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function dictionaryIndex(
  dictionary: InciDictionarySnapshot,
): ReadonlyMap<string, readonly IndexedMatch[]> {
  const index = new Map<string, IndexedMatch[]>();
  const add = (lookupKey: string, match: IndexedMatch) => {
    const matches = index.get(lookupKey) ?? [];
    matches.push(match);
    index.set(lookupKey, matches);
  };

  for (const entry of dictionary.ingredients) {
    const ingredient: InciCanonicalIngredientReference = {
      ingredientId: entry.ingredientId,
      canonicalName: entry.canonicalName,
    };
    add(entry.canonicalLookupKey, {
      ingredient,
      matchedBy: {
        kind: 'CANONICAL_NAME',
        matchedText: entry.canonicalName,
      },
    });
    for (const alias of entry.aliases) {
      add(alias.lookupKey, {
        ingredient,
        matchedBy: {
          kind: 'ALIAS',
          aliasId: alias.aliasId,
          matchedText: alias.aliasText,
        },
      });
    }
  }
  return index;
}

function bestMatchByIngredient(
  matches: readonly IndexedMatch[],
): InciAmbiguousCandidate[] {
  const candidates = new Map<CanonicalIngredientId, IndexedMatch>();
  for (const match of matches) {
    const current = candidates.get(match.ingredient.ingredientId);
    if (!current || match.matchedBy.kind === 'CANONICAL_NAME') {
      candidates.set(match.ingredient.ingredientId, match);
    }
  }
  return [...candidates.values()]
    .sort((left, right) =>
      compareIds(left.ingredient.ingredientId, right.ingredient.ingredientId),
    )
    .map(({ ingredient, matchedBy }) => ({ ingredient, matchedBy }));
}

function matchDecision(
  lookupKey: string,
  index: ReadonlyMap<string, readonly IndexedMatch[]>,
): InciNormalizationDecision {
  const candidates = bestMatchByIngredient(index.get(lookupKey) ?? []);
  if (candidates.length === 0) {
    return {
      kind: 'UNRESOLVED',
      confidence: 'NONE',
      reason: 'NO_DICTIONARY_MATCH',
    };
  }
  if (candidates.length > 1) {
    return { kind: 'AMBIGUOUS', confidence: 'NONE', candidates };
  }

  const match = candidates[0];
  if (!match) {
    throw new Error('INCI candidate selection returned no match');
  }
  return {
    kind: 'RESOLVED',
    confidence: match.matchedBy.kind === 'CANONICAL_NAME' ? 'HIGH' : 'MEDIUM',
    ingredient: match.ingredient,
    matchedBy: match.matchedBy,
  };
}

function componentLookupTexts(token: InciToken): string[] {
  return token.kind === 'CI_PIGMENT'
    ? token.ciNumbers.map((number) => `CI ${number}`)
    : [token.text];
}

export function canonicalizeInci(
  parsed: ParsedInci,
  dictionary: InciDictionarySnapshot,
): InciNormalizationSnapshot {
  const index = dictionaryIndex(dictionary);
  return {
    schemaVersion: INCI_NORMALIZATION_SCHEMA_VERSION,
    parserVersion: parsed.parserVersion,
    canonicalizerVersion: INCI_CANONICALIZER_VERSION,
    dictionaryVersion: dictionary.dictionaryVersion,
    normalizerVersion: dictionary.normalizerVersion,
    tokens: parsed.tokens.map((sourceToken) => ({
      sourceToken,
      components: componentLookupTexts(sourceToken).map(
        (lookupText, componentPosition) => {
          const lookupKey = normalizeInciLookupText(lookupText);
          return {
            componentPosition,
            lookupText,
            lookupKey,
            decision:
              sourceToken.kind === 'UNRESOLVED'
                ? {
                    kind: 'UNRESOLVED',
                    confidence: 'NONE',
                    reason: 'SOURCE_UNCERTAIN',
                  }
                : matchDecision(lookupKey, index),
          };
        },
      ),
    })),
  };
}
