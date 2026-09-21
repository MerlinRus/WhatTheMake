import type { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';

import {
  INGREDIENT_KNOWLEDGE_SCHEMA_VERSION,
  publishIngredientKnowledge,
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
import { withTransaction } from './transaction.js';

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
    async publishInitialSnapshot(input) {
      const validated = publishIngredientKnowledge(
        input.draft,
        input.publishedAt,
      );
      if (validated.kind !== 'PUBLISHED')
        throw new Error('Invalid ingredient knowledge draft');
      if (
        input.draft.basedOnSnapshotId !== null ||
        input.draft.facts.length > 100 ||
        input.draft.facts.some((fact) => fact.evidence.length > 10)
      ) {
        throw new Error(
          'Initial publication requires a bounded standalone snapshot',
        );
      }
      const expectedFacts = input.draft.facts
        .map((fact) => ({
          id: fact.factId,
          ingredient_id: fact.ingredientId,
          function_code: fact.functionCode,
          jurisdiction: fact.jurisdiction,
          confidence: fact.confidence,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const expectedLinks = input.draft.facts
        .flatMap((fact) =>
          fact.evidence.map((evidence) => ({
            fact_id: fact.factId,
            evidence_id: evidence.evidenceId,
            evidence_type: evidence.evidenceType,
            stance: evidence.stance,
            source_url: evidence.sourceUrl,
            checked_at: evidence.checkedAt.toISOString(),
          })),
        )
        .sort(
          (left, right) =>
            left.fact_id.localeCompare(right.fact_id) ||
            left.evidence_id.localeCompare(right.evidence_id),
        );
      return withTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [928042026]);
        await client.query('SELECT pg_advisory_xact_lock($1)', [928042027]);
        const report = (
          kind:
            | 'READY'
            | 'PUBLISHED'
            | 'ALREADY_PUBLISHED'
            | 'VERSION_CONFLICT'
            | 'ACTIVE_SNAPSHOT_CONFLICT',
        ) => ({
          kind,
          version: input.draft.version,
          factCount: input.draft.facts.length,
        });
        const existing = await client.query<{
          id: string;
          status: string;
          based_on_snapshot_id: string | null;
        }>(
          'SELECT id, status, based_on_snapshot_id FROM wtm_ingredient_knowledge_snapshots WHERE version = $1',
          [input.draft.version],
        );
        const old = existing.rows[0];
        if (old) {
          const facts = await client.query<(typeof expectedFacts)[number]>(
            'SELECT id, ingredient_id, function_code, jurisdiction, confidence FROM wtm_ingredient_function_facts WHERE snapshot_id = $1 ORDER BY id',
            [old.id],
          );
          const evidence = await client.query<
            Omit<(typeof expectedLinks)[number], 'checked_at'> & {
              checked_at: Date;
            }
          >(
            'SELECT link.fact_id, link.evidence_id, evidence.evidence_type, link.stance, evidence.source_url, evidence.checked_at FROM wtm_ingredient_fact_evidence_links link JOIN wtm_ingredient_fact_evidence evidence ON evidence.id = link.evidence_id AND evidence.snapshot_id = link.snapshot_id WHERE link.snapshot_id = $1 ORDER BY link.fact_id, link.evidence_id',
            [old.id],
          );
          const links = evidence.rows.map((row) => ({
            ...row,
            checked_at: row.checked_at.toISOString(),
          }));
          return report(
            old.status === 'PUBLISHED' &&
              old.id === input.draft.snapshotId &&
              old.based_on_snapshot_id === null &&
              isDeepStrictEqual(facts.rows, expectedFacts) &&
              isDeepStrictEqual(links, expectedLinks)
              ? 'ALREADY_PUBLISHED'
              : 'VERSION_CONFLICT',
          );
        }
        const active = await client.query(
          "SELECT id FROM wtm_ingredient_knowledge_snapshots WHERE status = 'PUBLISHED'",
        );
        if (active.rowCount) return report('ACTIVE_SNAPSHOT_CONFLICT');
        const ingredientIds = [
          ...new Set(input.draft.facts.map((fact) => fact.ingredientId)),
        ];
        const known = await client.query(
          "SELECT entry.ingredient_id FROM wtm_inci_dictionary_entries entry JOIN wtm_inci_dictionary_snapshots snapshot ON snapshot.id = entry.snapshot_id WHERE snapshot.status = 'PUBLISHED' AND entry.ingredient_id = ANY($1::uuid[]) AND snapshot.version = $2",
          [ingredientIds, input.dictionaryVersion],
        );
        if (known.rowCount !== ingredientIds.length)
          throw new Error('Ingredient is not in the published dictionary');
        if (input.dryRun) return report('READY');
        await client.query(
          "INSERT INTO wtm_ingredient_knowledge_snapshots(id, version, status) VALUES ($1, $2, 'DRAFT')",
          [input.draft.snapshotId, input.draft.version],
        );
        const insertedEvidence = new Set<string>();
        for (const fact of input.draft.facts) {
          await client.query(
            'INSERT INTO wtm_ingredient_function_facts(id, snapshot_id, ingredient_id, function_code, jurisdiction, confidence) VALUES ($1,$2,$3,$4,$5,$6)',
            [
              fact.factId,
              input.draft.snapshotId,
              fact.ingredientId,
              fact.functionCode,
              fact.jurisdiction,
              fact.confidence,
            ],
          );
          for (const evidence of fact.evidence) {
            if (!insertedEvidence.has(evidence.evidenceId)) {
              await client.query(
                'INSERT INTO wtm_ingredient_fact_evidence(id, snapshot_id, evidence_type, source_url, checked_at) VALUES ($1,$2,$3,$4,$5)',
                [
                  evidence.evidenceId,
                  input.draft.snapshotId,
                  evidence.evidenceType,
                  evidence.sourceUrl,
                  evidence.checkedAt,
                ],
              );
              insertedEvidence.add(evidence.evidenceId);
            }
            await client.query(
              'INSERT INTO wtm_ingredient_fact_evidence_links(snapshot_id,fact_id,evidence_id,stance) VALUES ($1,$2,$3,$4)',
              [
                input.draft.snapshotId,
                fact.factId,
                evidence.evidenceId,
                evidence.stance,
              ],
            );
          }
        }
        await client.query(
          "UPDATE wtm_ingredient_knowledge_snapshots SET status = 'PUBLISHED', published_at = $2 WHERE id = $1",
          [input.draft.snapshotId, input.publishedAt],
        );
        return report('PUBLISHED');
      });
    },
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
