import {
  canonicalizeInci,
  INCI_CANONICALIZER_VERSION,
  INCI_LOOKUP_NORMALIZER_VERSION,
  normalizeInciLookupText,
  type InciDictionarySnapshot,
  type InciNormalizationDecision,
} from './inci-canonicalization.js';
import {
  INCI_PARSER_VERSION,
  parseInci,
  type InciPresence,
  type InciToken,
} from './inci.js';

export const INCI_BENCHMARK_SCHEMA_VERSION =
  'inci-benchmark-report-v1' as const;
export const INCI_BENCHMARK_MIN_SAMPLES = 20;
export const INCI_BENCHMARK_MIN_ANCHORS = 100;
export const INCI_BENCHMARK_MIN_ACCURACY = 0.95;
export const INCI_BENCHMARK_MIN_EXPECTED_RESOLUTION_RATE = 0.95;
export const INCI_BENCHMARK_MIN_UNRESOLVED_ANCHORS = 5;
export const INCI_BENCHMARK_MIN_MAY_CONTAIN_ANCHORS = 5;
export const INCI_BENCHMARK_MIN_PIGMENT_ANCHORS = 5;
export const INCI_BENCHMARK_MIN_DUPLICATE_OCCURRENCES = 2;

export type InciBenchmarkQualityFlag =
  | 'DISCLAIMER_TEXT'
  | 'TRUNCATED_TEXT'
  | 'LEADING_PRODUCT_CODE'
  | 'STALE_SOURCE';

export interface InciBenchmarkSample {
  sampleId: string;
  gtin: string;
  productLabel: string;
  sourceUrl: string;
  sourceLastModifiedAt: string;
  retrievedAt: string;
  rawIngredientsText: string;
  qualityFlags: readonly InciBenchmarkQualityFlag[];
}

export type InciBenchmarkExpectedDecision =
  { kind: 'RESOLVED'; canonicalName: string } | { kind: 'UNRESOLVED' };

export interface InciBenchmarkAnchor {
  anchorId: string;
  sampleId: string;
  tokenIndex: number;
  componentIndex: number;
  expectedLookupText: string;
  expectedTokenKind: InciToken['kind'];
  expectedPresence: InciPresence;
  expectedDecision: InciBenchmarkExpectedDecision;
}

export interface InciBenchmarkReview {
  annotatedBy: string;
  reviewedBy: string;
  reviewedAt: string;
  adjudication: string;
}

export interface InciBenchmarkProvenance {
  label: string;
  uri: string;
  licenseName: string;
  licenseUri: string;
  attribution: string;
  rightsStatus: 'ALLOWED';
}

export interface InciBenchmarkCorpus {
  datasetId: string;
  datasetVersion: string;
  dictionaryVersion: string;
  dictionaryContentSha256: string;
  provenance: InciBenchmarkProvenance;
  review: InciBenchmarkReview;
  samples: readonly InciBenchmarkSample[];
  anchors: readonly InciBenchmarkAnchor[];
}

export type InciBenchmarkCorpusIssueCode =
  | 'EMPTY_DATASET_ID'
  | 'EMPTY_DATASET_VERSION'
  | 'DUPLICATE_SAMPLE_ID'
  | 'DUPLICATE_GTIN'
  | 'DUPLICATE_ANCHOR_ID'
  | 'DUPLICATE_ANCHOR_COORDINATE'
  | 'UNKNOWN_SAMPLE'
  | 'INVALID_COORDINATE'
  | 'EMPTY_LOOKUP_TEXT'
  | 'EMPTY_CANONICAL_NAME'
  | 'EMPTY_REVIEW_METADATA'
  | 'EMPTY_PROVENANCE'
  | 'REVIEWER_NOT_INDEPENDENT'
  | 'DICTIONARY_VERSION_MISMATCH'
  | 'DICTIONARY_CHECKSUM_MISMATCH';

