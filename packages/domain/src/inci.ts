export const INCI_PARSER_VERSION = 'inci-parser-v2' as const;
export const MAX_INCI_SOURCE_LENGTH = 100_000;

export type InciPresence = 'DECLARED' | 'MAY_CONTAIN';

export type InciUncertaintyReason =
  'OCR_NOISE' | 'UNBALANCED_GROUPING' | 'LOW_INFORMATION' | 'NON_INCI_TEXT';

export interface InciSourceSpan {
  /** Inclusive UTF-16 code-unit offset, compatible with String.prototype.slice. */
  start: number;
  /** Exclusive UTF-16 code-unit offset, compatible with String.prototype.slice. */
  end: number;
}

interface InciTokenBase {
  position: number;
  sourceSpan: InciSourceSpan;
  /** Exact source substring covered by sourceSpan. */
  sourceText: string;
  /** Source text with whitespace collapsed; not a canonical ingredient name. */
  text: string;
  presence: InciPresence;
  uncertaintyReasons: readonly InciUncertaintyReason[];
}

export type InciToken =
  | (InciTokenBase & { kind: 'INGREDIENT' })
  | (InciTokenBase & {
      kind: 'CI_PIGMENT';
      ciNumbers: readonly string[];
    })
  | (InciTokenBase & { kind: 'UNRESOLVED' });

export type ParseInciResult =
  | {
      kind: 'PARSED';
      parserVersion: typeof INCI_PARSER_VERSION;
      tokens: readonly InciToken[];
    }
  | {
      kind: 'REJECTED';
      parserVersion: typeof INCI_PARSER_VERSION;
      reason: 'SOURCE_TOO_LARGE';
      sourceLength: number;
      maxSourceLength: number;
    };

export type ParsedInci = Extract<ParseInciResult, { kind: 'PARSED' }>;

const HEADING =
  /^\s*(?:(?:ingredients?|ingr[eé]dients?)(?:\s*\/\s*(?:ingredients?|ingr[eé]dients?))*|состав)\s*[:：]\s*/iu;
