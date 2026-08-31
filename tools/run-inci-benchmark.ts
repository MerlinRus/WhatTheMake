import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  evaluateInciBenchmark,
  type InciBenchmarkAnchor,
  type InciBenchmarkCorpus,
  type InciBenchmarkExpectedDecision,
  type InciBenchmarkProvenance,
  type InciBenchmarkQualityFlag,
  type InciBenchmarkReview,
  type InciBenchmarkSample,
} from '../packages/domain/src/inci-benchmark.js';
import { normalizeGtin } from '../packages/domain/src/gtin.js';
import {
  InciDictionaryValidationError,
  prepareInciDictionaryPublication,
} from '../apps/server/src/inci-dictionary/service.js';

const DEFAULT_CORPUS_PATH = 'benchmarks/mascara-inci/corpus-v1.json';
const DEFAULT_DICTIONARY_PATH = 'apps/server/seeds/inci/dictionary.json';
const MAXIMUM_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const QUALITY_FLAGS = [
  'DISCLAIMER_TEXT',
  'TRUNCATED_TEXT',
  'LEADING_PRODUCT_CODE',
  'STALE_SOURCE',
] as const satisfies readonly InciBenchmarkQualityFlag[];
const TOKEN_KINDS = ['INGREDIENT', 'CI_PIGMENT', 'UNRESOLVED'] as const;
const PRESENCES = ['DECLARED', 'MAY_CONTAIN'] as const;

type CommandErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'INVALID_INPUT_FILE'
  | 'INVALID_CORPUS_JSON'
  | 'INVALID_CORPUS_SHAPE';

class BenchmarkCommandError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BenchmarkCommandError';
  }
}

interface Command {
  corpusPath: string;
  dictionaryPath: string;
}

type JsonObject = Record<string, unknown>;

function fail(code: CommandErrorCode, message: string): never {
  throw new BenchmarkCommandError(code, message);
}

function parseCommand(arguments_: readonly string[]): Command {
  let corpusPath = DEFAULT_CORPUS_PATH;
  let dictionaryPath = DEFAULT_DICTIONARY_PATH;
  let corpusProvided = false;
  let dictionaryProvided = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== '--corpus' && argument !== '--dictionary') {
      return fail('INVALID_ARGUMENTS', `Unknown argument: ${argument ?? ''}`);
    }

    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) {
      return fail('INVALID_ARGUMENTS', `${argument} requires a path`);
    }

    if (argument === '--corpus') {
      if (corpusProvided) {
        return fail('INVALID_ARGUMENTS', '--corpus may be specified only once');
      }
      corpusPath = value;
      corpusProvided = true;
    } else {
      if (dictionaryProvided) {
        return fail(
          'INVALID_ARGUMENTS',
          '--dictionary may be specified only once',
        );
      }
      dictionaryPath = value;
      dictionaryProvided = true;
    }
    index += 1;
  }

  return {
    corpusPath: resolve(corpusPath),
    dictionaryPath: resolve(dictionaryPath),
  };
}

async function readArtifact(path: string, label: string): Promise<string> {
  const fileStats = await stat(path);
  if (!fileStats.isFile() || fileStats.size > MAXIMUM_ARTIFACT_BYTES) {
    return fail(
      'INVALID_INPUT_FILE',
      `${label} must be a regular file no larger than 2 MiB`,
    );
  }

  const bytes = await readFile(path);
  if (bytes.byteLength > MAXIMUM_ARTIFACT_BYTES) {
    return fail(
      'INVALID_INPUT_FILE',
      `${label} must be a regular file no larger than 2 MiB`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('INVALID_INPUT_FILE', `${label} must be valid UTF-8`);
  }
}

function strictObject(
  value: unknown,
  path: string,
  expectedKeys: readonly string[],
): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('INVALID_CORPUS_SHAPE', `${path} must be an object`);
  }
  const object = value as JsonObject;
  const actualKeys = Object.keys(object);
  if (
    actualKeys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => Object.hasOwn(object, key))
  ) {
    return fail(
      'INVALID_CORPUS_SHAPE',
      `${path} must contain exactly: ${expectedKeys.join(', ')}`,
    );
  }
  return object;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail('INVALID_CORPUS_SHAPE', `${path} must be an array`);
  }
  return value;
}

