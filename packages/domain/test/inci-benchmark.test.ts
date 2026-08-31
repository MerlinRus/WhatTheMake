import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateInciBenchmark,
  type InciBenchmarkAnchor,
  type InciBenchmarkCorpus,
} from '../src/inci-benchmark.js';
import {
  INCI_LOOKUP_NORMALIZER_VERSION,
  normalizeInciLookupText,
  type CanonicalIngredientId,
  type InciDictionaryAliasId,
  type InciDictionarySnapshot,
  type InciDictionaryVersion,
} from '../src/inci-canonicalization.js';

const dictionaryContentSha256 = 'a'.repeat(64);

function dictionary(): InciDictionarySnapshot {
  return {
    dictionaryVersion: 'benchmark-fixture-v1' as InciDictionaryVersion,
    normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
    ingredients: ['Aqua', 'Glycerin', 'Panthenol', 'CI 77499', 'CI 77491'].map(
      (canonicalName, index) => ({
        ingredientId:
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` as CanonicalIngredientId,
        canonicalName,
        canonicalLookupKey: normalizeInciLookupText(canonicalName),
        aliases:
          canonicalName === 'Aqua'
            ? [
                {
                  aliasId:
                    '10000000-0000-4000-8000-000000000001' as InciDictionaryAliasId,
                  aliasText: 'Water',
                  lookupKey: 'water',
                },
              ]
            : canonicalName === 'Glycerin'
              ? [
                  {
                    aliasId:
                      '10000000-0000-4000-8000-000000000002' as InciDictionaryAliasId,
                    aliasText: 'Glycerol',
                    lookupKey: 'glycerol',
                  },
                ]
              : [],
      }),
    ),
  };
}

function sampleAnchors(
  sampleId: string,
  alternateAliases: boolean,
  includeUnresolved: boolean,
): InciBenchmarkAnchor[] {
  const values: Array<Omit<InciBenchmarkAnchor, 'anchorId' | 'sampleId'>> = [
    {
      tokenIndex: 0,
      componentIndex: 0,
      expectedLookupText: alternateAliases ? 'Water' : 'Aqua',
      expectedTokenKind: 'INGREDIENT',
      expectedPresence: 'DECLARED',
      expectedDecision: { kind: 'RESOLVED', canonicalName: 'Aqua' },
    },
    {
      tokenIndex: 1,
      componentIndex: 0,
      expectedLookupText: alternateAliases ? 'Glycerol' : 'Glycerin',
      expectedTokenKind: 'INGREDIENT',
      expectedPresence: 'DECLARED',
      expectedDecision: { kind: 'RESOLVED', canonicalName: 'Glycerin' },
    },
    {
      tokenIndex: 2,
      componentIndex: 0,
      expectedLookupText: 'Panthenol',
      expectedTokenKind: 'INGREDIENT',
      expectedPresence: 'DECLARED',
      expectedDecision: { kind: 'RESOLVED', canonicalName: 'Panthenol' },
    },
    {
      tokenIndex: 3,
      componentIndex: 0,
      expectedLookupText: 'CI 77499',
      expectedTokenKind: 'CI_PIGMENT',
      expectedPresence: 'DECLARED',
      expectedDecision: { kind: 'RESOLVED', canonicalName: 'CI 77499' },
    },
    {
      tokenIndex: 4,
      componentIndex: 0,
      expectedLookupText: 'CI 77491',
      expectedTokenKind: 'CI_PIGMENT',
      expectedPresence: 'MAY_CONTAIN',
      expectedDecision: { kind: 'RESOLVED', canonicalName: 'CI 77491' },
    },
    ...(includeUnresolved
      ? [
          {
            tokenIndex: 5,
            componentIndex: 0,
            expectedLookupText: '???',
            expectedTokenKind: 'UNRESOLVED' as const,
            expectedPresence: 'MAY_CONTAIN' as const,
            expectedDecision: { kind: 'UNRESOLVED' as const },
          },
        ]
      : []),
  ];
  return values.map((value, index) => ({
    ...value,
    sampleId,
    anchorId: `${sampleId}-anchor-${index}`,
  }));
}

function passingCorpus(): InciBenchmarkCorpus {
  const samples = Array.from({ length: 20 }, (_, index) => ({
    sampleId: `sample-${index}`,
    gtin: String(index).padStart(8, '0'),
    productLabel: `Fixture ${index}`,
    sourceUrl: `https://example.test/products/${index}`,
    sourceLastModifiedAt: '2026-08-01T00:00:00.000Z',
    retrievedAt: '2026-08-31T00:00:00.000Z',
    rawIngredientsText: `${index % 2 === 0 ? 'Aqua, Glycerin' : 'Water, Glycerol'}, Panthenol, CI 77499, May Contain: CI 77491${index < 5 ? ', ???' : ''}`,
    qualityFlags: [] as const,
  }));
  return {
    datasetId: 'benchmark-fixture',
    datasetVersion: '2026-08-31',
    dictionaryVersion: 'benchmark-fixture-v1',
    dictionaryContentSha256,
    provenance: {
      label: 'Fixture data',
      uri: 'https://example.test/',
      licenseName: 'Fixture license',
      licenseUri: 'https://example.test/license',
      attribution: 'Fixture attribution.',
      rightsStatus: 'ALLOWED',
    },
    review: {
      annotatedBy: 'annotator-a',
      reviewedBy: 'reviewer-b',
      reviewedAt: '2026-08-31T00:00:00.000Z',
      adjudication: 'All fixture coordinates independently checked.',
    },
    samples,
    anchors: samples.flatMap(({ sampleId }, index) =>
      sampleAnchors(sampleId, index % 2 === 1, index < 5),
    ),
  };
}

function thresholdCorpus(wrongCanonicalCount: number): InciBenchmarkCorpus {
  const corpus = passingCorpus();
  const shortenedSampleIds = new Set(
    corpus.samples.slice(0, 5).map(({ sampleId }) => sampleId),
  );
  corpus.samples = corpus.samples.map((sample) =>
    shortenedSampleIds.has(sample.sampleId)
      ? {
          ...sample,
          rawIngredientsText: sample.rawIngredientsText.replace(
            ', Panthenol',
            '',
          ),
        }
      : sample,
  );
  corpus.anchors = corpus.anchors
    .filter(
      (anchor) =>
        !shortenedSampleIds.has(anchor.sampleId) || anchor.tokenIndex !== 2,
    )
    .map((anchor) =>
      shortenedSampleIds.has(anchor.sampleId) && anchor.tokenIndex > 2
        ? { ...anchor, tokenIndex: anchor.tokenIndex - 1 }
        : anchor,
    );

  let remainingWrongAnchors = wrongCanonicalCount;
  corpus.anchors = corpus.anchors.map((anchor) => {
    if (
      remainingWrongAnchors === 0 ||
      anchor.expectedDecision.kind !== 'RESOLVED'
    ) {
      return anchor;
    }
    remainingWrongAnchors -= 1;
    return {
      ...anchor,
      expectedDecision: {
        kind: 'RESOLVED' as const,
        canonicalName: 'Wrong',
      },
    };
  });
  assert.equal(remainingWrongAnchors, 0);
  return corpus;
}

test('INCI benchmark passes only a complete representative corpus', () => {
  const first = evaluateInciBenchmark(
    passingCorpus(),
    dictionary(),
    dictionaryContentSha256,
  );
  const second = evaluateInciBenchmark(
    passingCorpus(),
    dictionary(),
    dictionaryContentSha256,
  );
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'EVALUATED');
  if (first.kind !== 'EVALUATED') return;
  assert.equal(first.report.gatePassed, true);
  assert.deepEqual(first.report.gateFailures, []);
  assert.deepEqual(first.report.metrics, {
    sampleCount: 20,
    anchorCount: 105,
    correctAnchorCount: 105,
    anchorAccuracy: 1,
    expectedResolutionRate: 100 / 105,
    falseResolutionCount: 0,
    parseRejectionCount: 0,
    unexpectedComponentCount: 0,
    unresolvedAnchorCount: 5,
    mayContainAnchorCount: 25,
    pigmentAnchorCount: 40,
    duplicateOccurrenceCount: 2,
  });
});

