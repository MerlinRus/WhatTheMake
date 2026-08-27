import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCI_PARSER_VERSION,
  MAX_INCI_SOURCE_LENGTH,
  parseInci,
  type InciToken,
} from '../src/inci.js';

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
