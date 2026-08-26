type TaggedString<Name extends string> = string & {
  readonly __brand: Name;
};

export type GtinValue = TaggedString<'GtinValue'>;
export type Gtin14 = TaggedString<'Gtin14'>;

export type GtinFormat = 'EAN_8' | 'UPC_A' | 'EAN_13' | 'GTIN_14';

export type GtinValidationReason =
  'INVALID_LENGTH' | 'NON_DIGIT' | 'INVALID_CHECKSUM';

export interface NormalizedGtin {
  value: GtinValue;
  format: GtinFormat;
  gtin14: Gtin14;
}

export type NormalizeGtinResult =
  | { kind: 'VALID'; gtin: NormalizedGtin }
  | { kind: 'INVALID'; reason: GtinValidationReason };

const NON_ASCII_DIGIT = /[^0-9]/;

function formatForLength(length: number): GtinFormat | null {
  switch (length) {
    case 8:
      return 'EAN_8';
    case 12:
      return 'UPC_A';
    case 13:
      return 'EAN_13';
    case 14:
      return 'GTIN_14';
    default:
      return null;
  }
}

function expectedCheckDigit(value: string): number {
  let sum = 0;
  let weight = 3;
  for (let index = value.length - 2; index >= 0; index -= 1) {
    sum += Number(value[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function normalizeGtin(input: string): NormalizeGtinResult {
  const format = formatForLength(input.length);
  if (!format) return { kind: 'INVALID', reason: 'INVALID_LENGTH' };
  if (NON_ASCII_DIGIT.test(input)) {
    return { kind: 'INVALID', reason: 'NON_DIGIT' };
  }
  if (Number(input.at(-1)) !== expectedCheckDigit(input)) {
    return { kind: 'INVALID', reason: 'INVALID_CHECKSUM' };
  }

  return {
    kind: 'VALID',
    gtin: {
      value: input as GtinValue,
      format,
      gtin14: input.padStart(14, '0') as Gtin14,
    },
  };
}
