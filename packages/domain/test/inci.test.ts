import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCI_PARSER_VERSION,
  MAX_INCI_SOURCE_LENGTH,
  parseInci,
  type InciToken,
} from '../src/inci.js';
import {
  canonicalizeInci,
  INCI_CANONICALIZER_VERSION,
  INCI_LOOKUP_NORMALIZER_VERSION,
  INCI_NORMALIZATION_SCHEMA_VERSION,
  normalizeInciLookupText,
  type CanonicalIngredientId,
  type InciDictionaryAliasId,
  type InciDictionarySnapshot,
  type InciDictionaryVersion,
} from '../src/inci-canonicalization.js';
import {
  INGREDIENT_KNOWLEDGE_SCHEMA_VERSION,
  publishIngredientKnowledge,
  type IngredientFunctionCode,
  type IngredientKnowledgeDraft,
  type IngredientKnowledgeEvidenceId,
  type IngredientKnowledgeFactId,
  type IngredientKnowledgeSnapshotId,
  type IngredientKnowledgeVersion,
  type KnowledgeJurisdiction,
} from '../src/ingredient-knowledge.js';

interface ExpectedToken {
  sourceText: string;
  text?: string;
  kind: InciToken['kind'];
  presence?: InciToken['presence'];
  uncertaintyReasons?: InciToken['uncertaintyReasons'];
  ciNumbers?: readonly string[];
}

