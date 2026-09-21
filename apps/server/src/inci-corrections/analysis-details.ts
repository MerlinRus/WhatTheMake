import type { InciAnalysisDetails } from '@wtm/contracts';
import type {
  InciNormalizationSnapshot,
  ParsedInci,
  PublishedIngredientKnowledgeSnapshot,
} from '@wtm/domain';

/** Read-only projection; never infers concentration, safety or formula effects. */
export function ingredientAnalysisDetails(
  parsed: ParsedInci,
  normalization: InciNormalizationSnapshot | null,
  knowledge: PublishedIngredientKnowledgeSnapshot | null,
): InciAnalysisDetails {
  const rows = normalization
    ? normalization.tokens.flatMap(({ sourceToken, components }) =>
        components.map((component) => ({ sourceToken, component })),
      )
    : parsed.tokens.map((sourceToken) => ({ sourceToken, component: null }));
  const factsByIngredient = new Map<
    string,
    PublishedIngredientKnowledgeSnapshot['facts'][number][]
  >();
  for (const fact of knowledge?.facts ?? []) {
    const facts = factsByIngredient.get(fact.ingredientId) ?? [];
    facts.push(fact);
    factsByIngredient.set(fact.ingredientId, facts);
  }
  for (const facts of factsByIngredient.values()) {
    facts.sort(
      (left, right) =>
        Number(right.evidence.some(({ stance }) => stance === 'CONTRADICTS')) -
        Number(left.evidence.some(({ stance }) => stance === 'CONTRADICTS')),
    );
  }
  return {
    knowledge: knowledge
      ? {
          version: knowledge.version,
          publishedAt: knowledge.publishedAt.toISOString(),
        }
      : null,
    omittedComponentCount: Math.max(0, rows.length - 200),
    ingredients: rows.slice(0, 200).map(({ sourceToken, component }) => {
      const decision = component?.decision;
      const facts =
        decision?.kind === 'RESOLVED'
          ? (factsByIngredient.get(decision.ingredient.ingredientId) ?? [])
          : [];
      return {
        position: sourceToken.position,
        componentPosition: component?.componentPosition ?? 0,
        sourceText: sourceToken.sourceText.slice(0, 1000),
        sourceTextTruncated: sourceToken.sourceText.length > 1000,
        presence: sourceToken.presence,
        uncertain:
          sourceToken.kind === 'UNRESOLVED' ||
          sourceToken.uncertaintyReasons.length > 0,
        identity:
          decision?.kind === 'RESOLVED'
            ? { kind: 'RESOLVED', ingredient: decision.ingredient }
            : decision?.kind === 'AMBIGUOUS'
              ? {
                  kind: 'AMBIGUOUS',
                  candidates: decision.candidates
                    .slice(0, 10)
                    .map(({ ingredient }) => ingredient),
                  omittedCandidateCount: Math.max(
                    0,
                    decision.candidates.length - 10,
                  ),
                }
              : { kind: 'UNRESOLVED' },
        omittedFunctionCount: Math.max(0, facts.length - 5),
        functions: facts.slice(0, 5).map((fact) => ({
          functionCode: fact.functionCode,
          jurisdiction: fact.jurisdiction,
          confidence: fact.confidence,
          conflicting: fact.evidence.some(
            ({ stance }) => stance === 'CONTRADICTS',
          ),
          omittedEvidenceCount: Math.max(0, fact.evidence.length - 5),
          // Prioritize contrary evidence so a bounded display cannot hide conflicts.
          evidence: [...fact.evidence]
            .sort(
              (left, right) =>
                Number(right.stance === 'CONTRADICTS') -
                Number(left.stance === 'CONTRADICTS'),
            )
            .slice(0, 5)
            .map((evidence) => ({
              stance: evidence.stance,
              evidenceType: evidence.evidenceType,
              sourceUrl: evidence.sourceUrl,
              checkedAt: evidence.checkedAt.toISOString(),
            })),
        })),
      };
    }),
  };
}
