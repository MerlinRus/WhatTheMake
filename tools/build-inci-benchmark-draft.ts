import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';

import {
  canonicalizeInci,
  INCI_LOOKUP_NORMALIZER_VERSION,
  normalizeInciLookupText,
  serializeInciDictionarySnapshot,
  type CanonicalIngredientId,
  type InciDictionaryAlias,
  type InciDictionaryAliasId,
  type InciDictionaryIngredient,
  type InciDictionarySnapshot,
  type InciDictionaryVersion,
} from '../packages/domain/src/inci-canonicalization.js';
import {
  parseInci,
  type InciPresence,
  type InciToken,
  type ParsedInci,
} from '../packages/domain/src/inci.js';
import {
  INCI_BENCHMARK_MIN_ANCHORS,
  INCI_BENCHMARK_MIN_MAY_CONTAIN_ANCHORS,
  INCI_BENCHMARK_MIN_PIGMENT_ANCHORS,
  INCI_BENCHMARK_MIN_SAMPLES,
  INCI_BENCHMARK_MIN_UNRESOLVED_ANCHORS,
  type InciBenchmarkAnchor,
  type InciBenchmarkCorpus,
  type InciBenchmarkQualityFlag,
} from '../packages/domain/src/inci-benchmark.js';
import { normalizeGtin } from '../packages/domain/src/gtin.js';

// This utility only bootstraps a reviewable draft. Its output is deliberately
// invalid benchmark truth until an independent reviewer completes metadata.
const EXPECTED_CANDIDATE_COUNT = 88;
const DATASET_ID = 'open-beauty-facts-mascara-inci-anchors';
const DATASET_VERSION = '2026-08-31-v1';
const DICTIONARY_VERSION =
  'obf-mascara-inci-2026.08.31-v1' as InciDictionaryVersion;
const SELECTED_GTINS = [
  '8696814061843',
  '8690644387005',
  '3600531701802',
  '4084200857103',
  '7640473382857',
  '8055510082093',
  '8809625243135',
  '8055510082109',
  '8055510082116',
  '4602006378266',
  '4602006311058',
  '30179493',
  '3600531716974',
  '30166974',
  '3600523503384',
  '3616307650168',
  '0651986800216',
  '0681619821813',
  '8682536040402',
  '0041554007503',
] as const;
const QUALITY_FLAGS = new Set([
  'DISCLAIMER_TEXT',
  'TRUNCATED_TEXT',
  'LEADING_PRODUCT_CODE',
  'STALE_SOURCE',
]);
const DISCLAIMER_PHRASE =
  /(?:please\s+be\s+aware\s+that\s+ingredient\s+lists?|ingredient\s+lists?.{0,80}updated\s+regularly|refer\s+to\s+the\s+ingredient\s+list|up\s+to\s+date\s+list\s+of\s+ingredients|suitable\s+to\s+your\s+personal\s+use)/isu;
const LEADING_PRODUCT_CODE = /^\s*[A-Z]\d{6,}(?:\/\d+)?\s*-\s*/u;
const UNSAFE_DICTIONARY_TEXT =
  /(?:may\s+contain|peut\s+contenir|please\s+be\s+aware|\bF\.?I\.?L\.?\s+[A-Z0-9/.-]+|^\s*[A-Z]\d{6,}\s*-)/iu;

const CANONICAL_EQUIVALENCE_GROUPS: ReadonlyArray<
  readonly [canonicalName: string, aliases: readonly string[]]