const goldenCorpus: Array<{
  name: string;
  source: string;
  expected: readonly ExpectedToken[];
}> = [
  {
    name: 'heading and ordinary separators',
    source: 'INGREDIENTS: Aqua, Glycerin; Panthenol\nCarnauba Wax',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      { sourceText: 'Glycerin', kind: 'INGREDIENT' },
      { sourceText: 'Panthenol', kind: 'INGREDIENT' },
      { sourceText: 'Carnauba Wax', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'commas inside balanced parentheses stay in one token',
    source: 'Aqua (Water, Eau), Acrylates Copolymer, Tocopherol',
    expected: [
      { sourceText: 'Aqua (Water, Eau)', kind: 'INGREDIENT' },
      { sourceText: 'Acrylates Copolymer', kind: 'INGREDIENT' },
      { sourceText: 'Tocopherol', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'commas inside other balanced grouping stay in one token',
    source: 'Aqua [Water, Eau], Extract {Leaf, Root}, Tocopherol',
    expected: [
      { sourceText: 'Aqua [Water, Eau]', kind: 'INGREDIENT' },
      { sourceText: 'Extract {Leaf, Root}', kind: 'INGREDIENT' },
      { sourceText: 'Tocopherol', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'OCR separator variants preserve order',
    source: 'Aqua • Glycerin · Panthenol | Tocopherol',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      { sourceText: 'Glycerin', kind: 'INGREDIENT' },
      { sourceText: 'Panthenol', kind: 'INGREDIENT' },
      { sourceText: 'Tocopherol', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'CI pigments retain their source grouping',
    source: 'Iron Oxides, CI 77491/77492/CI 77499, CI77007',
    expected: [
      { sourceText: 'Iron Oxides', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77491/77492/CI 77499',
        kind: 'CI_PIGMENT',
        ciNumbers: ['77491', '77492', '77499'],
      },
      {
        sourceText: 'CI77007',
        kind: 'CI_PIGMENT',
        ciNumbers: ['77007'],
      },
    ],
  },
  {
    name: 'may contain changes presence without becoming an ingredient',
    source: 'Aqua, May Contain (+/-): CI 77491, CI 77499',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77491',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77491'],
      },
      {
        sourceText: 'CI 77499',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77499'],
      },
    ],
  },
  {
    name: 'standalone plus-minus marker changes following presence',
    source: 'Aqua; (+/-): CI 77491; CI 77492',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77491',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77491'],
      },
      {
        sourceText: 'CI 77492',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77492'],
      },
    ],
  },
  {
    name: 'square-wrapped may contain clause omits wrapper syntax only',
    source: 'Aqua, [May contain: CI 77491, CI 77499]',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77491',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77491'],
      },
      {
        sourceText: 'CI 77499',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77499'],
      },
    ],
  },
  {
    name: 'unbalanced grouping does not swallow following tokens',
    source: 'Aqua (Water, Glycerin, Panthenol',
    expected: [
      {
        sourceText: 'Aqua (Water',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['UNBALANCED_GROUPING'],
      },
      { sourceText: 'Glycerin', kind: 'INGREDIENT' },
      { sourceText: 'Panthenol', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'OCR garbage remains visible as unresolved tokens',
    source: 'Aqua, �, GLYCER?N, C1 77499, ???',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: '�',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['OCR_NOISE', 'LOW_INFORMATION'],
      },
      {
        sourceText: 'GLYCER?N',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['OCR_NOISE'],
      },
      {
        sourceText: 'C1 77499',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['OCR_NOISE'],
      },
      {
        sourceText: '???',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['OCR_NOISE', 'LOW_INFORMATION'],
      },
    ],
  },
  {
    name: 'concentration-looking text is retained, not interpreted',
    source: 'Salicylic Acid 2%, Aqua',
    expected: [
      { sourceText: 'Salicylic Acid 2%', kind: 'INGREDIENT' },
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'numeric locants remain inside ingredient names',
    source: 'Aqua, 1,2-Hexanediol, 2-Oleamido-1,3-Octadecanediol, BHT',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      { sourceText: '1,2-Hexanediol', kind: 'INGREDIENT' },
      {
        sourceText: '2-Oleamido-1,3-Octadecanediol',
        kind: 'INGREDIENT',
      },
      { sourceText: 'BHT', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'OCR-spaced numeric locant remains one visible token',
    source: 'Aqua, 2-OLEAMIDO-1, 3 OCTADECANEDIOL, BHT',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: '2-OLEAMIDO-1, 3 OCTADECANEDIOL',
        kind: 'INGREDIENT',
      },
      { sourceText: 'BHT', kind: 'INGREDIENT' },
    ],
  },
  {
    name: 'bilingual conditional clause extracts labeled CI pigments',
    source:
      'Oleic Acid. May Contain/Peut Contenir(+/-): Iron Oxides (CI 77491, CI 77492, CI 77499), Titanium Dioxide (CI 77891)',
    expected: [
      { sourceText: 'Oleic Acid', kind: 'INGREDIENT' },
      {
        sourceText: 'Iron Oxides (CI 77491, CI 77492, CI 77499)',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77491', '77492', '77499'],
      },
      {
        sourceText: 'Titanium Dioxide (CI 77891)',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77891'],
      },
    ],
  },
  {
    name: 'confusable CI inside a pigment label remains unresolved',
    source: 'May Contain: Black 2 (Cl 77266), CI 77499',
    expected: [
      {
        sourceText: 'Black 2 (Cl 77266)',
        kind: 'UNRESOLVED',
        presence: 'MAY_CONTAIN',
        uncertaintyReasons: ['OCR_NOISE'],
      },
      {
        sourceText: 'CI 77499',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77499'],
      },
    ],
  },
  {
    name: 'adjacent pigment sentences remain separate components',
    source: 'Iron Oxides (CI 77499). Black 2 (Cl 77266)',
    expected: [
      {
        sourceText: 'Iron Oxides (CI 77499)',
        kind: 'CI_PIGMENT',
        ciNumbers: ['77499'],
      },
      {
        sourceText: 'Black 2 (Cl 77266)',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['OCR_NOISE'],
      },
    ],
  },
  {
    name: 'terminal punctuation is excluded from a labeled CI pigment',
    source: 'May Contain: Uitramarines(CI 77007).',
    expected: [
      {
        sourceText: 'Uitramarines(CI 77007)',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77007'],
      },
    ],
  },
  {
    name: 'slash bilingual marker and closing punctuation are syntax only',
    source:
      'Aqua, [May Contain/Peut Contenir/+/-: CI 77491, CI 77499 / Iron Oxides].',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77491',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77491'],
      },
      {
        sourceText: 'CI 77499 / Iron Oxides',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77499'],
      },
    ],
  },
  {
    name: 'conditional wrapper closes before following disclaimer text',
    source:
      'Aqua, [May Contain: CI 77491, CI 77492, CI 77499]. Please be aware that lists change.',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77491',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77491'],
      },
      {
        sourceText: 'CI 77492',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77492'],
      },
      {
        sourceText: 'CI 77499',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77499'],
      },
      {
        sourceText: 'Please be aware that lists change.',
        kind: 'UNRESOLVED',
        presence: 'MAY_CONTAIN',
        uncertaintyReasons: ['NON_INCI_TEXT'],
      },
    ],
  },
  {
    name: 'conditional wrapper closes before following formula metadata',
    source: 'Aqua, [May Contain: CI 77499] (F.I.L. D123456/1)',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      {
        sourceText: 'CI 77499',
        kind: 'CI_PIGMENT',
        presence: 'MAY_CONTAIN',
        ciNumbers: ['77499'],
      },
      {
        sourceText: '(F.I.L. D123456/1)',
        kind: 'UNRESOLVED',
        presence: 'MAY_CONTAIN',
        uncertaintyReasons: ['NON_INCI_TEXT'],
      },
    ],
  },
  {
    name: 'formula metadata is isolated and never treated as INCI',
    source:
      'G2004066 - Aqua, Citric Acid (F.I.L. B210585/1), CI 77510/Ferric Ferrocyanide FIL D26393/4Please be aware that lists change.',
    expected: [
      { sourceText: 'Aqua', kind: 'INGREDIENT' },
      { sourceText: 'Citric Acid', kind: 'INGREDIENT' },
      {
        sourceText: '(F.I.L. B210585/1)',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['NON_INCI_TEXT'],
      },
      {
        sourceText: 'CI 77510/Ferric Ferrocyanide',
        kind: 'CI_PIGMENT',
        ciNumbers: ['77510'],
      },
      {
        sourceText: 'FIL D26393/4',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['NON_INCI_TEXT'],
      },
      {
        sourceText: 'Please be aware that lists change.',
        kind: 'UNRESOLVED',
        uncertaintyReasons: ['NON_INCI_TEXT'],
      },
    ],
  },
];