const LEADING_FORMULA_CODE = /^\s*[A-Z]\d{6,}(?:\/\d+)?\s*-\s*/u;
const PLUS_MINUS = String.raw`(?:±|\+\s*\/\s*[-−])`;
const MAY_CONTAIN = String.raw`may\s+contain\b`;
const PEUT_CONTENIR = String.raw`peut\s+contenir\b`;
const CONDITIONAL_LABEL = String.raw`(?:${MAY_CONTAIN})(?:\s*\/\s*${PEUT_CONTENIR})?|${PEUT_CONTENIR}`;
const CONDITIONAL_MARKER = new RegExp(
  String.raw`^\s*(?:[\[{]\s*)?(?:(?:${CONDITIONAL_LABEL})(?:\s*\/\s*|\s*)?\(?\s*(?:${PLUS_MINUS})?\s*\)?|\(?\s*${PLUS_MINUS}\s*\)?(?:\s*(?:${CONDITIONAL_LABEL}))?)\s*[:：]?\s*(?:${PLUS_MINUS}\s*)?`,
  'iu',
);
const CI_LIST = String.raw`CI\s*\d{5}(?:(?:\s*[/,]\s*)(?:CI\s*)?\d{5})*`;
const PIGMENT_LABEL = String.raw`[\p{L}\p{M}][\p{L}\p{M}\d\s-]*`;
const CI_PIGMENT = new RegExp(
  String.raw`^(?:${CI_LIST}|${CI_LIST}\s*(?:\/\s*${PIGMENT_LABEL}|\(\s*${PIGMENT_LABEL}\s*\))|${PIGMENT_LABEL}\s*\(\s*${CI_LIST}\s*\))$`,
  'iu',
);
const OCR_CI_CONFUSABLE = /\b(?:C[1l]|G[I1l])\s*\d{5}/iu;
const CI_NUMBER = /\d{5}/gu;
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}]/u;
const OCR_NOISE = /[?�□▯■]/u;
const LINE_BREAK_HYPHENATION = /\p{L}-\s*[\r\n]+\s*\p{L}/u;
const NON_INCI_TEXT =
  /^(?:\(?\s*F\.?I\.?L\.?\s+[A-Z0-9/.-]+|FIL\s+[A-Z0-9/.-]+|please\s+be\s+aware\b)/iu;
const DISCLAIMER_START = /please\s+be\s+aware\b/iuy;
const FORMULA_METADATA_START =
  /(?:\(\s*F\.?I\.?L\.?\s+[A-Z0-9/.-]+|\sFIL\s+[A-Z0-9/.-]+)/iuy;

type GroupingCharacter = '(' | ')' | '[' | ']' | '{' | '}';

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function isNumericLocantRunCharacter(character: string): boolean {
  const codeUnit = character.charCodeAt(0);
  return character === ',' || (codeUnit >= 48 && codeUnit <= 57);
}

function numericLocantCommaIndexes(source: string): ReadonlySet<number> {
  const indexes = new Set<number>();
  let index = 0;

  while (index < source.length) {
    if (!isNumericLocantRunCharacter(source[index] ?? '')) {
      index += 1;
      continue;
    }

    const commaIndexes: number[] = [];
    let valid = source[index] !== ',';
    let previousWasComma = false;
    while (
      index < source.length &&
      isNumericLocantRunCharacter(source[index] ?? '')
    ) {
      if (source[index] === ',') {
        commaIndexes.push(index);
        if (previousWasComma) valid = false;
        previousWasComma = true;
      } else {
        previousWasComma = false;
      }
      index += 1;
    }

    if (
      valid &&
      !previousWasComma &&
      commaIndexes.length > 0 &&
      source[index] === '-'
    ) {
      for (const commaIndex of commaIndexes) indexes.add(commaIndex);
    }
  }

  return indexes;
}

function isNumericLocantComma(
  source: string,
  index: number,
  numericLocantCommas: ReadonlySet<number>,
): boolean {
  if (source[index] !== ',') return false;
  const prefix = source.slice(Math.max(0, index - 80), index);
  const suffix = source.slice(index + 1, index + 80);
  if (
    /[\p{L}\d]+(?:-[\p{L}\d]+)*-\d$/u.test(prefix) &&
    /^\s*\d+(?:-|\s+)\p{L}/u.test(suffix)
  ) {
    return true;
  }
  return numericLocantCommas.has(index);
}

function isDelimiter(
  source: string,
  index: number,
  numericLocantCommas: ReadonlySet<number>,
): boolean {
  const character = source[index] ?? '';
  return (
    (character === ',' &&
      !isNumericLocantComma(source, index, numericLocantCommas)) ||
    character === ';' ||
    character === '\r' ||
    character === '\n' ||
    character === '•' ||
    character === '·' ||
    character === '|'
  );
}

function trimSpan(
  source: string,
  start: number,
  end: number,
  ignoredPositions: ReadonlySet<number>,
): InciSourceSpan | null {
  while (
    start < end &&
    (isWhitespace(source[start] ?? '') || ignoredPositions.has(start))
  ) {
    start += 1;
  }
  while (
    end > start &&
    (isWhitespace(source[end - 1] ?? '') || ignoredPositions.has(end - 1))
  ) {
    end -= 1;
  }
  return start < end ? { start, end } : null;
}

function matchingClose(character: GroupingCharacter): GroupingCharacter | null {
  switch (character) {
    case '(':
      return ')';
    case '[':
      return ']';
    case '{':
      return '}';
    default:
      return null;
  }
}

function hasUnbalancedGrouping(value: string): boolean {
  const stack: GroupingCharacter[] = [];
  for (const character of value) {
    if (character === '(' || character === '[' || character === '{') {
      stack.push(character);
      continue;
    }
    if (character !== ')' && character !== ']' && character !== '}') continue;
    const opening = stack.pop();
    if (!opening || matchingClose(opening) !== character) return true;
  }
  return stack.length > 0;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function hasUnexpectedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function uncertaintyReasons(value: string): InciUncertaintyReason[] {
  const reasons: InciUncertaintyReason[] = [];
  if (
    OCR_NOISE.test(value) ||
    OCR_CI_CONFUSABLE.test(value) ||
    LINE_BREAK_HYPHENATION.test(value) ||
    hasUnexpectedControlCharacter(value) ||
    hasUnpairedSurrogate(value)
  ) {
    reasons.push('OCR_NOISE');
  }
  if (hasUnbalancedGrouping(value)) {
    reasons.push('UNBALANCED_GROUPING');
  }
  if (!MEANINGFUL_CHARACTER.test(value)) {
    reasons.push('LOW_INFORMATION');
  }
  if (NON_INCI_TEXT.test(value)) {
    reasons.push('NON_INCI_TEXT');
  }
  return reasons;
}

interface MatchedGrouping {
  groupedClosings: ReadonlyMap<number, number>;
  conditionalClosings: ReadonlyMap<number, number>;
}

function matchedGrouping(source: string): MatchedGrouping {
  const stack: Array<{
    character: GroupingCharacter;
    index: number;
    conditionalWrapper: boolean;
  }> = [];
  const groupedClosings = new Map<number, number>();
  const conditionalClosings = new Map<number, number>();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as GroupingCharacter | undefined;
    if (character === '(' || character === '[' || character === '{') {
      const conditionalWrapper =
        character !== '(' &&
        CONDITIONAL_MARKER.test(source.slice(index, index + 256));
      stack.push({ character, index, conditionalWrapper });
      continue;
    }
    if (character !== ')' && character !== ']' && character !== '}') continue;
    const opening = stack.at(-1);
    if (opening && matchingClose(opening.character) === character) {
      stack.pop();
      (opening.conditionalWrapper ? conditionalClosings : groupedClosings).set(
        opening.index,
        index,
      );
    }
  }
  return { groupedClosings, conditionalClosings };
}

interface TokenRanges {
  ranges: InciSourceSpan[];
  conditionalClosings: ReadonlyMap<number, number>;
}

function tokenRanges(source: string, contentStart: number): TokenRanges {
  const { groupedClosings, conditionalClosings } = matchedGrouping(source);
  const numericLocantCommas = numericLocantCommaIndexes(source);
  const activeClosings: number[] = [];
  const ranges: InciSourceSpan[] = [];
  let rangeStart = contentStart;

  for (let index = contentStart; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const matching = groupedClosings.get(index);
    if (matching !== undefined) activeClosings.push(matching);

    const conditionalBoundary =
      character === '.' &&
      CONDITIONAL_MARKER.test(source.slice(index + 1, index + 257));
    const pigmentSentenceBoundary =
      character === '.' &&
      /^\s*[\p{L}\d][^.]{0,80}\(\s*(?:CI|Cl)\s*\d{5}/iu.test(
        source.slice(index + 1, index + 129),
      );
    DISCLAIMER_START.lastIndex = index;
    FORMULA_METADATA_START.lastIndex = index;
    const semanticBoundary =
      index > rangeStart &&
      (DISCLAIMER_START.test(source) || FORMULA_METADATA_START.test(source));

    if (semanticBoundary) {
      ranges.push({ start: rangeStart, end: index });
      rangeStart = index;
    } else if (
      conditionalBoundary ||
      pigmentSentenceBoundary ||
      (isDelimiter(source, index, numericLocantCommas) &&
        activeClosings.length === 0)
    ) {
      ranges.push({ start: rangeStart, end: index });
      rangeStart = index + 1;
    }

    if (activeClosings.at(-1) === index) activeClosings.pop();
  }
  ranges.push({ start: rangeStart, end: source.length });
  return { ranges, conditionalClosings };
}

function ignoreConditionalClosing(
  source: string,
  closingIndex: number,
  ignoredPositions: Set<number>,
): void {
  ignoredPositions.add(closingIndex);
  let index = closingIndex + 1;
  while (index < source.length && isWhitespace(source[index] ?? '')) index += 1;
  while (index < source.length && source[index] === '.') {
    ignoredPositions.add(index);
    index += 1;
    while (index < source.length && isWhitespace(source[index] ?? '')) {
      index += 1;
    }
  }
}

function createToken(
  source: string,
  span: InciSourceSpan,
  position: number,
  presence: InciPresence,
): InciToken {
  const sourceText = source.slice(span.start, span.end);
  const text = sourceText.replace(/\s+/gu, ' ');
  const reasons = uncertaintyReasons(sourceText);
  const base: InciTokenBase = {
    position,
    sourceSpan: span,
    sourceText,
    text,
    presence,
    uncertaintyReasons: reasons,
  };

  if (reasons.length > 0) return { ...base, kind: 'UNRESOLVED' };
  if (CI_PIGMENT.test(text)) {
    return {
      ...base,
      kind: 'CI_PIGMENT',
      ciNumbers: [...text.matchAll(CI_NUMBER)].map(([number]) => number),
    };
  }
  return { ...base, kind: 'INGREDIENT' };
}

function trimPigmentTerminalPeriod(
  source: string,
  span: InciSourceSpan,
): InciSourceSpan {
  if (source[span.end - 1] !== '.') return span;
  const candidate = source
    .slice(span.start, span.end - 1)
    .replace(/\s+/gu, ' ');
  return CI_PIGMENT.test(candidate)
    ? { start: span.start, end: span.end - 1 }
    : span;
}

export function parseInci(source: string): ParseInciResult {
  if (source.length > MAX_INCI_SOURCE_LENGTH) {
    return {
      kind: 'REJECTED',
      parserVersion: INCI_PARSER_VERSION,
      reason: 'SOURCE_TOO_LARGE',
      sourceLength: source.length,
      maxSourceLength: MAX_INCI_SOURCE_LENGTH,
    };
  }

  const heading = HEADING.exec(source);
  let contentStart = heading?.[0].length ?? 0;
  if (contentStart === 0) {
    const formulaCode = LEADING_FORMULA_CODE.exec(source);
    contentStart = formulaCode?.[0].length ?? 0;
  }
  const tokens: InciToken[] = [];
  const ignoredPositions = new Set<number>();
  let presence: InciPresence = 'DECLARED';
  const tokenization = tokenRanges(source, contentStart);

  for (const range of tokenization.ranges) {
    let span = trimSpan(source, range.start, range.end, ignoredPositions);
    if (!span) continue;

    const candidate = source.slice(span.start, span.end);
    const marker = CONDITIONAL_MARKER.exec(candidate);
    if (marker) {
      const openingWrapper = candidate.match(/^\s*([[{])/u)?.[1];
      const closingIndex = openingWrapper
        ? tokenization.conditionalClosings.get(span.start)
        : undefined;
      if (closingIndex !== undefined) {
        ignoreConditionalClosing(source, closingIndex, ignoredPositions);
      }
      presence = 'MAY_CONTAIN';
      span = trimSpan(
        source,
        span.start + marker[0].length,
        span.end,
        ignoredPositions,
      );
      if (!span) continue;
    }

    span = trimPigmentTerminalPeriod(source, span);
    const token = createToken(source, span, tokens.length, presence);
    tokens.push(token);
  }

  return {
    kind: 'PARSED',
    parserVersion: INCI_PARSER_VERSION,
    tokens,
  };
}
