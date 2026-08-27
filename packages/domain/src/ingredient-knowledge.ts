import type { CanonicalIngredientId } from './inci-canonicalization.js';

type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export const INGREDIENT_KNOWLEDGE_SCHEMA_VERSION =
  'ingredient-knowledge-v1' as const;

export type IngredientKnowledgeSnapshotId =
  TaggedString<'IngredientKnowledgeSnapshotId'>;
export type IngredientKnowledgeFactId =
  TaggedString<'IngredientKnowledgeFactId'>;
export type IngredientKnowledgeEvidenceId =
  TaggedString<'IngredientKnowledgeEvidenceId'>;
export type IngredientKnowledgeVersion =
  TaggedString<'IngredientKnowledgeVersion'>;
export type IngredientFunctionCode = TaggedString<'IngredientFunctionCode'>;
export type KnowledgeJurisdiction = TaggedString<'KnowledgeJurisdiction'>;

export type IngredientKnowledgeStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type IngredientKnowledgeConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type IngredientKnowledgeEvidenceType =
  | 'REGULATION'
  | 'REGULATORY_ASSESSMENT'
  | 'OFFICIAL_DATABASE'
  | 'SCIENTIFIC_PUBLICATION'
  | 'MANUFACTURER_DOCUMENT';
export type IngredientKnowledgeEvidenceStance = 'SUPPORTS' | 'CONTRADICTS';

export interface IngredientKnowledgeEvidence {
  evidenceId: IngredientKnowledgeEvidenceId;
  evidenceType: IngredientKnowledgeEvidenceType;
  stance: IngredientKnowledgeEvidenceStance;
  sourceUrl: string;
  checkedAt: Date;
}

export interface IngredientFunctionFactDraft {
  factId: IngredientKnowledgeFactId;
  ingredientId: CanonicalIngredientId;
  functionCode: IngredientFunctionCode;
  jurisdiction: KnowledgeJurisdiction;
  confidence: IngredientKnowledgeConfidence;
  evidence: readonly IngredientKnowledgeEvidence[];
}

export interface IngredientKnowledgeDraft {
  snapshotId: IngredientKnowledgeSnapshotId;
  version: IngredientKnowledgeVersion;
  basedOnSnapshotId: IngredientKnowledgeSnapshotId | null;
  status: 'DRAFT';
  facts: readonly IngredientFunctionFactDraft[];
}

export interface PublishedIngredientFunctionFact extends Omit<
  IngredientFunctionFactDraft,
  'evidence'
> {
  evidence: readonly [
    IngredientKnowledgeEvidence,
    ...IngredientKnowledgeEvidence[],
  ];
}

export interface PublishedIngredientKnowledgeSnapshot {
  schemaVersion: typeof INGREDIENT_KNOWLEDGE_SCHEMA_VERSION;
  snapshotId: IngredientKnowledgeSnapshotId;
  version: IngredientKnowledgeVersion;
  basedOnSnapshotId: IngredientKnowledgeSnapshotId | null;
  status: 'PUBLISHED';
  publishedAt: Date;
  facts: readonly PublishedIngredientFunctionFact[];
}

export type IngredientKnowledgePublicationIssueCode =
  | 'INVALID_VERSION'
  | 'INVALID_PUBLICATION_TIME'
  | 'EMPTY_KNOWLEDGE'
  | 'DUPLICATE_FACT'
  | 'INVALID_FUNCTION_CODE'
  | 'INVALID_JURISDICTION'
  | 'MISSING_SUPPORTING_EVIDENCE'
  | 'DUPLICATE_EVIDENCE_LINK'
  | 'CONFLICTING_EVIDENCE_DEFINITION'
  | 'INVALID_SOURCE_URL'
  | 'INVALID_CHECKED_AT'
  | 'EVIDENCE_CHECKED_AFTER_PUBLICATION';

export interface IngredientKnowledgePublicationIssue {
  code: IngredientKnowledgePublicationIssueCode;
  factId?: IngredientKnowledgeFactId;
  evidenceId?: IngredientKnowledgeEvidenceId;
}

export type PublishIngredientKnowledgeResult =
  | {
      kind: 'PUBLISHED';
      snapshot: PublishedIngredientKnowledgeSnapshot;
    }
  | {
      kind: 'REJECTED';
      issues: readonly IngredientKnowledgePublicationIssue[];
    };