> = [
  [
    'Aqua',
    [
      'Aqua',
      'Water',
      'Aqua (Water)',
      'Water (Aqua)',
      'Water/Aqua',
      'Water/Aqua/Eau',
      'Aqua/Water/Eau',
      'Water (Aqua/Eau)',
    ],
  ],
  [
    'Acacia Senegal Gum',
    ['Acacia Senegal Gum', 'Acacia Senegal', 'Acacia/Acacia Senegal Gum'],
  ],
  ['Alcohol Denat.', ['Alcohol Denat.', 'Alcohol Denat']],
  [
    'Cera Alba',
    [
      'Cera Alba',
      'Beeswax',
      'Cera Alba/Beeswax',
      'Beeswax/Cera Alba',
      'Cera Alba (Beeswax)',
    ],
  ],
  [
    'Copernicia Cerifera Cera',
    [
      'Copernicia Cerifera Cera',
      'Carnauba/Carnauba Wax',
      'Cera Carnauba',
      'Copernicia Cerifera (Carnauba) Wax',
      'Copernicia Cerifera Cera (Carnauba Wax)',
      'Copernicia Cerifera Cera (Copernicia Cerifera (Carnauba) Wax)',
      'Copernicia Cerifera Cera/Copernicia Cerifera (Carnauba) Wax/Cire de Carnauba',
      'Cera Carnauba (Copernicia Cerifera (Carnauba) Wax)',
    ],
  ],
  [
    'Cera Microcristallina',
    [
      'Cera Microcristallina',
      'Microcrystalline Wax',
      'Cera Microcristallina (Microcrystalline Wax)',
    ],
  ],
  [
    'Oryza Sativa Cera',
    [
      'Oryza Sativa Cera',
      'Oryza Sativa (Rice) Bran Wax',
      'Oryza Sativa Cera (Oryza Sativa (Rice) Bran Wax)',
    ],
  ],
  [
    'Ricinus Communis Seed Oil',
    ['Ricinus Communis Seed Oil', 'Ricinus Communis (Castor) Seed Oil'],
  ],
  ['VP/Eicosene Copolymer', ['VP/Eicosene Copolymer', 'VPIEicosene Copolymer']],
  [
    '2-Oleamido-1,3-Octadecanediol',
    ['2-Oleamido-1,3-Octadecanediol', '2-OLEAMIDO-1, 3 OCTADECANEDIOL'],
  ],
  ['CI 77266', ['CI 77266', 'Carbon Black', 'Black 2']],
  ['CI 77891', ['CI 77891', 'Titanium Dioxide']],
];

const CANONICAL_NAME_BY_LOOKUP_KEY = new Map<string, string>();
for (const [canonicalName, aliases] of CANONICAL_EQUIVALENCE_GROUPS) {
  for (const alias of aliases) {
    const key = normalizeInciLookupText(alias);
    const existing = CANONICAL_NAME_BY_LOOKUP_KEY.get(key);
    if (existing && existing !== canonicalName) {
      throw new Error(`Conflicting curated canonical mapping for ${alias}`);
    }
    CANONICAL_NAME_BY_LOOKUP_KEY.set(key, canonicalName);
  }
}

const INTENTIONALLY_UNRESOLVED_LOOKUP_KEYS = new Set([
  normalizeInciLookupText('Iron Oxides'),
]);

interface Options {
  candidates: string;
  corpusOutput: string;
  dictionaryOutput: string;
}

interface Candidate {
  sampleId: string;
  gtin: string;
  productLabel: string;
  sourceUrl: string;
  sourceLastModifiedAt: string;
  retrievedAt: string;
  rawInciText: string;
  qualityFlags: InciBenchmarkQualityFlag[];
}

interface CandidateManifest {
  provenance: {
    label: string;
    uri: string;
    licenseName: string;
    licenseUri: string;
    attribution: string;
    rightsStatus: 'ALLOWED';
  };
  candidates: Candidate[];
}

interface ParsedSample {
  candidate: Candidate;
  parsed: ParsedInci;
}

interface ComponentObservation {
  lookupText: string;
  tokenKind: InciToken['kind'];
  presence: InciPresence;
}

interface IngredientDraft {
  canonicalNames: Set<string>;
  rawAliasesByLookupKey: Map<string, Set<string>>;
}

