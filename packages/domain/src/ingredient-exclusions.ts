import {
  canonicalizeInci,
  normalizeInciLookupText,
  type InciDictionarySnapshot,
} from './inci-canonicalization.js';
import { parseInci } from './inci.js';

/** A missing or unresolved component cannot establish absence. */
export function assessIngredientExclusions(
  formulaText: string | null,
  avoided: readonly string[],
  dictionary: InciDictionarySnapshot | null,
): { present: string[]; uncertain: boolean } {
  if (avoided.length === 0) return { present: [], uncertain: false };
  if (formulaText === null) return { present: [], uncertain: true };
  const parsed = parseInci(formulaText);
  if (parsed.kind !== 'PARSED' || parsed.tokens.length === 0) {
    return { present: [], uncertain: true };
  }
  const rawKeys = new Set(
    parsed.tokens
      .filter((token) => token.presence === 'DECLARED')
      .map((token) => normalizeInciLookupText(token.text)),
  );
  const present = new Set(
    avoided.filter((name) => rawKeys.has(normalizeInciLookupText(name))),
  );
  if (dictionary === null) return { present: [...present], uncertain: true };

  const normalized = canonicalizeInci(parsed, dictionary);
  const components = normalized.tokens.flatMap((token) => token.components);
  const declaredIds = new Set<string>();
  const conditionalIds = new Set<string>();
  for (const token of normalized.tokens) {
    const target =
      token.sourceToken.presence === 'MAY_CONTAIN'
        ? conditionalIds
        : declaredIds;
    for (const { decision } of token.components) {
      if (decision.kind === 'RESOLVED')
        target.add(decision.ingredient.ingredientId);
    }
  }
  const conditionalMatches = new Set<string>();
  let uncertain =
    normalized.tokens.some(
      (token) => token.sourceToken.uncertaintyReasons.length > 0,
    ) || components.some(({ decision }) => decision.kind !== 'RESOLVED');
  for (const name of avoided) {
    const exclusion = parseInci(name);
    if (exclusion.kind !== 'PARSED' || exclusion.tokens.length !== 1) {
      uncertain = true;
      continue;
    }
    const decisions = canonicalizeInci(exclusion, dictionary).tokens.flatMap(
      (t) => t.components.map((c) => c.decision),
    );
    for (const decision of decisions) {
      if (decision.kind !== 'RESOLVED') uncertain = true;
      else if (declaredIds.has(decision.ingredient.ingredientId))
        present.add(name);
      else if (conditionalIds.has(decision.ingredient.ingredientId))
        conditionalMatches.add(name);
    }
  }
  return {
    present: [...present],
    // A possible component is neither confirmed present nor confirmed absent.
    // An explicit declaration of the same exclusion still establishes presence.
    uncertain:
      uncertain || [...conditionalMatches].some((name) => !present.has(name)),
  };
}
