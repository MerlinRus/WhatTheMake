import type { Pool } from 'pg';

import {
  INGREDIENT_KNOWLEDGE_SCHEMA_VERSION,
  type CanonicalIngredientId,
  type IngredientFunctionCode,
  type IngredientKnowledgeConfidence,
  type IngredientKnowledgeEvidence,
  type IngredientKnowledgeEvidenceId,
  type IngredientKnowledgeEvidenceStance,
  type IngredientKnowledgeEvidenceType,
  type IngredientKnowledgeFactId,
  type IngredientKnowledgeRepository,
  type IngredientKnowledgeSnapshotId,
  type IngredientKnowledgeVersion,
  type KnowledgeJurisdiction,
  type PublishedIngredientFunctionFact,
  type PublishedIngredientKnowledgeSnapshot,
} from '@wtm/domain';

interface PublishedKnowledgeRow {
  snapshot_id: string;
  knowledge_version: string;
  based_on_snapshot_id: string | null;
  published_at: Date;
  fact_id: string;
  ingredient_id: string;
  function_code: string;
  jurisdiction: string;
  confidence: IngredientKnowledgeConfidence;
  evidence_id: string;
  evidence_type: IngredientKnowledgeEvidenceType;
  stance: IngredientKnowledgeEvidenceStance;
  source_url: string;
  checked_at: Date;
}

interface MutablePublishedFact extends Omit<
  PublishedIngredientFunctionFact,
  'evidence'
> {
  evidence: IngredientKnowledgeEvidence[];
}

function requireEvidence(
  fact: MutablePublishedFact,
): PublishedIngredientFunctionFact {
  if (fact.evidence.length === 0) {
    throw new Error('Published ingredient knowledge fact has no evidence');
  }
  if (!fact.evidence.some(({ stance }) => stance === 'SUPPORTS')) {
    throw new Error(
      'Published ingredient knowledge fact has no supporting evidence',
    );
  }
  return {
    ...fact,
    evidence: fact.evidence as [
      IngredientKnowledgeEvidence,
      ...IngredientKnowledgeEvidence[],
    ],
  };
}

export function createPostgresIngredientKnowledgeRepository(
  pool: Pool,
): IngredientKnowledgeRepository {
  return {
    async findPublishedSnapshot(): Promise<PublishedIngredientKnowledgeSnapshot | null> {
      const result = await pool.query<PublishedKnowledgeRow>(`
        SELECT
          snapshot.id AS snapshot_id,
          snapshot.version AS knowledge_version,
          snapshot.based_on_snapshot_id,
          snapshot.published_at,
          fact.id AS fact_id,
          fact.ingredient_id,
          fact.function_code,
          fact.jurisdiction,
          fact.confidence,
          evidence.id AS evidence_id,
          evidence.evidence_type,
          link.stance,
          evidence.source_url,
          evidence.checked_at
        FROM wtm_ingredient_knowledge_snapshots AS snapshot
        JOIN wtm_ingredient_function_facts AS fact
          ON fact.snapshot_id = snapshot.id
        JOIN wtm_ingredient_fact_evidence_links AS link
          ON link.snapshot_id = fact.snapshot_id
          AND link.fact_id = fact.id
        JOIN wtm_ingredient_fact_evidence AS evidence
          ON evidence.snapshot_id = link.snapshot_id
          AND evidence.id = link.evidence_id
        WHERE snapshot.status = 'PUBLISHED'
        ORDER BY
          fact.ingredient_id,
          fact.function_code,
          fact.jurisdiction,
          fact.id,
          link.stance DESC,
          evidence.id
      `);
      const first = result.rows[0];
      if (!first) return null;

      const facts = new Map<string, MutablePublishedFact>();
      for (const row of result.rows) {
        let fact = facts.get(row.fact_id);
        if (!fact) {
          fact = {
            factId: row.fact_id as IngredientKnowledgeFactId,
            ingredientId: row.ingredient_id as CanonicalIngredientId,
            functionCode: row.function_code as IngredientFunctionCode,
            jurisdiction: row.jurisdiction as KnowledgeJurisdiction,
            confidence: row.confidence,
            evidence: [],
          };
          facts.set(row.fact_id, fact);
        }
        fact.evidence.push({
          evidenceId: row.evidence_id as IngredientKnowledgeEvidenceId,
          evidenceType: row.evidence_type,
          stance: row.stance,
          sourceUrl: row.source_url,
          checkedAt: row.checked_at,
        });
      }

      return {
        schemaVersion: INGREDIENT_KNOWLEDGE_SCHEMA_VERSION,
        snapshotId: first.snapshot_id as IngredientKnowledgeSnapshotId,
        version: first.knowledge_version as IngredientKnowledgeVersion,
        basedOnSnapshotId:
          first.based_on_snapshot_id === null
            ? null
            : (first.based_on_snapshot_id as IngredientKnowledgeSnapshotId),
        status: 'PUBLISHED',
        publishedAt: first.published_at,
        facts: [...facts.values()].map(requireEvidence),
      };
    },
  };
}