function parseArguments(arguments_: string[]): Options {
  const expected = new Set([
    '--candidates',
    '--corpus-output',
    '--dictionary-output',
  ]);
  if (arguments_.length !== expected.size * 2) {
    throw new Error(
      'Expected --candidates, --corpus-output, and --dictionary-output',
    );
  }

  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name || !expected.has(name) || !value) {
      throw new Error(
        'Expected --candidates, --corpus-output, and --dictionary-output',
      );
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }

  const candidates = resolve(requiredArgument(values, '--candidates'));
  const corpusOutput = resolve(requiredArgument(values, '--corpus-output'));
  const dictionaryOutput = resolve(
    requiredArgument(values, '--dictionary-output'),
  );
  if (new Set([candidates, corpusOutput, dictionaryOutput]).size !== 3) {
    throw new Error('Input and output paths must be distinct');
  }
  return { candidates, corpusOutput, dictionaryOutput };
}

function requiredArgument(values: ReadonlyMap<string, string>, name: string) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing argument: ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredRecord(
  record: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = record[field];
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a nonempty string`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  field: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validGtin(value: string): boolean {
  return normalizeGtin(value).kind === 'VALID';
}

function parseQualityFlags(
  value: unknown,
  gtin: string,
): InciBenchmarkQualityFlag[] {
  if (!Array.isArray(value)) {
    throw new Error(`Candidate ${gtin} qualityFlags must be an array`);
  }
  const flags = value.map((flag) => {
    if (typeof flag !== 'string' || !QUALITY_FLAGS.has(flag)) {
      throw new Error(`Candidate ${gtin} has an invalid quality flag`);
    }
    return flag as InciBenchmarkQualityFlag;
  });
  if (new Set(flags).size !== flags.length) {
    throw new Error(`Candidate ${gtin} has duplicate quality flags`);
  }
  return flags;
}

function parseCandidate(value: unknown, retrievedAt: string): Candidate {
  if (!isRecord(value)) throw new Error('Every candidate must be an object');
  const gtin = requiredString(value, 'gtin');
  if (!validGtin(gtin)) throw new Error(`Candidate has invalid GTIN: ${gtin}`);
  const sampleId = requiredString(value, 'sampleId');
  if (sampleId !== `obf-${gtin}`) {
    throw new Error(`Candidate ${gtin} has a mismatched sampleId`);
  }
  const sourceUrl = requiredString(value, 'sourceUrl');
  if (sourceUrl !== `https://world.openbeautyfacts.org/product/${gtin}`) {
    throw new Error(`Candidate ${gtin} has a mismatched sourceUrl`);
  }
  const sourceLastModifiedAt = requiredString(value, 'sourceLastModifiedAt');
  const candidateRetrievedAt = requiredString(value, 'retrievedAt');
  if (
    !canonicalTimestamp(sourceLastModifiedAt) ||
    !canonicalTimestamp(candidateRetrievedAt)
  ) {
    throw new Error(`Candidate ${gtin} has a non-canonical timestamp`);
  }
  if (candidateRetrievedAt !== retrievedAt) {
    throw new Error(`Candidate ${gtin} has a mismatched retrievedAt`);
  }
  const rawInciText = requiredString(value, 'rawInciText');
  const rawInciField = requiredString(value, 'rawInciField');
  if (
    rawInciField !== 'ingredients_text' &&
    rawInciField !== 'ingredients_text_en'
  ) {
    throw new Error(`Candidate ${gtin} has an invalid rawInciField`);
  }
  for (const field of ['sourceProductName', 'sourceBrands']) {
    const sourceValue = value[field];
    if (sourceValue !== null && typeof sourceValue !== 'string') {
      throw new Error(`Candidate ${gtin} has an invalid ${field}`);
    }
  }

  const qualityFlags = parseQualityFlags(value.qualityFlags, gtin);
  if (
    LEADING_PRODUCT_CODE.test(rawInciText) &&
    !qualityFlags.includes('LEADING_PRODUCT_CODE')
  ) {
    qualityFlags.push('LEADING_PRODUCT_CODE');
  }

  return {
    sampleId,
    gtin,
    productLabel: requiredString(value, 'productLabel'),
    sourceUrl,
    sourceLastModifiedAt,
    retrievedAt: candidateRetrievedAt,
    rawInciText,
    qualityFlags: qualityFlags.toSorted(),
  };
}