function nonemptyString(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    return fail(
      'INVALID_CORPUS_SHAPE',
      `${path} must be a nonempty trimmed string`,
    );
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values,
): Values[number] {
  if (
    typeof value !== 'string' ||
    !values.some((candidate) => candidate === value)
  ) {
    return fail(
      'INVALID_CORPUS_SHAPE',
      `${path} must be one of: ${values.join(', ')}`,
    );
  }
  return value as Values[number];
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(
      'INVALID_CORPUS_SHAPE',
      `${path} must be a non-negative safe integer`,
    );
  }
  return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
  const timestamp = nonemptyString(value, path);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    return fail(
      'INVALID_CORPUS_SHAPE',
      `${path} must be a canonical UTC ISO timestamp`,
    );
  }
  return timestamp;
}

function canonicalUrl(value: unknown, path: string): string {
  const urlText = nonemptyString(value, path);
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return fail('INVALID_CORPUS_SHAPE', `${path} must be a canonical URL`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.href !== urlText
  ) {
    return fail('INVALID_CORPUS_SHAPE', `${path} must be a canonical URL`);
  }
  return urlText;
}

function validGtin(value: unknown, path: string): string {
  const gtin = nonemptyString(value, path);
  if (normalizeGtin(gtin).kind !== 'VALID') {
    return fail('INVALID_CORPUS_SHAPE', `${path} must be a valid GTIN`);
  }
  return gtin;
}

function parseProvenance(value: unknown): InciBenchmarkProvenance {
  const path = 'corpus.provenance';
  const object = strictObject(value, path, [
    'label',
    'uri',
    'licenseName',
    'licenseUri',
    'attribution',
    'rightsStatus',
  ]);
  return {
    label: nonemptyString(object.label, `${path}.label`),
    uri: canonicalUrl(object.uri, `${path}.uri`),
    licenseName: nonemptyString(object.licenseName, `${path}.licenseName`),
    licenseUri: canonicalUrl(object.licenseUri, `${path}.licenseUri`),
    attribution: nonemptyString(object.attribution, `${path}.attribution`),
    rightsStatus: enumValue(object.rightsStatus, `${path}.rightsStatus`, [
      'ALLOWED',
    ] as const),
  };
}

function parseReview(value: unknown): InciBenchmarkReview {
  const path = 'corpus.review';
  const object = strictObject(value, path, [
    'annotatedBy',
    'reviewedBy',
    'reviewedAt',
    'adjudication',
  ]);
  return {
    annotatedBy: nonemptyString(object.annotatedBy, `${path}.annotatedBy`),
    reviewedBy: nonemptyString(object.reviewedBy, `${path}.reviewedBy`),
    reviewedAt: canonicalTimestamp(object.reviewedAt, `${path}.reviewedAt`),
    adjudication: nonemptyString(object.adjudication, `${path}.adjudication`),
  };
}

function parseQualityFlags(
  value: unknown,
  path: string,
): InciBenchmarkQualityFlag[] {
  const flags = arrayValue(value, path).map((flag, index) =>
    enumValue(flag, `${path}[${index}]`, QUALITY_FLAGS),
  );
  if (new Set(flags).size !== flags.length) {
    return fail('INVALID_CORPUS_SHAPE', `${path} must not contain duplicates`);
  }
  return flags;
}

function parseSample(value: unknown, index: number): InciBenchmarkSample {
  const path = `corpus.samples[${index}]`;
  const object = strictObject(value, path, [
    'sampleId',
    'gtin',
    'productLabel',
    'sourceUrl',
    'sourceLastModifiedAt',
    'retrievedAt',
    'rawIngredientsText',
    'qualityFlags',
  ]);
  return {
    sampleId: nonemptyString(object.sampleId, `${path}.sampleId`),
    gtin: validGtin(object.gtin, `${path}.gtin`),
    productLabel: nonemptyString(object.productLabel, `${path}.productLabel`),
    sourceUrl: canonicalUrl(object.sourceUrl, `${path}.sourceUrl`),
    sourceLastModifiedAt: canonicalTimestamp(
      object.sourceLastModifiedAt,
      `${path}.sourceLastModifiedAt`,
    ),
    retrievedAt: canonicalTimestamp(object.retrievedAt, `${path}.retrievedAt`),
    rawIngredientsText: nonemptyString(
      object.rawIngredientsText,
      `${path}.rawIngredientsText`,
    ),
    qualityFlags: parseQualityFlags(
      object.qualityFlags,
      `${path}.qualityFlags`,
    ),
  };
}