function comparableToken(token: InciToken): ExpectedToken {
  return {
    sourceText: token.sourceText,
    text: token.text,
    kind: token.kind,
    presence: token.presence,
    uncertaintyReasons: token.uncertaintyReasons,
    ...(token.kind === 'CI_PIGMENT' ? { ciNumbers: token.ciNumbers } : {}),
  };
}

test('INCI golden corpus preserves tokens, semantics, and source spans', () => {
  for (const sample of goldenCorpus) {
    const result = parseInci(sample.source);
    assert.equal(result.kind, 'PARSED', sample.name);
    if (result.kind !== 'PARSED') continue;
    assert.equal(result.parserVersion, INCI_PARSER_VERSION);
    assert.equal(result.tokens.length, sample.expected.length, sample.name);

    for (const [position, expected] of sample.expected.entries()) {
      const token = result.tokens[position];
      assert.ok(token, `${sample.name}: missing token ${position}`);
      assert.deepEqual(
        comparableToken(token),
        {
          ...expected,
          text: expected.text ?? expected.sourceText.replace(/\s+/gu, ' '),
          presence: expected.presence ?? 'DECLARED',
          uncertaintyReasons: expected.uncertaintyReasons ?? [],
        },
        `${sample.name}: token ${position}`,
      );
      assert.equal(token.position, position, sample.name);
      assert.equal(
        sample.source.slice(token.sourceSpan.start, token.sourceSpan.end),
        token.sourceText,
        `${sample.name}: source span ${position}`,
      );
      assert.equal(
        Object.hasOwn(token, 'concentration'),
        false,
        `${sample.name}: concentration must not be inferred`,
      );
    }
  }
});