export interface InciBenchmarkCorpusIssue {
  code: InciBenchmarkCorpusIssueCode;
  sampleId?: string;
  anchorId?: string;
}

export type InciBenchmarkAnchorFailureCode =
  | 'MISSING_COMPONENT'
  | 'UNEXPECTED_COMPONENT'
  | 'WRONG_LOOKUP_TEXT'
  | 'WRONG_TOKEN_KIND'
  | 'WRONG_PRESENCE'
  | 'WRONG_DECISION'
  | 'WRONG_CANONICAL_INGREDIENT';

export interface InciBenchmarkAnchorFailure {
  anchorId: string;
  sampleId: string;
  code: InciBenchmarkAnchorFailureCode;
  actualDecisionKind: InciNormalizationDecision['kind'] | 'MISSING';
  actualCanonicalName?: string;
  actualLookupText?: string;
  actualTokenKind?: InciToken['kind'];
}

export type InciBenchmarkGateFailureCode =
  | 'INSUFFICIENT_SAMPLES'
  | 'INSUFFICIENT_ANCHORS'
  | 'INSUFFICIENT_UNRESOLVED_STRATUM'
  | 'INSUFFICIENT_MAY_CONTAIN_STRATUM'
  | 'INSUFFICIENT_PIGMENT_STRATUM'
  | 'INSUFFICIENT_DUPLICATE_STRATUM'
  | 'INCOMPLETE_COMPONENT_COVERAGE'
  | 'EXPECTED_RESOLUTION_COVERAGE_BELOW_THRESHOLD'
  | 'ACCURACY_BELOW_THRESHOLD'
  | 'FALSE_RESOLUTION'
  | 'PARSE_REJECTION';

export interface InciBenchmarkReport {
  schemaVersion: typeof INCI_BENCHMARK_SCHEMA_VERSION;
  datasetId: string;
  datasetVersion: string;
  parserVersion: typeof INCI_PARSER_VERSION;
  canonicalizerVersion: typeof INCI_CANONICALIZER_VERSION;
  dictionaryVersion: string;
  dictionaryContentSha256: string;
  normalizerVersion: typeof INCI_LOOKUP_NORMALIZER_VERSION;
  thresholds: {
    minimumSamples: number;
    minimumAnchors: number;
    minimumAccuracy: number;
    minimumExpectedResolutionRate: number;
    minimumUnresolvedAnchors: number;
    minimumMayContainAnchors: number;
    minimumPigmentAnchors: number;
    minimumDuplicateOccurrences: number;
    maximumFalseResolutions: 0;
    maximumParseRejections: 0;
  };
  metrics: {
    sampleCount: number;
    anchorCount: number;
    correctAnchorCount: number;
    anchorAccuracy: number;
    expectedResolutionRate: number;
    falseResolutionCount: number;
    parseRejectionCount: number;
    unexpectedComponentCount: number;
    unresolvedAnchorCount: number;
    mayContainAnchorCount: number;
    pigmentAnchorCount: number;
    duplicateOccurrenceCount: number;
  };
  failedAnchors: readonly InciBenchmarkAnchorFailure[];
  rejectedSampleIds: readonly string[];
  gateFailures: readonly InciBenchmarkGateFailureCode[];
  gatePassed: boolean;
}

export type EvaluateInciBenchmarkResult =
  | { kind: 'INVALID_CORPUS'; issues: readonly InciBenchmarkCorpusIssue[] }
  | { kind: 'EVALUATED'; report: InciBenchmarkReport };

