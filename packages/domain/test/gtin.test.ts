import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeGtin, type GtinFormat } from '../src/gtin.js';

const validCases: Array<{
  input: string;
  format: GtinFormat;
  gtin14: string;
}> = [
  { input: '96385074', format: 'EAN_8', gtin14: '00000096385074' },
  { input: '036000291452', format: 'UPC_A', gtin14: '00036000291452' },
  { input: '012345678905', format: 'UPC_A', gtin14: '00012345678905' },
  { input: '4006381333931', format: 'EAN_13', gtin14: '04006381333931' },
  { input: '10614141123459', format: 'GTIN_14', gtin14: '10614141123459' },
];

test('GTIN formats normalize without losing leading zeros', () => {
  for (const expected of validCases) {
    const result = normalizeGtin(expected.input);
    assert.equal(result.kind, 'VALID', expected.input);
    if (result.kind !== 'VALID') continue;
    assert.deepEqual(result.gtin, {
      value: expected.input,
      format: expected.format,
      gtin14: expected.gtin14,
    });
  }
});

test('GTIN validation returns stable reasons', () => {
  const cases = [
    { input: '', reason: 'INVALID_LENGTH' },
    { input: '1234567', reason: 'INVALID_LENGTH' },
    { input: '123456789012345', reason: 'INVALID_LENGTH' },
    { input: '96385O74', reason: 'NON_DIGIT' },
    { input: '１２３４５６７８', reason: 'NON_DIGIT' },
    { input: '0000000\n', reason: 'NON_DIGIT' },
    { input: '96385075', reason: 'INVALID_CHECKSUM' },
    { input: '036000291453', reason: 'INVALID_CHECKSUM' },
  ] as const;

  for (const expected of cases) {
    assert.deepEqual(normalizeGtin(expected.input), {
      kind: 'INVALID',
      reason: expected.reason,
    });
  }
});

function referenceCheckDigit(payload: string): string {
  const weightedSum = [...payload]
    .reverse()
    .reduce(
      (sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1),
      0,
    );
  return String((10 - (weightedSum % 10)) % 10);
}

function deterministicDigitSource(): () => number {
  let state = 0x5eed_1234;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % 10;
  };
}

test('GTIN checksum and normalization properties hold across formats', () => {
  const nextDigit = deterministicDigitSource();
  const lengths = [8, 12, 13, 14] as const;

  for (const length of lengths) {
    for (let sample = 0; sample < 250; sample += 1) {
      const payload = Array.from({ length: length - 1 }, (_, index) =>
        index === 0 && sample % 2 === 0 ? '0' : String(nextDigit()),
      ).join('');
      const value = payload + referenceCheckDigit(payload);
      const result = normalizeGtin(value);
      assert.equal(result.kind, 'VALID', value);
      if (result.kind !== 'VALID') continue;
      assert.equal(result.gtin.value, value);
      assert.equal(result.gtin.gtin14, value.padStart(14, '0'));

      const normalizedAgain = normalizeGtin(result.gtin.gtin14);
      assert.equal(normalizedAgain.kind, 'VALID');
      if (normalizedAgain.kind === 'VALID') {
        assert.equal(normalizedAgain.gtin.format, 'GTIN_14');
        assert.equal(normalizedAgain.gtin.gtin14, result.gtin.gtin14);
      }

      const wrongCheckDigit = String((Number(value.at(-1)) + 1) % 10);
      assert.deepEqual(normalizeGtin(payload + wrongCheckDigit), {
        kind: 'INVALID',
        reason: 'INVALID_CHECKSUM',
      });
    }
  }
});

test('equivalent padded barcode forms share canonical GTIN-14', () => {
  const representations = ['036000291452', '0036000291452', '00036000291452'];
  const normalized = representations.map((value) => normalizeGtin(value));
  assert.ok(normalized.every((result) => result.kind === 'VALID'));
  assert.deepEqual(
    normalized.map((result) =>
      result.kind === 'VALID' ? result.gtin.gtin14 : null,
    ),
    Array.from({ length: 3 }, () => '00036000291452'),
  );
});