test('INCI parser rejects oversized OCR text with a stable reason', () => {
  assert.deepEqual(parseInci('A'.repeat(MAX_INCI_SOURCE_LENGTH + 1)), {
    kind: 'REJECTED',
    parserVersion: INCI_PARSER_VERSION,
    reason: 'SOURCE_TOO_LARGE',
    sourceLength: MAX_INCI_SOURCE_LENGTH + 1,
    maxSourceLength: MAX_INCI_SOURCE_LENGTH,
  });
});

test(
  'INCI parser handles a maximum-size numeric locant run linearly',
  { timeout: 30_000 },
  () => {
    const source = `A${'1,'.repeat((MAX_INCI_SOURCE_LENGTH - 4) / 2)}1-X`;
    assert.equal(source.length, MAX_INCI_SOURCE_LENGTH);

    const parsed = parseInci(source);
    assert.equal(parsed.kind, 'PARSED');
    if (parsed.kind !== 'PARSED') return;
    assert.equal(parsed.tokens.length, 1);
    assert.deepEqual(parsed.tokens[0]?.sourceSpan, {
      start: 0,
      end: source.length,
    });
  },
);

test(
  'INCI parser handles maximum-size leading whitespace linearly',
  { timeout: 5_000 },
  () => {
    const source = `${' '.repeat(MAX_INCI_SOURCE_LENGTH - 1)}A`;
    assert.equal(source.length, MAX_INCI_SOURCE_LENGTH);

    const parsed = parseInci(source);
    assert.equal(parsed.kind, 'PARSED');
    if (parsed.kind !== 'PARSED') return;
    assert.equal(parsed.tokens.length, 1);
    assert.deepEqual(parsed.tokens[0]?.sourceSpan, {
      start: MAX_INCI_SOURCE_LENGTH - 1,
      end: MAX_INCI_SOURCE_LENGTH,
    });
  },
);