export interface IngredientKnowledgeRepository {
  findPublishedSnapshot(): Promise<PublishedIngredientKnowledgeSnapshot | null>;
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const JURISDICTION_PATTERN = /^[A-Z][A-Z0-9_-]{1,31}$/u;

function hasValidSourceUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function factKey(fact: IngredientFunctionFactDraft): string {
  return [fact.ingredientId, fact.functionCode, fact.jurisdiction].join(
    '\u0000',
  );
}

export function publishIngredientKnowledge(
  draft: IngredientKnowledgeDraft,
  publishedAt: Date,
): PublishIngredientKnowledgeResult {
  const issues: IngredientKnowledgePublicationIssue[] = [];
  if (!VERSION_PATTERN.test(draft.version)) {
    issues.push({ code: 'INVALID_VERSION' });
  }
  if (!isValidDate(publishedAt)) {
    issues.push({ code: 'INVALID_PUBLICATION_TIME' });
  }
  if (draft.facts.length === 0) {
    issues.push({ code: 'EMPTY_KNOWLEDGE' });
  }

  const factIds = new Set<IngredientKnowledgeFactId>();
  const factKeys = new Set<string>();
  const evidenceDefinitions = new Map<
    IngredientKnowledgeEvidenceId,
    Pick<
      IngredientKnowledgeEvidence,
      'evidenceType' | 'sourceUrl' | 'checkedAt'
    >
  >();
  for (const fact of draft.facts) {
    const key = factKey(fact);
    if (factIds.has(fact.factId) || factKeys.has(key)) {
      issues.push({ code: 'DUPLICATE_FACT', factId: fact.factId });
    }
    factIds.add(fact.factId);
    factKeys.add(key);

    if (!CODE_PATTERN.test(fact.functionCode)) {
      issues.push({ code: 'INVALID_FUNCTION_CODE', factId: fact.factId });
    }
    if (!JURISDICTION_PATTERN.test(fact.jurisdiction)) {
      issues.push({ code: 'INVALID_JURISDICTION', factId: fact.factId });
    }
    if (!fact.evidence.some(({ stance }) => stance === 'SUPPORTS')) {
      issues.push({
        code: 'MISSING_SUPPORTING_EVIDENCE',
        factId: fact.factId,
      });
    }

    const evidenceIds = new Set<IngredientKnowledgeEvidenceId>();
    for (const evidence of fact.evidence) {
      if (evidenceIds.has(evidence.evidenceId)) {
        issues.push({
          code: 'DUPLICATE_EVIDENCE_LINK',
          factId: fact.factId,
          evidenceId: evidence.evidenceId,
        });
      }
      evidenceIds.add(evidence.evidenceId);
      const existingEvidence = evidenceDefinitions.get(evidence.evidenceId);
      if (
        existingEvidence &&
        (existingEvidence.evidenceType !== evidence.evidenceType ||
          existingEvidence.sourceUrl !== evidence.sourceUrl ||
          existingEvidence.checkedAt.getTime() !== evidence.checkedAt.getTime())
      ) {
        issues.push({
          code: 'CONFLICTING_EVIDENCE_DEFINITION',
          factId: fact.factId,
          evidenceId: evidence.evidenceId,
        });
      } else if (!existingEvidence) {
        evidenceDefinitions.set(evidence.evidenceId, evidence);
      }
      if (!hasValidSourceUrl(evidence.sourceUrl)) {
        issues.push({
          code: 'INVALID_SOURCE_URL',
          factId: fact.factId,
          evidenceId: evidence.evidenceId,
        });
      }
      if (!isValidDate(evidence.checkedAt)) {
        issues.push({
          code: 'INVALID_CHECKED_AT',
          factId: fact.factId,
          evidenceId: evidence.evidenceId,
        });
      } else if (
        isValidDate(publishedAt) &&
        evidence.checkedAt.getTime() > publishedAt.getTime()
      ) {
        issues.push({
          code: 'EVIDENCE_CHECKED_AFTER_PUBLICATION',
          factId: fact.factId,
          evidenceId: evidence.evidenceId,
        });
      }
    }
  }

  if (issues.length > 0) return { kind: 'REJECTED', issues };

  return {
    kind: 'PUBLISHED',
    snapshot: {
      schemaVersion: INGREDIENT_KNOWLEDGE_SCHEMA_VERSION,
      snapshotId: draft.snapshotId,
      version: draft.version,
      basedOnSnapshotId: draft.basedOnSnapshotId,
      status: 'PUBLISHED',
      publishedAt,
      facts: draft.facts.map((fact) => ({
        ...fact,
        evidence: fact.evidence as [
          IngredientKnowledgeEvidence,
          ...IngredientKnowledgeEvidence[],
        ],
      })),
    },
  };
}