function parseExpectedDecision(
  value: unknown,
  path: string,
): InciBenchmarkExpectedDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('INVALID_CORPUS_SHAPE', `${path} must be an object`);
  }
  const kind = (value as JsonObject).kind;
  if (kind === 'RESOLVED') {
    const object = strictObject(value, path, ['kind', 'canonicalName']);
    return {
      kind,
      canonicalName: nonemptyString(
        object.canonicalName,
        `${path}.canonicalName`,
      ),
    };
  }
  if (kind === 'UNRESOLVED') {
    strictObject(value, path, ['kind']);
    return { kind };
  }
  return fail(
    'INVALID_CORPUS_SHAPE',
    `${path}.kind must be RESOLVED or UNRESOLVED`,
  );
}

function parseAnchor(value: unknown, index: number): InciBenchmarkAnchor {
  const path = `corpus.anchors[${index}]`;
  const object = strictObject(value, path, [
    'anchorId',
    'sampleId',
    'tokenIndex',
    'componentIndex',
    'expectedLookupText',
    'expectedTokenKind',
    'expectedPresence',
    'expectedDecision',
  ]);
  return {
    anchorId: nonemptyString(object.anchorId, `${path}.anchorId`),
    sampleId: nonemptyString(object.sampleId, `${path}.sampleId`),
    tokenIndex: nonnegativeInteger(object.tokenIndex, `${path}.tokenIndex`),
    componentIndex: nonnegativeInteger(
      object.componentIndex,
      `${path}.componentIndex`,
    ),
    expectedLookupText: nonemptyString(
      object.expectedLookupText,
      `${path}.expectedLookupText`,
    ),
    expectedTokenKind: enumValue(
      object.expectedTokenKind,
      `${path}.expectedTokenKind`,
      TOKEN_KINDS,
    ),
    expectedPresence: enumValue(
      object.expectedPresence,
      `${path}.expectedPresence`,
      PRESENCES,
    ),
    expectedDecision: parseExpectedDecision(
      object.expectedDecision,
      `${path}.expectedDecision`,
    ),
  };
}

function parseCorpus(rawArtifact: string): InciBenchmarkCorpus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArtifact) as unknown;
  } catch {
    return fail(
      'INVALID_CORPUS_JSON',
      'INCI benchmark corpus is not valid JSON',
    );
  }

  const root = strictObject(parsed, 'corpus', [
    'datasetId',
    'datasetVersion',
    'dictionaryVersion',
    'dictionaryContentSha256',
    'provenance',
    'review',
    'samples',
    'anchors',
  ]);
  const dictionaryContentSha256 = nonemptyString(
    root.dictionaryContentSha256,
    'corpus.dictionaryContentSha256',
  );
  if (!SHA256_PATTERN.test(dictionaryContentSha256)) {
    return fail(
      'INVALID_CORPUS_SHAPE',
      'corpus.dictionaryContentSha256 must be a lowercase SHA-256',
    );
  }

  return {
    datasetId: nonemptyString(root.datasetId, 'corpus.datasetId'),
    datasetVersion: nonemptyString(
      root.datasetVersion,
      'corpus.datasetVersion',
    ),
    dictionaryVersion: nonemptyString(
      root.dictionaryVersion,
      'corpus.dictionaryVersion',
    ),
    dictionaryContentSha256,
    provenance: parseProvenance(root.provenance),
    review: parseReview(root.review),
    samples: arrayValue(root.samples, 'corpus.samples').map(parseSample),
    anchors: arrayValue(root.anchors, 'corpus.anchors').map(parseAnchor),
  };
}

async function main(): Promise<boolean> {
  const command = parseCommand(process.argv.slice(2));
  const [rawCorpus, rawDictionary] = await Promise.all([
    readArtifact(command.corpusPath, 'INCI benchmark corpus'),
    readArtifact(command.dictionaryPath, 'INCI dictionary'),
  ]);
  const corpus = parseCorpus(rawCorpus);
  const dictionary = prepareInciDictionaryPublication(rawDictionary);
  const result = evaluateInciBenchmark(
    corpus,
    dictionary.snapshot,
    dictionary.contentSha256,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.kind === 'EVALUATED' && result.report.gatePassed;
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      kind: 'ERROR',
      code:
        error instanceof BenchmarkCommandError ||
        error instanceof InciDictionaryValidationError
          ? error.code
          : 'RUNTIME_ERROR',
      message:
        error instanceof Error
          ? error.message
          : 'INCI benchmark command failed',
    })}\n`,
  );
  process.exitCode = 1;
}
