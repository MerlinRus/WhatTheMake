import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { URL } from 'node:url';

const API_ROOT = 'https://world.openbeautyfacts.org/api/v2/product/';
const SOURCE_ROOT = 'https://world.openbeautyfacts.org/product/';
const USER_AGENT = 'WhatTheMake/0.1 (https://whatthemake.ru)';
const CONCURRENCY = 4;
const TIMEOUT_MS = 20_000;
const STALE_BEFORE_SECONDS = Date.UTC(2024, 0, 1) / 1_000;
const FIELDS = [
  'code',
  'product_name',
  'brands',
  'ingredients_text',
  'ingredients_text_en',
  'last_modified_t',
].join(',');
const QUALITY_FLAG_ORDER = [
  'DISCLAIMER_TEXT',
  'TRUNCATED_TEXT',
  'LEADING_PRODUCT_CODE',
  'STALE_SOURCE',
];

class RowFailure extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RowFailure';
    this.code = code;
  }
}

function parseArguments(arguments_) {
  const expected = new Set([
    '--seed',
    '--output',
    '--dataset-version',
    '--retrieved-at',
  ]);
  if (arguments_.length !== expected.size * 2) {
    throw new Error(
      'Expected --seed, --output, --dataset-version, and --retrieved-at',
    );
  }

  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !expected.has(name) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      throw new Error(
        'Expected --seed, --output, --dataset-version, and --retrieved-at',
      );
    }
    if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
    values.set(name, value);
  }

  const datasetVersion = values.get('--dataset-version');
  const retrievedAt = values.get('--retrieved-at');
  if (!isCanonicalDate(datasetVersion)) {
    throw new Error('--dataset-version must be a canonical YYYY-MM-DD date');
  }
  const retrievedDate = new Date(retrievedAt);
  if (
    Number.isNaN(retrievedDate.getTime()) ||
    retrievedDate.toISOString() !== retrievedAt
  ) {
    throw new Error('--retrieved-at must be a canonical UTC ISO timestamp');
  }

  const seed = resolve(values.get('--seed'));
  const output = resolve(values.get('--output'));
  if (seed === output) throw new Error('--seed and --output must differ');
  return { seed, output, datasetVersion, retrievedAt };
}

function isCanonicalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validGtin(value) {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  let sum = 0;
  let weight = 3;
  for (let index = value.length - 2; index >= 0; index -= 1) {
    sum += Number(value[index]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === Number(value.at(-1));
}

function seedProductLabel(product) {
  for (const field of ['variantName', 'familyName']) {
    if (
      typeof product[field] === 'string' &&
      product[field].trim().length > 0
    ) {
      return product[field];
    }
  }
  return null;
}

async function readSeed(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read seed JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.products)) {
    throw new Error('Seed must be an object with a products array');
  }
  if (
    typeof parsed.datasetId !== 'string' ||
    typeof parsed.datasetVersion !== 'string'
  ) {
    throw new Error('Seed datasetId and datasetVersion must be strings');
  }

  const rows = [];
  const quarantine = [];
  const seenGtins = new Set();
  for (const [index, product] of parsed.products.entries()) {
    const seedRowNumber = index + 1;
    const gtin = isRecord(product) ? product.gtin : undefined;
    const productLabel = isRecord(product) ? seedProductLabel(product) : null;
    if (typeof gtin !== 'string' || !validGtin(gtin) || productLabel === null) {
      quarantine.push({
        seedRowNumber,
        gtin: typeof gtin === 'string' ? gtin : null,
        errorCode: 'INVALID_SEED_ROW',
        detail: 'Seed row needs a valid exact GTIN and product label',
      });
      continue;
    }
    if (seenGtins.has(gtin)) {
      quarantine.push({
        seedRowNumber,
        gtin,
        errorCode: 'DUPLICATE_SEED_GTIN',
        detail: 'GTIN already appeared in the seed',
      });
      continue;
    }
    seenGtins.add(gtin);
    rows.push({ seedRowNumber, gtin, productLabel });
  }

  return {
    seedDatasetId: parsed.datasetId,
    seedDatasetVersion: parsed.datasetVersion,
    seedRows: parsed.products.length,
    rows,
    quarantine,
  };
}

function assertOptionalString(product, field) {
  const value = product[field];
  if (value !== undefined && typeof value !== 'string') {
    throw new RowFailure(
      'INVALID_RESPONSE_SHAPE',
      `${field} must be a string when present`,
    );
  }
}

function parseResponse(body, requestedGtin) {
  if (
    !isRecord(body) ||
    (body.status !== 0 && body.status !== 1) ||
    typeof body.code !== 'string'
  ) {
    throw new RowFailure(
      'INVALID_RESPONSE_SHAPE',
      'Response needs numeric status and string code',
    );
  }
  if (body.code !== requestedGtin) {
    throw new RowFailure(
      'GTIN_MISMATCH',
      `Response code ${body.code} does not match requested GTIN`,
    );
  }
  if (body.status === 0) {
    throw new RowFailure('PRODUCT_NOT_FOUND', 'Exact GTIN was not found');
  }
  if (!isRecord(body.product) || body.product.code !== requestedGtin) {
    throw new RowFailure(
      'INVALID_RESPONSE_SHAPE',
      'Product needs the exact requested code',
    );
  }

  const product = body.product;
  for (const field of [
    'product_name',
    'brands',
    'ingredients_text',
    'ingredients_text_en',
  ]) {
    assertOptionalString(product, field);
  }
  if (
    !Number.isSafeInteger(product.last_modified_t) ||
    product.last_modified_t < 0
  ) {
    throw new RowFailure(
      'INVALID_RESPONSE_SHAPE',
      'last_modified_t must be a non-negative integer',
    );
  }

  const ingredientsField =
    typeof product.ingredients_text === 'string' &&
    product.ingredients_text.trim().length > 0
      ? 'ingredients_text'
      : typeof product.ingredients_text_en === 'string' &&
          product.ingredients_text_en.trim().length > 0
        ? 'ingredients_text_en'
        : null;
  if (ingredientsField === null) {
    throw new RowFailure('EMPTY_INCI', 'No nonempty INCI text was returned');
  }

  return {
    product,
    rawInciField: ingredientsField,
    rawInciText: product[ingredientsField],
  };
}