function validateCorpus(
  corpus: InciBenchmarkCorpus,
  dictionary: InciDictionarySnapshot,
  dictionaryContentSha256: string,
): InciBenchmarkCorpusIssue[] {
  const issues: InciBenchmarkCorpusIssue[] = [];
  if (corpus.datasetId.trim() === '') issues.push({ code: 'EMPTY_DATASET_ID' });
  if (corpus.datasetVersion.trim() === '') {
    issues.push({ code: 'EMPTY_DATASET_VERSION' });
  }
  if (corpus.dictionaryVersion !== dictionary.dictionaryVersion) {
    issues.push({ code: 'DICTIONARY_VERSION_MISMATCH' });
  }
  if (
    !/^[0-9a-f]{64}$/u.test(dictionaryContentSha256) ||
    corpus.dictionaryContentSha256 !== dictionaryContentSha256
  ) {
    issues.push({ code: 'DICTIONARY_CHECKSUM_MISMATCH' });
  }
  if (
    corpus.provenance.label.trim() === '' ||
    corpus.provenance.uri.trim() === '' ||
    corpus.provenance.licenseName.trim() === '' ||
    corpus.provenance.licenseUri.trim() === '' ||
    corpus.provenance.attribution.trim() === ''
  ) {
    issues.push({ code: 'EMPTY_PROVENANCE' });
  }
  if (
    corpus.review.annotatedBy.trim() === '' ||
    corpus.review.reviewedBy.trim() === '' ||
    corpus.review.reviewedAt.trim() === '' ||
    corpus.review.adjudication.trim() === ''
  ) {
    issues.push({ code: 'EMPTY_REVIEW_METADATA' });
  }
  if (corpus.review.annotatedBy === corpus.review.reviewedBy) {
    issues.push({ code: 'REVIEWER_NOT_INDEPENDENT' });
  }

  const sampleIds = new Set<string>();
  const gtins = new Set<string>();
  for (const sample of corpus.samples) {
    if (sampleIds.has(sample.sampleId)) {
      issues.push({ code: 'DUPLICATE_SAMPLE_ID', sampleId: sample.sampleId });
    }
    sampleIds.add(sample.sampleId);
    if (gtins.has(sample.gtin)) {
      issues.push({ code: 'DUPLICATE_GTIN', sampleId: sample.sampleId });
    }
    gtins.add(sample.gtin);
  }

  const anchorIds = new Set<string>();
  const anchorCoordinates = new Set<string>();
  for (const anchor of corpus.anchors) {
    if (anchorIds.has(anchor.anchorId)) {
      issues.push({ code: 'DUPLICATE_ANCHOR_ID', anchorId: anchor.anchorId });
    }
    anchorIds.add(anchor.anchorId);
    const coordinate = `${anchor.sampleId}\u0000${anchor.tokenIndex}\u0000${anchor.componentIndex}`;
    if (anchorCoordinates.has(coordinate)) {
      issues.push({
        code: 'DUPLICATE_ANCHOR_COORDINATE',
        sampleId: anchor.sampleId,
        anchorId: anchor.anchorId,
      });
    }
    anchorCoordinates.add(coordinate);
    if (!sampleIds.has(anchor.sampleId)) {
      issues.push({
        code: 'UNKNOWN_SAMPLE',
        sampleId: anchor.sampleId,
        anchorId: anchor.anchorId,
      });
    }
    if (
      !Number.isSafeInteger(anchor.tokenIndex) ||
      anchor.tokenIndex < 0 ||
      !Number.isSafeInteger(anchor.componentIndex) ||
      anchor.componentIndex < 0
    ) {
      issues.push({ code: 'INVALID_COORDINATE', anchorId: anchor.anchorId });
    }
    if (anchor.expectedLookupText.trim() === '') {
      issues.push({ code: 'EMPTY_LOOKUP_TEXT', anchorId: anchor.anchorId });
    }
    if (
      anchor.expectedDecision.kind === 'RESOLVED' &&
      anchor.expectedDecision.canonicalName.trim() === ''
    ) {
      issues.push({ code: 'EMPTY_CANONICAL_NAME', anchorId: anchor.anchorId });
    }
  }
  return issues;
}

function decisionName(decision: InciNormalizationDecision): string | undefined {
  return decision.kind === 'RESOLVED'
    ? decision.ingredient.canonicalName
    : undefined;
}

