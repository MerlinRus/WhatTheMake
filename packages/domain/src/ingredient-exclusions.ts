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
    parsed.tokens.map((t) => normalizeInciLookupText(t.text)),
  );
  const present = new Set(
    avoided.filter((name) => rawKeys.has(normalizeInciLookupText(name))),
  );
  if (dictionary === null) return { present: [...present], uncertain: true };

  const normalized = canonicalizeInci(parsed, dictionary);
  const components = normalized.tokens.flatMap((token) => token.components);
  const ids = new Set(
    components.flatMap(({ decision }) =>
      decision.kind === 'RESOLVED' ? [decision.ingredient.ingredientId] : [],
    ),
  );
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
      else if (ids.has(decision.ingredient.ingredientId)) present.add(name);
    }
  }
  return { present: [...present], uncertain };
}