async function readCandidates(path: string): Promise<CandidateManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Cannot read candidate JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed))
    throw new Error('Candidate manifest must be an object');
  if (parsed.schemaVersion !== 1) {
    throw new Error('Candidate manifest schemaVersion must be 1');
  }
  if (
    requiredString(parsed, 'datasetId') !==
    'open-beauty-facts-mascara-inci-candidates'
  ) {
    throw new Error('Unexpected candidate datasetId');
  }
  if (requiredString(parsed, 'datasetVersion') !== '2026-08-31') {
    throw new Error('Unexpected candidate datasetVersion');
  }

  const source = requiredRecord(parsed, 'source');
  const retrievedAt = requiredString(source, 'retrievedAt');
  if (!canonicalTimestamp(retrievedAt)) {
    throw new Error('Candidate source retrievedAt must be canonical UTC ISO');
  }
  const provenance = {
    label: requiredString(source, 'label'),
    uri: requiredString(source, 'uri'),
    licenseName: requiredString(source, 'licenseName'),
    licenseUri: requiredString(source, 'licenseUri'),
    attribution: requiredString(source, 'attribution'),
    rightsStatus: 'ALLOWED' as const,
  };
  if (
    provenance.label !== 'Open Beauty Facts (ODbL 1.0)' ||
    provenance.uri !== 'https://world.openbeautyfacts.org/' ||
    provenance.licenseName !== 'Open Database License (ODbL) 1.0' ||
    provenance.licenseUri !==
      'https://opendatacommons.org/licenses/odbl/1-0/' ||
    provenance.attribution !==
      'Contains information from Open Beauty Facts, made available under the Open Database License (ODbL) 1.0.'
  ) {
    throw new Error('Candidate manifest has unexpected source provenance');
  }

  const seed = requiredRecord(parsed, 'seed');
  if (
    requiredString(seed, 'datasetId') !== 'open-beauty-facts-mascara' ||
    requiredString(seed, 'datasetVersion') !== '2026-08-26'
  ) {
    throw new Error('Candidate manifest has unexpected seed identity');
  }

  if (!Array.isArray(parsed.candidates)) {
    throw new Error('Candidate manifest candidates must be an array');
  }
  if (parsed.candidates.length !== EXPECTED_CANDIDATE_COUNT) {
    throw new Error(
      `Expected exactly ${EXPECTED_CANDIDATE_COUNT} candidates, received ${parsed.candidates.length}`,
    );
  }
  const candidates = parsed.candidates.map((candidate) =>
    parseCandidate(candidate, retrievedAt),
  );
  const gtins = candidates.map(({ gtin }) => gtin);
  if (new Set(gtins).size !== gtins.length) {
    throw new Error('Candidate manifest contains duplicate GTINs');
  }
  const sortedGtins = gtins.toSorted(compareText);
  if (gtins.some((gtin, index) => gtin !== sortedGtins[index])) {
    throw new Error('Candidate manifest candidates must be sorted by GTIN');
  }

  const report = requiredRecord(parsed, 'report');
  if (
    requiredInteger(report, 'candidates') !== candidates.length ||
    report.complete !== true
  ) {
    throw new Error('Candidate report is incomplete or has a count mismatch');
  }
  if (!Array.isArray(parsed.quarantine)) {
    throw new Error('Candidate manifest quarantine must be an array');
  }
  const quarantined = requiredInteger(report, 'quarantined');
  const seedRows = requiredInteger(report, 'seedRows');
  const exactGtinRequests = requiredInteger(report, 'exactGtinRequests');
  if (
    quarantined !== parsed.quarantine.length ||
    candidates.length + quarantined !== seedRows ||
    exactGtinRequests !== seedRows
  ) {
    throw new Error('Candidate quarantine or seed row count mismatch');
  }

  return { provenance, candidates };
}