function qualityFlags(rawInciText, gtin, lastModifiedSeconds) {
  const flags = new Set();
  if (
    /(?:ingredients?|formulas?|formulations?).{0,120}(?:change|vary|differ|updated)|(?:check|refer to|consult).{0,100}(?:package|packaging|label).{0,100}(?:ingredient|current)/isu.test(
      rawInciText,
    )
  ) {
    flags.add('DISCLAIMER_TEXT');
  }
  if (/(?:\u2026|\.{3,})/u.test(rawInciText)) {
    flags.add('TRUNCATED_TEXT');
  }
  if (new RegExp(`^\\s*${gtin}(?:\\s|[-:;,])`).test(rawInciText)) {
    flags.add('LEADING_PRODUCT_CODE');
  }
  if (lastModifiedSeconds < STALE_BEFORE_SECONDS) {
    flags.add('STALE_SOURCE');
  }
  return QUALITY_FLAG_ORDER.filter((flag) => flags.has(flag));
}

function productUrl(gtin) {
  return `${SOURCE_ROOT}${encodeURIComponent(gtin)}`;
}

async function fetchRow(row, retrievedAt) {
  const url = new URL(encodeURIComponent(row.gtin), API_ROOT);
  url.searchParams.set('fields', FIELDS);
  try {
    const response = await globalThis.fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
      },
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new RowFailure(
        'HTTP_ERROR',
        `Open Beauty Facts returned HTTP ${response.status}`,
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new RowFailure('INVALID_JSON', 'Response is not valid JSON');
    }
    const parsed = parseResponse(body, row.gtin);
    const sourceLastModifiedAt = new Date(
      parsed.product.last_modified_t * 1_000,
    ).toISOString();
    return {
      kind: 'candidate',
      value: {
        sampleId: `obf-${row.gtin}`,
        gtin: row.gtin,
        productLabel: row.productLabel,
        sourceUrl: productUrl(row.gtin),
        sourceProductName: parsed.product.product_name ?? null,
        sourceBrands: parsed.product.brands ?? null,
        sourceLastModifiedAt,
        retrievedAt,
        rawInciField: parsed.rawInciField,
        rawInciText: parsed.rawInciText,
        qualityFlags: qualityFlags(
          parsed.rawInciText,
          row.gtin,
          parsed.product.last_modified_t,
        ),
      },
    };
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      kind: 'quarantine',
      value: {
        seedRowNumber: row.seedRowNumber,
        gtin: row.gtin,
        errorCode:
          error instanceof RowFailure
            ? error.code
            : isTimeout
              ? 'FETCH_TIMEOUT'
              : 'FETCH_FAILED',
        detail: errorMessage(error),
      },
    };
  }
}

async function mapConcurrent(rows, mapper) {
  const results = new Array(rows.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < rows.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(rows[index]);
    }
  }
  const workerCount = Math.min(CONCURRENCY, rows.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown error';
}

const options = parseArguments(argv.slice(2));
const seed = await readSeed(options.seed);
const results = await mapConcurrent(seed.rows, (row) =>
  fetchRow(row, options.retrievedAt),
);
const candidates = results
  .filter((result) => result.kind === 'candidate')
  .map((result) => result.value)
  .toSorted((left, right) => left.gtin.localeCompare(right.gtin));
const quarantine = [
  ...seed.quarantine,
  ...results
    .filter((result) => result.kind === 'quarantine')
    .map((result) => result.value),
].toSorted(
  (left, right) =>
    (left.gtin ?? '').localeCompare(right.gtin ?? '') ||
    left.seedRowNumber - right.seedRowNumber ||
    left.errorCode.localeCompare(right.errorCode),
);
const complete = candidates.length + quarantine.length === seed.seedRows;
if (!complete) {
  throw new Error('Internal error: not every seed row has one outcome');
}

const manifest = {
  schemaVersion: 1,
  datasetId: 'open-beauty-facts-mascara-inci-candidates',
  datasetVersion: options.datasetVersion,
  source: {
    label: 'Open Beauty Facts (ODbL 1.0)',
    uri: 'https://world.openbeautyfacts.org/',
    licenseName: 'Open Database License (ODbL) 1.0',
    licenseUri: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution:
      'Contains information from Open Beauty Facts, made available under the Open Database License (ODbL) 1.0.',
    retrievedAt: options.retrievedAt,
  },
  seed: {
    datasetId: seed.seedDatasetId,
    datasetVersion: seed.seedDatasetVersion,
  },
  candidates,
  quarantine,
  report: {
    seedRows: seed.seedRows,
    exactGtinRequests: seed.rows.length,
    candidates: candidates.length,
    quarantined: quarantine.length,
    complete,
  },
};

await mkdir(dirname(options.output), { recursive: true });
await writeFile(
  options.output,
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
globalThis.console.error(JSON.stringify(manifest.report));