test('INCI benchmark rejects incomplete coverage and below-threshold truth', () => {
  const incomplete = passingCorpus();
  incomplete.anchors = incomplete.anchors.slice(1);
  const incompleteResult = evaluateInciBenchmark(
    incomplete,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(incompleteResult.kind, 'EVALUATED');
  if (incompleteResult.kind === 'EVALUATED') {
    assert.equal(incompleteResult.report.gatePassed, false);
    assert.ok(
      incompleteResult.report.gateFailures.includes(
        'INCOMPLETE_COMPONENT_COVERAGE',
      ),
    );
  }

  const inaccurate = passingCorpus();
  inaccurate.anchors = inaccurate.anchors.map((anchor, index) =>
    index < 7 && anchor.expectedDecision.kind === 'RESOLVED'
      ? {
          ...anchor,
          expectedDecision: {
            kind: 'RESOLVED' as const,
            canonicalName: 'Wrong',
          },
        }
      : anchor,
  );
  const inaccurateResult = evaluateInciBenchmark(
    inaccurate,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(inaccurateResult.kind, 'EVALUATED');
  if (inaccurateResult.kind === 'EVALUATED') {
    assert.ok(inaccurateResult.report.metrics.anchorAccuracy < 0.95);
    assert.ok(
      inaccurateResult.report.gateFailures.includes('ACCURACY_BELOW_THRESHOLD'),
    );
  }
});

test('INCI benchmark rejects one missing component above accuracy threshold', () => {
  const corpus = passingCorpus();
  const sample = corpus.samples.at(-1);
  assert.ok(sample);
  corpus.samples = corpus.samples.map((candidate) =>
    candidate.sampleId === sample.sampleId
      ? {
          ...candidate,
          rawIngredientsText: candidate.rawIngredientsText.replace(
            ', May Contain: CI 77491',
            '',
          ),
        }
      : candidate,
  );

  const result = evaluateInciBenchmark(
    corpus,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(result.kind, 'EVALUATED');
  if (result.kind !== 'EVALUATED') return;
  assert.ok(result.report.metrics.anchorAccuracy > 0.95);
  assert.equal(result.report.metrics.unexpectedComponentCount, 0);
  assert.equal(
    result.report.failedAnchors.filter(
      ({ code }) => code === 'MISSING_COMPONENT',
    ).length,
    1,
  );
  assert.ok(
    result.report.gateFailures.includes('INCOMPLETE_COMPONENT_COVERAGE'),
  );
});

test('INCI benchmark accepts exact 0.95 accuracy and resolution thresholds', () => {
  const result = evaluateInciBenchmark(
    thresholdCorpus(5),
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(result.kind, 'EVALUATED');
  if (result.kind !== 'EVALUATED') return;
  assert.equal(result.report.metrics.anchorCount, 100);
  assert.equal(result.report.metrics.anchorAccuracy, 0.95);
  assert.equal(result.report.metrics.expectedResolutionRate, 0.95);
  assert.equal(result.report.gatePassed, true);
});

test('INCI benchmark rejects accuracy below 0.95', () => {
  const result = evaluateInciBenchmark(
    thresholdCorpus(6),
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(result.kind, 'EVALUATED');
  if (result.kind !== 'EVALUATED') return;
  assert.equal(result.report.metrics.anchorAccuracy, 0.94);
  assert.equal(result.report.metrics.expectedResolutionRate, 0.95);
  assert.ok(result.report.gateFailures.includes('ACCURACY_BELOW_THRESHOLD'));
  assert.ok(
    !result.report.gateFailures.includes(
      'EXPECTED_RESOLUTION_COVERAGE_BELOW_THRESHOLD',
    ),
  );
});

test('INCI benchmark rejects expected resolution below 0.95', () => {
  const corpus = thresholdCorpus(5);
  corpus.anchors = corpus.anchors.map((anchor, index) =>
    index === 0
      ? { ...anchor, expectedDecision: { kind: 'UNRESOLVED' as const } }
      : anchor,
  );
  const result = evaluateInciBenchmark(
    corpus,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(result.kind, 'EVALUATED');
  if (result.kind !== 'EVALUATED') return;
  assert.equal(result.report.metrics.anchorAccuracy, 0.95);
  assert.equal(result.report.metrics.expectedResolutionRate, 0.94);
  assert.ok(!result.report.gateFailures.includes('ACCURACY_BELOW_THRESHOLD'));
  assert.ok(
    result.report.gateFailures.includes(
      'EXPECTED_RESOLUTION_COVERAGE_BELOW_THRESHOLD',
    ),
  );
});

test('INCI benchmark rejects duplicate GTIN identities', () => {
  const corpus = passingCorpus();
  const firstSample = corpus.samples[0];
  const secondSample = corpus.samples[1];
  assert.ok(firstSample && secondSample);
  corpus.samples = corpus.samples.map((sample) =>
    sample.sampleId === secondSample.sampleId
      ? { ...sample, gtin: firstSample.gtin }
      : sample,
  );
  const result = evaluateInciBenchmark(
    corpus,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(result.kind, 'INVALID_CORPUS');
  if (result.kind !== 'INVALID_CORPUS') return;
  assert.deepEqual(result.issues, [
    { code: 'DUPLICATE_GTIN', sampleId: secondSample.sampleId },
  ]);
});

test('INCI benchmark rejects false resolution and invalid review/version data', () => {
  const falseResolution = passingCorpus();
  falseResolution.anchors = falseResolution.anchors.map((anchor, index) =>
    index === 0
      ? { ...anchor, expectedDecision: { kind: 'UNRESOLVED' as const } }
      : anchor,
  );
  const falseResult = evaluateInciBenchmark(
    falseResolution,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(falseResult.kind, 'EVALUATED');
  if (falseResult.kind === 'EVALUATED') {
    assert.equal(falseResult.report.metrics.falseResolutionCount, 1);
    assert.ok(falseResult.report.gateFailures.includes('FALSE_RESOLUTION'));
  }

  const invalid = passingCorpus();
  invalid.dictionaryVersion = 'wrong-version';
  invalid.review.reviewedBy = invalid.review.annotatedBy;
  invalid.anchors = [...invalid.anchors, { ...invalid.anchors[0]! }];
  invalid.dictionaryContentSha256 = 'b'.repeat(64);
  const invalidResult = evaluateInciBenchmark(
    invalid,
    dictionary(),
    dictionaryContentSha256,
  );
  assert.equal(invalidResult.kind, 'INVALID_CORPUS');
  if (invalidResult.kind === 'INVALID_CORPUS') {
    assert.deepEqual(
      new Set(invalidResult.issues.map(({ code }) => code)),
      new Set([
        'DICTIONARY_VERSION_MISMATCH',
        'DICTIONARY_CHECKSUM_MISMATCH',
        'REVIEWER_NOT_INDEPENDENT',
        'DUPLICATE_ANCHOR_ID',
        'DUPLICATE_ANCHOR_COORDINATE',
      ]),
    );
  }
});