function selectCandidates(manifest: CandidateManifest): Candidate[] {
  const candidatesByGtin = new Map(
    manifest.candidates.map((candidate) => [candidate.gtin, candidate]),
  );
  const selected = SELECTED_GTINS.map((gtin) => {
    const candidate = candidatesByGtin.get(gtin);
    if (!candidate) throw new Error(`Required candidate is missing: ${gtin}`);
    return candidate;
  });
  if (
    new Set(selected.map(({ gtin }) => gtin)).size !== SELECTED_GTINS.length
  ) {
    throw new Error('Selected candidate list is not unique');
  }
  if (selected.length < INCI_BENCHMARK_MIN_SAMPLES) {
    throw new Error(
      `Selected only ${selected.length} samples; need at least ${INCI_BENCHMARK_MIN_SAMPLES}`,
    );
  }
  return selected.toSorted((left, right) => compareText(left.gtin, right.gtin));
}

function parseSamples(candidates: readonly Candidate[]): ParsedSample[] {
  return candidates.map((candidate) => {
    const result = parseInci(candidate.rawInciText);
    if (result.kind !== 'PARSED' || result.tokens.length === 0) {
      throw new Error(`Selected sample cannot be parsed: ${candidate.gtin}`);
    }
    return { candidate, parsed: result };
  });
}

function tokenComponents(token: InciToken): ComponentObservation[] {
  const lookupTexts =
    token.kind === 'CI_PIGMENT'
      ? token.ciNumbers.map((number) => `CI ${number}`)
      : [token.text];
  return lookupTexts.map((lookupText) => ({
    lookupText,
    tokenKind: token.kind,
    presence: token.presence,
  }));
}