function decisionDetails(decision: InciNormalizationDecision): {
  actualDecisionKind: InciNormalizationDecision['kind'];
  actualCanonicalName?: string;
} {
  const canonicalName = decisionName(decision);
  return {
    actualDecisionKind: decision.kind,
    ...(canonicalName === undefined
      ? {}
      : { actualCanonicalName: canonicalName }),
  };
}

function sameDecision(
  expected: InciBenchmarkExpectedDecision,
  actual: InciNormalizationDecision,
): boolean {
  if (expected.kind !== actual.kind) return false;
  return (
    expected.kind === 'UNRESOLVED' ||
    (actual.kind === 'RESOLVED' &&
      actual.ingredient.canonicalName === expected.canonicalName)
  );
}

export function evaluateInciBenchmark(
  corpus: InciBenchmarkCorpus,
  dictionary: InciDictionarySnapshot,
  dictionaryContentSha256: string,
): EvaluateInciBenchmarkResult {
  const issues = validateCorpus(corpus, dictionary, dictionaryContentSha256);
  if (issues.length > 0) return { kind: 'INVALID_CORPUS', issues };

  const sampleResults = new Map<
    string,
    ReturnType<typeof canonicalizeInci> | null
  >();
  const rejectedSampleIds: string[] = [];
  for (const sample of corpus.samples) {
    const parsed = parseInci(sample.rawIngredientsText);
    if (parsed.kind === 'REJECTED') {
      rejectedSampleIds.push(sample.sampleId);
      sampleResults.set(sample.sampleId, null);
      continue;
    }
    sampleResults.set(sample.sampleId, canonicalizeInci(parsed, dictionary));
  }

  const failedAnchors: InciBenchmarkAnchorFailure[] = [];
  let falseResolutionCount = 0;
  const expectedCoordinates = new Set(
    corpus.anchors.map(
      (anchor) =>
        `${anchor.sampleId}\u0000${anchor.tokenIndex}\u0000${anchor.componentIndex}`,
    ),
  );
  for (const anchor of corpus.anchors) {
    const snapshot = sampleResults.get(anchor.sampleId) ?? null;
    const token = snapshot?.tokens[anchor.tokenIndex];
    const component = token?.components[anchor.componentIndex];
    const actual =
      token && component
        ? {
            presence: token.sourceToken.presence,
            tokenKind: token.sourceToken.kind,
            lookupText: component.lookupText,
            decision: component.decision,
          }
        : undefined;
    if (!actual) {
      failedAnchors.push({
        anchorId: anchor.anchorId,
        sampleId: anchor.sampleId,
        code: 'MISSING_COMPONENT',
        actualDecisionKind: 'MISSING',
      });
      continue;
    }
    if (
      anchor.expectedDecision.kind === 'UNRESOLVED' &&
      actual.decision.kind === 'RESOLVED'
    ) {
      falseResolutionCount += 1;
    }
    if (actual.lookupText !== anchor.expectedLookupText) {
      failedAnchors.push({
        anchorId: anchor.anchorId,
        sampleId: anchor.sampleId,
        code: 'WRONG_LOOKUP_TEXT',
        ...decisionDetails(actual.decision),
        actualLookupText: actual.lookupText,
        actualTokenKind: actual.tokenKind,
      });
      continue;
    }
    if (actual.tokenKind !== anchor.expectedTokenKind) {
      failedAnchors.push({
        anchorId: anchor.anchorId,
        sampleId: anchor.sampleId,
        code: 'WRONG_TOKEN_KIND',
        ...decisionDetails(actual.decision),
        actualLookupText: actual.lookupText,
        actualTokenKind: actual.tokenKind,
      });
      continue;
    }
    if (actual.presence !== anchor.expectedPresence) {
      failedAnchors.push({
        anchorId: anchor.anchorId,
        sampleId: anchor.sampleId,
        code: 'WRONG_PRESENCE',
        ...decisionDetails(actual.decision),
        actualLookupText: actual.lookupText,
        actualTokenKind: actual.tokenKind,
      });
      continue;
    }
    if (anchor.expectedDecision.kind !== actual.decision.kind) {
      failedAnchors.push({
        anchorId: anchor.anchorId,
        sampleId: anchor.sampleId,
        code: 'WRONG_DECISION',
        ...decisionDetails(actual.decision),
        actualLookupText: actual.lookupText,
        actualTokenKind: actual.tokenKind,
      });
      continue;
    }
    if (!sameDecision(anchor.expectedDecision, actual.decision)) {
      failedAnchors.push({
        anchorId: anchor.anchorId,
        sampleId: anchor.sampleId,
        code: 'WRONG_CANONICAL_INGREDIENT',
        ...decisionDetails(actual.decision),
        actualLookupText: actual.lookupText,
        actualTokenKind: actual.tokenKind,
      });
    }
  }

  let unexpectedComponentCount = 0;
  for (const [sampleId, snapshot] of sampleResults) {
    if (!snapshot) continue;
    for (const [tokenIndex, token] of snapshot.tokens.entries()) {
      for (const [componentIndex, component] of token.components.entries()) {
        const coordinate = `${sampleId}\u0000${tokenIndex}\u0000${componentIndex}`;
        if (expectedCoordinates.has(coordinate)) continue;
        unexpectedComponentCount += 1;
        failedAnchors.push({
          anchorId: `@unexpected:${sampleId}:${tokenIndex}:${componentIndex}`,
          sampleId,
          code: 'UNEXPECTED_COMPONENT',
          ...decisionDetails(component.decision),
          actualLookupText: component.lookupText,
          actualTokenKind: token.sourceToken.kind,
        });
      }
    }
  }

  const expectedAnchorFailureCount = failedAnchors.filter(
    ({ code }) => code !== 'UNEXPECTED_COMPONENT',
  ).length;
  const correctAnchorCount = corpus.anchors.length - expectedAnchorFailureCount;
  const anchorAccuracy =
    corpus.anchors.length === 0
      ? 0
      : correctAnchorCount / corpus.anchors.length;
  const unresolvedAnchorCount = corpus.anchors.filter(
    ({ expectedDecision }) => expectedDecision.kind === 'UNRESOLVED',
  ).length;
  const expectedResolutionRate =
    corpus.anchors.length === 0
      ? 0
      : (corpus.anchors.length - unresolvedAnchorCount) / corpus.anchors.length;
  const mayContainAnchorCount = corpus.anchors.filter(
    ({ expectedPresence }) => expectedPresence === 'MAY_CONTAIN',
  ).length;
  const pigmentAnchorCount = corpus.anchors.filter(
    ({ expectedTokenKind }) => expectedTokenKind === 'CI_PIGMENT',
  ).length;
  const resolvedOccurrencesByName = new Map<
    string,
    { sampleIds: Set<string>; lookupKeys: Set<string> }
  >();
  for (const anchor of corpus.anchors) {
    if (anchor.expectedDecision.kind !== 'RESOLVED') continue;
    const occurrence = resolvedOccurrencesByName.get(
      anchor.expectedDecision.canonicalName,
    ) ?? { sampleIds: new Set<string>(), lookupKeys: new Set<string>() };
    occurrence.sampleIds.add(anchor.sampleId);
    occurrence.lookupKeys.add(
      normalizeInciLookupText(anchor.expectedLookupText),
    );
    resolvedOccurrencesByName.set(
      anchor.expectedDecision.canonicalName,
      occurrence,
    );
  }
  const duplicateOccurrenceCount = [
    ...resolvedOccurrencesByName.values(),
  ].filter(
    ({ sampleIds, lookupKeys }) => sampleIds.size >= 2 && lookupKeys.size >= 2,
  ).length;
  const gateFailures: InciBenchmarkGateFailureCode[] = [];
  if (corpus.samples.length < INCI_BENCHMARK_MIN_SAMPLES) {
    gateFailures.push('INSUFFICIENT_SAMPLES');
  }
  if (corpus.anchors.length < INCI_BENCHMARK_MIN_ANCHORS) {
    gateFailures.push('INSUFFICIENT_ANCHORS');
  }
  if (unresolvedAnchorCount < INCI_BENCHMARK_MIN_UNRESOLVED_ANCHORS) {
    gateFailures.push('INSUFFICIENT_UNRESOLVED_STRATUM');
  }
  if (mayContainAnchorCount < INCI_BENCHMARK_MIN_MAY_CONTAIN_ANCHORS) {
    gateFailures.push('INSUFFICIENT_MAY_CONTAIN_STRATUM');
  }
  if (pigmentAnchorCount < INCI_BENCHMARK_MIN_PIGMENT_ANCHORS) {
    gateFailures.push('INSUFFICIENT_PIGMENT_STRATUM');
  }
  if (duplicateOccurrenceCount < INCI_BENCHMARK_MIN_DUPLICATE_OCCURRENCES) {
    gateFailures.push('INSUFFICIENT_DUPLICATE_STRATUM');
  }
  const hasMissingComponent = failedAnchors.some(
    ({ code }) => code === 'MISSING_COMPONENT',
  );
  if (hasMissingComponent || unexpectedComponentCount > 0) {
    gateFailures.push('INCOMPLETE_COMPONENT_COVERAGE');
  }
  if (expectedResolutionRate < INCI_BENCHMARK_MIN_EXPECTED_RESOLUTION_RATE) {
    gateFailures.push('EXPECTED_RESOLUTION_COVERAGE_BELOW_THRESHOLD');
  }
  if (anchorAccuracy < INCI_BENCHMARK_MIN_ACCURACY) {
    gateFailures.push('ACCURACY_BELOW_THRESHOLD');
  }
  if (falseResolutionCount > 0) gateFailures.push('FALSE_RESOLUTION');
  if (rejectedSampleIds.length > 0) gateFailures.push('PARSE_REJECTION');

  return {
    kind: 'EVALUATED',
    report: {
      schemaVersion: INCI_BENCHMARK_SCHEMA_VERSION,
      datasetId: corpus.datasetId,
      datasetVersion: corpus.datasetVersion,
      parserVersion: INCI_PARSER_VERSION,
      canonicalizerVersion: INCI_CANONICALIZER_VERSION,
      dictionaryVersion: dictionary.dictionaryVersion,
      dictionaryContentSha256,
      normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
      thresholds: {
        minimumSamples: INCI_BENCHMARK_MIN_SAMPLES,
        minimumAnchors: INCI_BENCHMARK_MIN_ANCHORS,
        minimumAccuracy: INCI_BENCHMARK_MIN_ACCURACY,
        minimumExpectedResolutionRate:
          INCI_BENCHMARK_MIN_EXPECTED_RESOLUTION_RATE,
        minimumUnresolvedAnchors: INCI_BENCHMARK_MIN_UNRESOLVED_ANCHORS,
        minimumMayContainAnchors: INCI_BENCHMARK_MIN_MAY_CONTAIN_ANCHORS,
        minimumPigmentAnchors: INCI_BENCHMARK_MIN_PIGMENT_ANCHORS,
        minimumDuplicateOccurrences: INCI_BENCHMARK_MIN_DUPLICATE_OCCURRENCES,
        maximumFalseResolutions: 0,
        maximumParseRejections: 0,
      },
      metrics: {
        sampleCount: corpus.samples.length,
        anchorCount: corpus.anchors.length,
        correctAnchorCount,
        anchorAccuracy,
        expectedResolutionRate,
        falseResolutionCount,
        parseRejectionCount: rejectedSampleIds.length,
        unexpectedComponentCount,
        unresolvedAnchorCount,
        mayContainAnchorCount,
        pigmentAnchorCount,
        duplicateOccurrenceCount,
      },
      failedAnchors,
      rejectedSampleIds,
      gateFailures,
      gatePassed: gateFailures.length === 0,
    },
  };
}
