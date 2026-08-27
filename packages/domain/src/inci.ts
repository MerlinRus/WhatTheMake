export const INCI_PARSER_VERSION = 'inci-parser-v1' as const;
export const MAX_INCI_SOURCE_LENGTH = 100_000;

export type InciPresence = 'DECLARED' | 'MAY_CONTAIN';

export type InciUncertaintyReason =
  'OCR_NOISE' | 'UNBALANCED_GROUPING' | 'LOW_INFORMATION';

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

const HEADING =
  /^\s*(?:(?:ingredients?|ingr[eé]dients?)(?:\s*\/\s*(?:ingredients?|ingr[eé]dients?))*|состав)\s*[:：]\s*/iu;
const PLUS_MINUS = String.raw`(?:±|\+\s*\/\s*[-−])`;
const MAY_CONTAIN = String.raw`may\s+contain\b`;
const CONDITIONAL_MARKER = new RegExp(
  String.raw`^(?:[\[{]\s*)?(?:${MAY_CONTAIN}(?:\s*\(\s*${PLUS_MINUS}\s*\))?|\(\s*${PLUS_MINUS}\s*\)\s*(?:${MAY_CONTAIN})?|${PLUS_MINUS}\s*(?:${MAY_CONTAIN})?)\s*[:：]?\s*`,
  'iu',
);
const CI_PIGMENT = /^CI\s*\d{5}(?:\s*\/\s*(?:CI\s*)?\d{5})*$/iu;
const OCR_CI_CONFUSABLE = /^(?:C[1l]|G[I1l])\s*\d{5}/iu;
const CI_NUMBER = /\d{5}/gu;
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}]/u;
const OCR_NOISE = /[?�□▯■]/u;
const LINE_BREAK_HYPHENATION = /\p{L}-\s*[\r\n]+\s*\p{L}/u;

type GroupingCharacter = '(' | ')' | '[' | ']' | '{' | '}';

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function isDelimiter(character: string): boolean {
  return (
    character === ',' ||
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
  return reasons;
}

function matchedGrouping(source: string): ReadonlyMap<number, number> {
  const stack: Array<{ character: GroupingCharacter; index: number }> = [];
  const pairs = new Map<number, number>();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] as GroupingCharacter | undefined;
    if (character === '(' || character === '[' || character === '{') {
      const isConditionalWrapper =
        character !== '(' &&
        CONDITIONAL_MARKER.test(source.slice(index, index + 256));
      if (!isConditionalWrapper) stack.push({ character, index });
      continue;
    }
    if (character !== ')' && character !== ']' && character !== '}') continue;
    const opening = stack.at(-1);
    if (opening && matchingClose(opening.character) === character) {
      stack.pop();
      pairs.set(opening.index, index);
    }
  }
  return pairs;
}

function tokenRanges(source: string, contentStart: number): InciSourceSpan[] {
  const pairs = matchedGrouping(source);
  const activeClosings: number[] = [];
  const ranges: InciSourceSpan[] = [];
  let rangeStart = contentStart;

  for (let index = contentStart; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const matching = pairs.get(index);
    if (matching !== undefined) activeClosings.push(matching);

    if (isDelimiter(character) && activeClosings.length === 0) {
      ranges.push({ start: rangeStart, end: index });
      rangeStart = index + 1;
    }

    if (activeClosings.at(-1) === index) activeClosings.pop();
  }
  ranges.push({ start: rangeStart, end: source.length });
  return ranges;
}

function closingWrapperFor(opening: string): string | null {
  if (opening === '[') return ']';
  if (opening === '{') return '}';
  return null;
}

function lastNonWhitespaceIndex(source: string): number | null {
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (!isWhitespace(source[index] ?? '')) return index;
  }
  return null;
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
  const contentStart = heading?.[0].length ?? 0;
  const tokens: InciToken[] = [];
  const ignoredPositions = new Set<number>();
  const lastSourceIndex = lastNonWhitespaceIndex(source);
  let presence: InciPresence = 'DECLARED';

  for (const range of tokenRanges(source, contentStart)) {
    let span = trimSpan(source, range.start, range.end, ignoredPositions);
    if (!span) continue;

    const candidate = source.slice(span.start, span.end);
    const marker = CONDITIONAL_MARKER.exec(candidate);
    if (marker) {
      const openingWrapper = candidate.match(/^\s*([[{])/u)?.[1];
      const closingWrapper = openingWrapper
        ? closingWrapperFor(openingWrapper)
        : null;
      if (
        closingWrapper &&
        lastSourceIndex !== null &&
        source[lastSourceIndex] === closingWrapper
      ) {
        ignoredPositions.add(lastSourceIndex);
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

    const token = createToken(source, span, tokens.length, presence);
    tokens.push(token);
  }

  return {
    kind: 'PARSED',
    parserVersion: INCI_PARSER_VERSION,
    tokens,
  };
}