function canonicalNameFor(lookupText: string): string {
  const curated = CANONICAL_NAME_BY_LOOKUP_KEY.get(
    normalizeInciLookupText(lookupText),
  );
  if (curated) return curated;
  const ciNumbers = [...lookupText.matchAll(/\bCI\s*(\d{5})\b/giu)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
  const firstCiNumber = ciNumbers[0];
  if (ciNumbers.length === 1 && firstCiNumber) {
    return `CI ${firstCiNumber}`;
  }
  if (/\s+\/\s+/u.test(lookupText)) {
    const firstSegment = lookupText.split(/\s+\/\s+/u, 1)[0]?.trim();
    if (firstSegment) {
      return (
        CANONICAL_NAME_BY_LOOKUP_KEY.get(
          normalizeInciLookupText(firstSegment),
        ) ?? firstSegment
      );
    }
  }
  return lookupText;
}

function shouldIncludeInDictionary(
  _sample: ParsedSample,
  component: ComponentObservation,
): boolean {
  if (component.tokenKind === 'UNRESOLVED') return false;
  const lookupKey = normalizeInciLookupText(component.lookupText);
  return (
    !INTENTIONALLY_UNRESOLVED_LOOKUP_KEYS.has(lookupKey) &&
    !DISCLAIMER_PHRASE.test(component.lookupText)
  );
}

function deterministicUuid(label: string): string {
  const bytes = createHash('sha256')
    .update(label, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hexadecimal = bytes.toString('hex');
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join('-');
}

function buildDictionary(
  samples: readonly ParsedSample[],
): InciDictionarySnapshot {
  const drafts = new Map<string, IngredientDraft>();
  for (const sample of samples) {
    for (const token of sample.parsed.tokens) {
      for (const component of tokenComponents(token)) {
        if (!shouldIncludeInDictionary(sample, component)) continue;
        const canonicalName = canonicalNameFor(component.lookupText);
        if (
          UNSAFE_DICTIONARY_TEXT.test(component.lookupText) ||
          UNSAFE_DICTIONARY_TEXT.test(canonicalName)
        ) {
          throw new Error(
            `Unsafe dictionary text at ${sample.candidate.gtin}: ${component.lookupText}`,
          );
        }
        const canonicalLookupKey = normalizeInciLookupText(canonicalName);
        const lookupKey = normalizeInciLookupText(component.lookupText);
        if (!canonicalLookupKey || !lookupKey) {
          throw new Error(
            `Empty dictionary lookup for ${sample.candidate.gtin}`,
          );
        }
        const draft = drafts.get(canonicalLookupKey) ?? {
          canonicalNames: new Set<string>(),
          rawAliasesByLookupKey: new Map<string, Set<string>>(),
        };
        draft.canonicalNames.add(canonicalName);
        const aliases = draft.rawAliasesByLookupKey.get(lookupKey) ?? new Set();
        aliases.add(component.lookupText);
        draft.rawAliasesByLookupKey.set(lookupKey, aliases);
        drafts.set(canonicalLookupKey, draft);
      }
    }
  }

  const ingredients: InciDictionaryIngredient[] = [];
  for (const [canonicalLookupKey, draft] of [...drafts.entries()].toSorted(
    ([left], [right]) => compareText(left, right),
  )) {
    const canonicalName =
      CANONICAL_NAME_BY_LOOKUP_KEY.get(canonicalLookupKey) ??
      [...draft.canonicalNames].toSorted(comparePreferredText)[0];
    if (!canonicalName)
      throw new Error('Dictionary draft has no canonical name');
    assertDictionaryText(canonicalName, 'canonical name');
    assertDictionaryText(canonicalLookupKey, 'canonical lookup key');
    const ingredientId = deterministicUuid(
      `ingredient\u0000${DICTIONARY_VERSION}\u0000${canonicalLookupKey}`,
    ) as CanonicalIngredientId;
    const aliases: InciDictionaryAlias[] = [];
    for (const [lookupKey, rawAliases] of [
      ...draft.rawAliasesByLookupKey.entries(),
    ].toSorted(([left], [right]) => compareText(left, right))) {
      if (lookupKey === canonicalLookupKey) continue;
      const aliasText = [...rawAliases].toSorted(comparePreferredText)[0];
      if (!aliasText)
        throw new Error('Dictionary draft has an empty alias set');
      assertDictionaryText(aliasText, 'alias text');
      assertDictionaryText(lookupKey, 'alias lookup key');
      aliases.push({
        aliasId: deterministicUuid(
          `alias\u0000${DICTIONARY_VERSION}\u0000${ingredientId}\u0000${lookupKey}`,
        ) as InciDictionaryAliasId,
        aliasText,
        lookupKey,
      });
    }
    ingredients.push({
      ingredientId,
      canonicalName,
      canonicalLookupKey,
      aliases,
    });
  }
  if (ingredients.length === 0) throw new Error('Dictionary draft is empty');
  return {
    dictionaryVersion: DICTIONARY_VERSION,
    normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
    ingredients,
  };
}

function assertDictionaryText(value: string, label: string): void {
  if (value.length === 0 || value.length > 300 || value.trim() !== value) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function buildAnchors(
  samples: readonly ParsedSample[],
  dictionary: InciDictionarySnapshot,
): InciBenchmarkAnchor[] {
  const anchors: InciBenchmarkAnchor[] = [];
  for (const sample of samples) {
    const snapshot = canonicalizeInci(sample.parsed, dictionary);
    for (const [tokenIndex, token] of snapshot.tokens.entries()) {
      for (const [componentIndex, component] of token.components.entries()) {
        if (component.decision.kind === 'AMBIGUOUS') {
          throw new Error(
            `Ambiguous draft dictionary match at ${sample.candidate.sampleId}:${tokenIndex}:${componentIndex}`,
          );
        }
        anchors.push({
          anchorId: `${sample.candidate.sampleId}:${tokenIndex}:${componentIndex}`,
          sampleId: sample.candidate.sampleId,
          tokenIndex,
          componentIndex,
          expectedLookupText: component.lookupText,
          expectedTokenKind: token.sourceToken.kind,
          expectedPresence: token.sourceToken.presence,
          expectedDecision:
            component.decision.kind === 'RESOLVED'
              ? {
                  kind: 'RESOLVED',
                  canonicalName: component.decision.ingredient.canonicalName,
                }
              : { kind: 'UNRESOLVED' },
        });
      }
    }
  }
  if (anchors.length < INCI_BENCHMARK_MIN_ANCHORS) {
    throw new Error(
      `Draft has only ${anchors.length} anchors; need at least ${INCI_BENCHMARK_MIN_ANCHORS}`,
    );
  }
  assertMinimumDraftStrata(anchors);
  return anchors;
}

function assertMinimumDraftStrata(
  anchors: readonly InciBenchmarkAnchor[],
): void {
  const strata = [
    {
      label: 'unresolved',
      minimum: INCI_BENCHMARK_MIN_UNRESOLVED_ANCHORS,
      count: anchors.filter(
        ({ expectedDecision }) => expectedDecision.kind === 'UNRESOLVED',
      ).length,
    },
    {
      label: 'MAY_CONTAIN',
      minimum: INCI_BENCHMARK_MIN_MAY_CONTAIN_ANCHORS,
      count: anchors.filter(
        ({ expectedPresence }) => expectedPresence === 'MAY_CONTAIN',
      ).length,
    },
    {
      label: 'CI_PIGMENT',
      minimum: INCI_BENCHMARK_MIN_PIGMENT_ANCHORS,
      count: anchors.filter(
        ({ expectedTokenKind }) => expectedTokenKind === 'CI_PIGMENT',
      ).length,
    },
  ];
  for (const stratum of strata) {
    if (stratum.count < stratum.minimum) {
      throw new Error(
        `Draft has only ${stratum.count} ${stratum.label} anchors; need at least ${stratum.minimum}`,
      );
    }
  }
}

function buildCorpus(
  manifest: CandidateManifest,
  samples: readonly ParsedSample[],
  anchors: readonly InciBenchmarkAnchor[],
  dictionary: InciDictionarySnapshot,
): InciBenchmarkCorpus {
  return {
    datasetId: DATASET_ID,
    datasetVersion: DATASET_VERSION,
    dictionaryVersion: DICTIONARY_VERSION,
    dictionaryContentSha256: createHash('sha256')
      .update(serializeInciDictionarySnapshot(dictionary), 'utf8')
      .digest('hex'),
    provenance: manifest.provenance,
    review: {
      annotatedBy: 'codex/root-draft',
      reviewedBy: '',
      reviewedAt: '',
      adjudication: 'PENDING: independent review required',
    },
    samples: samples.map(({ candidate }) => ({
      sampleId: candidate.sampleId,
      gtin: candidate.gtin,
      productLabel: candidate.productLabel,
      sourceUrl: candidate.sourceUrl,
      sourceLastModifiedAt: candidate.sourceLastModifiedAt,
      retrievedAt: candidate.retrievedAt,
      rawIngredientsText: candidate.rawInciText,
      qualityFlags: candidate.qualityFlags,
    })),
    anchors,
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function comparePreferredText(left: string, right: string): number {
  return left.length - right.length || compareText(left, right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const options = parseArguments(argv.slice(2));
const manifest = await readCandidates(options.candidates);
const samples = parseSamples(selectCandidates(manifest));
const dictionary = buildDictionary(samples);
const anchors = buildAnchors(samples, dictionary);
const corpus = buildCorpus(manifest, samples, anchors, dictionary);
await writeJson(options.dictionaryOutput, dictionary);
await writeJson(options.corpusOutput, corpus);
globalThis.console.error(
  JSON.stringify({
    status: 'DRAFT_REVIEW_REQUIRED',
    samples: samples.length,
    anchors: anchors.length,
    dictionaryIngredients: dictionary.ingredients.length,
  }),
);
