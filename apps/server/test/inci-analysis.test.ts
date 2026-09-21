import assert from 'node:assert/strict';
import test from 'node:test';

import { Value } from 'typebox/value';
import { InciAnalysisDetailsSchema } from '@wtm/contracts';
import {
  canonicalizeInci,
  parseInci,
  type InciDictionarySnapshot,
  type PublishedIngredientKnowledgeSnapshot,
} from '@wtm/domain';

import { ingredientAnalysisDetails } from '../src/inci-corrections/analysis-details.js';

const dictionary = {
  dictionaryVersion: 'test-v1',
  normalizerVersion: 'inci-lookup-v1',
  ingredients: [
    {
      ingredientId: 'aqua',
      canonicalName: 'Aqua',
      canonicalLookupKey: 'aqua',
      aliases: [],
    },
    {
      ingredientId: 'iron',
      canonicalName: 'CI 77499',
      canonicalLookupKey: 'ci 77499',
      aliases: [],
    },
    ...['First Wax', 'Second Wax'].map((name, index) => ({
      ingredientId: `wax-${index}`,
      canonicalName: name,
      canonicalLookupKey: name.toLowerCase(),
      aliases: [
        { aliasId: `alias-${index}`, aliasText: 'Wax', lookupKey: 'wax' },
      ],
    })),
  ],
} as InciDictionarySnapshot;

const knowledge = {
  schemaVersion: 'ingredient-knowledge-v1',
  snapshotId: 'snapshot-1',
  version: 'knowledge-v1',
  basedOnSnapshotId: null,
  status: 'PUBLISHED',
  publishedAt: new Date('2026-09-20T00:00:00.000Z'),
  facts: [
    {
      factId: 'fact-1',
      ingredientId: 'aqua',
      functionCode: 'SOLVENT',
      jurisdiction: 'EU',
      confidence: 'HIGH',
      evidence: [
        {
          evidenceId: 'evidence-1',
          evidenceType: 'OFFICIAL_DATABASE',
          stance: 'SUPPORTS',
          sourceUrl: 'https://example.org/test-source',
          checkedAt: new Date('2026-09-19T00:00:00.000Z'),
        },
      ],
    },
  ],
} as PublishedIngredientKnowledgeSnapshot;

function analyze(
  text: string,
  snapshot: PublishedIngredientKnowledgeSnapshot | null = knowledge,
  withDictionary = true,
) {
  const parsed = parseInci(text);
  assert.equal(parsed.kind, 'PARSED');
  const result = ingredientAnalysisDetails(
    parsed,
    withDictionary ? canonicalizeInci(parsed, dictionary) : null,
    snapshot,
  );
  assert.equal(Value.Check(InciAnalysisDetailsSchema, result), true);
  return result;
}

test('ingredient analysis attributes only published facts to an exact identity', () => {
  const result = analyze('Aqua, Unknown');
  assert.deepEqual(result.knowledge, {
    version: 'knowledge-v1',
    publishedAt: '2026-09-20T00:00:00.000Z',
  });
  assert.deepEqual(result.ingredients[0]?.identity, {
    kind: 'RESOLVED',
    ingredient: { ingredientId: 'aqua', canonicalName: 'Aqua' },
  });
  assert.equal(result.ingredients[0]?.functions[0]?.functionCode, 'SOLVENT');
  assert.equal(
    result.ingredients[0]?.functions[0]?.evidence[0]?.sourceUrl,
    'https://example.org/test-source',
  );
  assert.equal(result.ingredients[1]?.identity.kind, 'UNRESOLVED');
  assert.deepEqual(result.ingredients[1]?.functions, []);
});

test('missing knowledge or dictionary never produces invented functions', () => {
  const noKnowledge = analyze('Aqua', null);
  assert.equal(noKnowledge.knowledge, null);
  assert.equal(noKnowledge.ingredients[0]?.identity.kind, 'RESOLVED');
  assert.deepEqual(noKnowledge.ingredients[0]?.functions, []);
  const noDictionary = analyze('Aqua', knowledge, false);
  assert.equal(noDictionary.ingredients[0]?.identity.kind, 'UNRESOLVED');
  assert.deepEqual(noDictionary.ingredients[0]?.functions, []);
});

test('conditional ingredients and ambiguous identities retain their uncertainty', () => {
  const result = analyze('Aqua, Wax, May contain: CI 77499');
  assert.equal(result.ingredients[0]?.presence, 'DECLARED');
  const wax = result.ingredients[1];
  assert.equal(wax?.identity.kind, 'AMBIGUOUS');
  if (wax?.identity.kind === 'AMBIGUOUS')
    assert.equal(wax.identity.candidates.length, 2);
  assert.deepEqual(wax?.functions, []);
  assert.equal(result.ingredients[2]?.presence, 'MAY_CONTAIN');
  assert.equal(result.ingredients[2]?.position, 2);
  const noisy = analyze('Aq?ua');
  assert.equal(noisy.ingredients[0]?.uncertain, true);
  assert.deepEqual(noisy.ingredients[0]?.functions, []);
});

test('conflicting evidence is visible even beyond the evidence display limit', () => {
  const fact = knowledge.facts[0];
  assert.ok(fact);
  const source = fact.evidence[0];
  assert.ok(source);
  const conflicting = {
    ...knowledge,
    facts: [
      {
        ...fact,
        evidence: [
          source,
          ...Array.from({ length: 5 }, () => source),
          {
            ...source,
            stance: 'CONTRADICTS' as const,
            sourceUrl: 'https://example.org/contrary-source',
          },
        ],
      },
    ],
  } as PublishedIngredientKnowledgeSnapshot;
  const result = analyze('Aqua', conflicting);
  const projected = result.ingredients[0]?.functions[0];
  assert.equal(projected?.conflicting, true);
  assert.equal(projected?.evidence[0]?.stance, 'CONTRADICTS');
  assert.equal(projected?.evidence.length, 5);
  assert.equal(projected?.omittedEvidenceCount, 2);
});

test('ingredient output is bounded with explicit omissions and source truncation', () => {
  const result = analyze(Array.from({ length: 205 }, () => 'Aqua').join(', '));
  assert.equal(result.ingredients.length, 200);
  assert.equal(result.omittedComponentCount, 5);
  const long = analyze('A'.repeat(1001));
  assert.equal(long.ingredients[0]?.sourceText.length, 1000);
  assert.equal(long.ingredients[0]?.sourceTextTruncated, true);
});