function deterministicRandom(): () => number {
  let state = 0x1ac1_2026;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

test('INCI parser is deterministic and span-safe across malformed OCR fuzz', () => {
  const next = deterministicRandom();
  const alphabet = [
    'A',
    'q',
    'Ж',
    'é',
    '7',
    ' ',
    '\t',
    '\n',
    ',',
    ';',
    '•',
    '|',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '/',
    '-',
    '±',
    '?',
    '�',
    '\u0000',
    '\ud800',
    '🖤',
  ] as const;

  for (let sample = 0; sample < 1_000; sample += 1) {
    const length = next() % 160;
    let source = '';
    for (let index = 0; index < length; index += 1) {
      source += alphabet[next() % alphabet.length] ?? '';
    }

    const first = parseInci(source);
    const second = parseInci(source);
    assert.deepEqual(first, second, `sample ${sample}`);
    assert.equal(first.kind, 'PARSED');
    if (first.kind !== 'PARSED') continue;

    let previousEnd = 0;
    for (const [position, token] of first.tokens.entries()) {
      assert.equal(token.position, position);
      assert.ok(token.sourceSpan.start >= previousEnd);
      assert.ok(token.sourceSpan.end > token.sourceSpan.start);
      assert.ok(token.sourceSpan.end <= source.length);
      assert.equal(
        source.slice(token.sourceSpan.start, token.sourceSpan.end),
        token.sourceText,
      );
      assert.ok(token.text.length > 0);
      assert.equal(
        token.kind === 'UNRESOLVED',
        token.uncertaintyReasons.length > 0,
      );
      previousEnd = token.sourceSpan.end;
    }
  }
});

test('separator property preserves generated ingredient order', () => {
  const next = deterministicRandom();
  const ingredients = [
    'Aqua',
    'Glycerin',
    'Aqua (Water, Eau)',
    'Copernicia Cerifera Wax',
    'CI 77499',
    'CI 77491/77492',
  ] as const;
  const separators = [', ', '; ', '\n', ' • ', ' · ', ' | '] as const;

  for (let sample = 0; sample < 500; sample += 1) {
    const expected = Array.from(
      { length: 1 + (next() % 20) },
      () => ingredients[next() % ingredients.length] ?? 'Aqua',
    );
    const source = expected
      .map((ingredient, index) =>
        index === 0
          ? ingredient
          : `${separators[next() % separators.length]}${ingredient}`,
      )
      .join('');
    const result = parseInci(source);
    assert.equal(result.kind, 'PARSED');
    if (result.kind === 'PARSED') {
      assert.deepEqual(
        result.tokens.map((token) => token.sourceText),
        expected,
      );
    }
  }
});

const ingredientIds = {
  aqua: '00000000-0000-4000-8000-000000000001',
  beeswax: '00000000-0000-4000-8000-000000000002',
  carnauba: '00000000-0000-4000-8000-000000000003',
  pigment77491: '00000000-0000-4000-8000-000000000004',
  pigment77499: '00000000-0000-4000-8000-000000000005',
} as const;

function ingredientId(
  value: (typeof ingredientIds)[keyof typeof ingredientIds],
): CanonicalIngredientId {
  return value as CanonicalIngredientId;
}

function aliasId(value: string): InciDictionaryAliasId {
  return value as InciDictionaryAliasId;
}

function fixtureDictionary(): InciDictionarySnapshot {
  return {
    dictionaryVersion: 'fixture-2026.08.27' as InciDictionaryVersion,
    normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
    ingredients: [
      {
        ingredientId: ingredientId(ingredientIds.aqua),
        canonicalName: 'Aqua',
        canonicalLookupKey: normalizeInciLookupText('Aqua'),
        aliases: [
          {
            aliasId: aliasId('10000000-0000-4000-8000-000000000001'),
            aliasText: 'Water',
            lookupKey: normalizeInciLookupText('Water'),
          },
        ],
      },
      {
        ingredientId: ingredientId(ingredientIds.beeswax),
        canonicalName: 'Cera Alba',
        canonicalLookupKey: normalizeInciLookupText('Cera Alba'),
        aliases: [
          {
            aliasId: aliasId('10000000-0000-4000-8000-000000000002'),
            aliasText: 'Wax',
            lookupKey: normalizeInciLookupText('Wax'),
          },
        ],
      },
      {
        ingredientId: ingredientId(ingredientIds.carnauba),
        canonicalName: 'Copernicia Cerifera Cera',
        canonicalLookupKey: normalizeInciLookupText('Copernicia Cerifera Cera'),
        aliases: [
          {
            aliasId: aliasId('10000000-0000-4000-8000-000000000003'),
            aliasText: 'Wax',
            lookupKey: normalizeInciLookupText('Wax'),
          },
        ],
      },
      {
        ingredientId: ingredientId(ingredientIds.pigment77491),
        canonicalName: 'CI 77491',
        canonicalLookupKey: normalizeInciLookupText('CI 77491'),
        aliases: [],
      },
      {
        ingredientId: ingredientId(ingredientIds.pigment77499),
        canonicalName: 'CI 77499',
        canonicalLookupKey: normalizeInciLookupText('CI 77499'),
        aliases: [],
      },
    ],
  };
}

test('INCI canonicalization is traceable, conservative, and versioned', () => {
  const source = 'Aqua, ＷＡＴＥＲ, Wax, Waterr, C1 77499, CI 77491/77499';
  const parsed = parseInci(source);
  assert.equal(parsed.kind, 'PARSED');
  if (parsed.kind !== 'PARSED') return;

  const snapshot = canonicalizeInci(parsed, fixtureDictionary());
  assert.equal(snapshot.schemaVersion, INCI_NORMALIZATION_SCHEMA_VERSION);
  assert.equal(snapshot.parserVersion, INCI_PARSER_VERSION);
  assert.equal(snapshot.canonicalizerVersion, INCI_CANONICALIZER_VERSION);
  assert.equal(snapshot.dictionaryVersion, 'fixture-2026.08.27');
  assert.equal(snapshot.normalizerVersion, INCI_LOOKUP_NORMALIZER_VERSION);
  assert.equal(snapshot.tokens.length, parsed.tokens.length);

  assert.deepEqual(snapshot.tokens[0]?.components[0]?.decision, {
    kind: 'RESOLVED',
    confidence: 'HIGH',
    ingredient: {
      ingredientId: ingredientIds.aqua,
      canonicalName: 'Aqua',
    },
    matchedBy: { kind: 'CANONICAL_NAME', matchedText: 'Aqua' },
  });
  assert.deepEqual(snapshot.tokens[1]?.components[0], {
    componentPosition: 0,
    lookupText: 'ＷＡＴＥＲ',
    lookupKey: 'water',
    decision: {
      kind: 'RESOLVED',
      confidence: 'MEDIUM',
      ingredient: {
        ingredientId: ingredientIds.aqua,
        canonicalName: 'Aqua',
      },
      matchedBy: {
        kind: 'ALIAS',
        aliasId: '10000000-0000-4000-8000-000000000001',
        matchedText: 'Water',
      },
    },
  });
  assert.deepEqual(snapshot.tokens[2]?.components[0]?.decision, {
    kind: 'AMBIGUOUS',
    confidence: 'NONE',
    candidates: [
      {
        ingredient: {
          ingredientId: ingredientIds.beeswax,
          canonicalName: 'Cera Alba',
        },
        matchedBy: {
          kind: 'ALIAS',
          aliasId: '10000000-0000-4000-8000-000000000002',
          matchedText: 'Wax',
        },
      },
      {
        ingredient: {
          ingredientId: ingredientIds.carnauba,
          canonicalName: 'Copernicia Cerifera Cera',
        },
        matchedBy: {
          kind: 'ALIAS',
          aliasId: '10000000-0000-4000-8000-000000000003',
          matchedText: 'Wax',
        },
      },
    ],
  });
  assert.deepEqual(snapshot.tokens[3]?.components[0]?.decision, {
    kind: 'UNRESOLVED',
    confidence: 'NONE',
    reason: 'NO_DICTIONARY_MATCH',
  });
  assert.deepEqual(snapshot.tokens[4]?.components[0]?.decision, {
    kind: 'UNRESOLVED',
    confidence: 'NONE',
    reason: 'SOURCE_UNCERTAIN',
  });
  assert.deepEqual(
    snapshot.tokens[5]?.components.map((component) => ({
      lookupText: component.lookupText,
      decision: component.decision,
    })),
    [
      {
        lookupText: 'CI 77491',
        decision: {
          kind: 'RESOLVED',
          confidence: 'HIGH',
          ingredient: {
            ingredientId: ingredientIds.pigment77491,
            canonicalName: 'CI 77491',
          },
          matchedBy: { kind: 'CANONICAL_NAME', matchedText: 'CI 77491' },
        },
      },
      {
        lookupText: 'CI 77499',
        decision: {
          kind: 'RESOLVED',
          confidence: 'HIGH',
          ingredient: {
            ingredientId: ingredientIds.pigment77499,
            canonicalName: 'CI 77499',
          },
          matchedBy: { kind: 'CANONICAL_NAME', matchedText: 'CI 77499' },
        },
      },
    ],
  );

  for (const [position, token] of snapshot.tokens.entries()) {
    assert.equal(token.sourceToken, parsed.tokens[position]);
  }
});

test('INCI canonicalization does not depend on dictionary row order', () => {
  const parsed = parseInci('Wax, Water');
  assert.equal(parsed.kind, 'PARSED');
  if (parsed.kind !== 'PARSED') return;
  const dictionary = fixtureDictionary();
  const reversed: InciDictionarySnapshot = {
    ...dictionary,
    ingredients: [...dictionary.ingredients]
      .reverse()
      .map((entry) => ({ ...entry, aliases: [...entry.aliases].reverse() })),
  };

  assert.deepEqual(
    canonicalizeInci(parsed, reversed),
    canonicalizeInci(parsed, dictionary),
  );
});

test('ingredient knowledge publication requires evidence and preserves conflicts', () => {
  const draft: IngredientKnowledgeDraft = {
    snapshotId:
      '20000000-0000-4000-8000-000000000001' as IngredientKnowledgeSnapshotId,
    version: 'knowledge-fixture-v1' as IngredientKnowledgeVersion,
    basedOnSnapshotId: null,
    status: 'DRAFT',
    facts: [
      {
        factId:
          '30000000-0000-4000-8000-000000000001' as IngredientKnowledgeFactId,
        ingredientId: ingredientId(ingredientIds.carnauba),
        functionCode: 'FILM_FORMER' as IngredientFunctionCode,
        jurisdiction: 'GLOBAL' as KnowledgeJurisdiction,
        confidence: 'MEDIUM',
        evidence: [
          {
            evidenceId:
              '40000000-0000-4000-8000-000000000001' as IngredientKnowledgeEvidenceId,
            evidenceType: 'OFFICIAL_DATABASE',
            stance: 'SUPPORTS',
            sourceUrl: 'https://authority.example/ingredients/carnauba',
            checkedAt: new Date('2026-08-25T09:00:00.000Z'),
          },
          {
            evidenceId:
              '40000000-0000-4000-8000-000000000002' as IngredientKnowledgeEvidenceId,
            evidenceType: 'SCIENTIFIC_PUBLICATION',
            stance: 'CONTRADICTS',
            sourceUrl: 'https://research.example/study/42',
            checkedAt: new Date('2026-08-26T09:00:00.000Z'),
          },
        ],
      },
    ],
  };

  const result = publishIngredientKnowledge(
    draft,
    new Date('2026-08-27T09:00:00.000Z'),
  );
  assert.equal(result.kind, 'PUBLISHED');
  if (result.kind !== 'PUBLISHED') return;
  assert.equal(
    result.snapshot.schemaVersion,
    INGREDIENT_KNOWLEDGE_SCHEMA_VERSION,
  );
  assert.deepEqual(
    result.snapshot.facts[0]?.evidence.map(({ stance }) => stance),
    ['SUPPORTS', 'CONTRADICTS'],
  );
  assert.equal(result.snapshot.status, 'PUBLISHED');
});

test('ingredient knowledge publication rejects unsupported or unsafe facts', () => {
  const result = publishIngredientKnowledge(
    {
      snapshotId:
        '20000000-0000-4000-8000-000000000002' as IngredientKnowledgeSnapshotId,
      version: 'knowledge-fixture-v2' as IngredientKnowledgeVersion,
      basedOnSnapshotId:
        '20000000-0000-4000-8000-000000000001' as IngredientKnowledgeSnapshotId,
      status: 'DRAFT',
      facts: [
        {
          factId:
            '30000000-0000-4000-8000-000000000002' as IngredientKnowledgeFactId,
          ingredientId: ingredientId(ingredientIds.aqua),
          functionCode: 'SOLVENT' as IngredientFunctionCode,
          jurisdiction: 'GLOBAL' as KnowledgeJurisdiction,
          confidence: 'LOW',
          evidence: [
            {
              evidenceId:
                '40000000-0000-4000-8000-000000000003' as IngredientKnowledgeEvidenceId,
              evidenceType: 'SCIENTIFIC_PUBLICATION',
              stance: 'CONTRADICTS',
              sourceUrl: 'https://user:secret@research.example/unsafe',
              checkedAt: new Date('2026-08-28T09:00:00.000Z'),
            },
          ],
        },
      ],
    },
    new Date('2026-08-27T09:00:00.000Z'),
  );

  assert.equal(result.kind, 'REJECTED');
  if (result.kind !== 'REJECTED') return;
  assert.deepEqual(
    result.issues.map(({ code }) => code),
    [
      'MISSING_SUPPORTING_EVIDENCE',
      'INVALID_SOURCE_URL',
      'EVIDENCE_CHECKED_AFTER_PUBLICATION',
    ],
  );
});
