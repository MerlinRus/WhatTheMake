import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { IsoDateTimeSchema, UuidSchema } from '@wtm/contracts';
import {
  publishIngredientKnowledge,
  type CanonicalIngredientId,
  type IngredientFunctionCode,
  type IngredientKnowledgeDraft,
  type IngredientKnowledgeEvidenceId,
  type IngredientKnowledgeFactId,
  type IngredientKnowledgeSnapshotId,
  type IngredientKnowledgeVersion,
  type InciDictionarySnapshot,
  type KnowledgeJurisdiction,
} from '@wtm/domain';

const ArtifactSchema = Type.Object(
  {
    version: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' }),
    dictionaryVersion: Type.String({ minLength: 1, maxLength: 100 }),
    facts: Type.Array(
      Type.Object(
        {
          ingredientId: UuidSchema,
          canonicalName: Type.String({ minLength: 1, maxLength: 300 }),
          functionCode: Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,63}$' }),
          jurisdiction: Type.String({ pattern: '^[A-Z][A-Z0-9_-]{1,31}$' }),
          confidence: Type.Union([
            Type.Literal('LOW'),
            Type.Literal('MEDIUM'),
            Type.Literal('HIGH'),
          ]),
          evidence: Type.Array(
            Type.Object(
              {
                evidenceType: Type.Union([
                  Type.Literal('REGULATION'),
                  Type.Literal('REGULATORY_ASSESSMENT'),
                  Type.Literal('OFFICIAL_DATABASE'),
                  Type.Literal('SCIENTIFIC_PUBLICATION'),
                  Type.Literal('MANUFACTURER_DOCUMENT'),
                ]),
                stance: Type.Union([
                  Type.Literal('SUPPORTS'),
                  Type.Literal('CONTRADICTS'),
                ]),
                sourceUrl: Type.String({
                  pattern: '^https://',
                  maxLength: 2048,
                }),
                checkedAt: IsoDateTimeSchema,
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 10 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);

function stableId(parts: readonly string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function prepareIngredientKnowledgePublication(
  raw: string,
  dictionary: InciDictionarySnapshot,
  publishedAt: Date,
): IngredientKnowledgeDraft {
  if (Buffer.byteLength(raw, 'utf8') > 256 * 1024)
    throw new Error('Knowledge artifact exceeds 256 KiB');
  const artifact: unknown = JSON.parse(raw);
  if (!Value.Check(ArtifactSchema, artifact))
    throw new Error('Invalid knowledge artifact shape');
  if (artifact.dictionaryVersion !== dictionary.dictionaryVersion)
    throw new Error('Knowledge dictionary version mismatch');
  for (const fact of artifact.facts) {
    if (
      !dictionary.ingredients.some(
        (entry) =>
          entry.ingredientId === fact.ingredientId &&
          entry.canonicalName === fact.canonicalName,
      )
    ) {
      throw new Error(
        'Knowledge ingredient identity does not match the published dictionary',
      );
    }
  }
  const draft: IngredientKnowledgeDraft = {
    snapshotId: stableId([
      'knowledge',
      artifact.version,
    ]) as IngredientKnowledgeSnapshotId,
    version: artifact.version as IngredientKnowledgeVersion,
    basedOnSnapshotId: null,
    status: 'DRAFT',
    facts: artifact.facts.map((fact) => ({
      factId: stableId([
        artifact.version,
        fact.ingredientId,
        fact.functionCode,
        fact.jurisdiction,
      ]) as IngredientKnowledgeFactId,
      ingredientId: fact.ingredientId as CanonicalIngredientId,
      functionCode: fact.functionCode as IngredientFunctionCode,
      jurisdiction: fact.jurisdiction as KnowledgeJurisdiction,
      confidence: fact.confidence,
      evidence: fact.evidence.map((evidence) => ({
        evidenceId: stableId([
          artifact.version,
          evidence.sourceUrl,
          evidence.evidenceType,
          evidence.checkedAt,
        ]) as IngredientKnowledgeEvidenceId,
        ...evidence,
        checkedAt: new Date(evidence.checkedAt),
      })),
    })),
  };
  const validated = publishIngredientKnowledge(draft, publishedAt);
  if (validated.kind === 'REJECTED')
    throw new Error(
      `Invalid knowledge evidence: ${validated.issues.map((issue) => issue.code).join(', ')}`,
    );
  return draft;
}
