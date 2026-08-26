import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argv } from 'node:process';
import { URL } from 'node:url';

const API_URL = 'https://world.openbeautyfacts.org/cgi/search.pl';
const USER_AGENT = 'WhatTheMake/0.1 (https://whatthemake.ru)';
const PAGE_SIZE = 100;
const TARGET_SIZE = 240;
const SEARCH_TERMS = [
  'mascara',
  'maskara',
  'wimperntusche',
  'rimel',
  'rímel',
  'mascara pour cils',
  'máscara de pestañas',
  'cils',
  'pestañas',
  'tusz do rzęs',
  'rzęs',
  'mascara per ciglia',
  'ciglia',
  'тушь для ресниц',
  'lash',
  'eye mascara',
];
const FIELDS = [
  'code',
  'brands',
  'product_name',
  'product_name_en',
  'generic_name',
  'generic_name_en',
  'categories_tags',
  'product_quantity',
  'product_quantity_unit',
].join(',');

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith('--') || !value) {
      throw new Error(
        'Expected --output, --dataset-version, and --retrieved-at',
      );
    }
    values.set(name, value);
  }
  const output = values.get('--output');
  const datasetVersion = values.get('--dataset-version');
  const retrievedAt = values.get('--retrieved-at');
  if (!output || !datasetVersion || !retrievedAt || values.size !== 3) {
    throw new Error('Expected --output, --dataset-version, and --retrieved-at');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datasetVersion)) {
    throw new Error('--dataset-version must be YYYY-MM-DD');
  }
  const retrievedDate = new Date(retrievedAt);
  if (
    Number.isNaN(retrievedDate.getTime()) ||
    retrievedDate.toISOString() !== retrievedAt
  ) {
    throw new Error('--retrieved-at must be a canonical UTC ISO timestamp');
  }
  return { output: resolve(output), datasetVersion, retrievedAt };
}

function text(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
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

function tags(product) {
  return Array.isArray(product.categories_tags)
    ? product.categories_tags.filter((value) => typeof value === 'string')
    : [];
}

function isMascara(product) {
  const categoryTags = tags(product).map((value) => value.toLocaleLowerCase());
  const categoryText = categoryTags.join(' ');
  if (
    /en:hair|hair-care|hair-mask|capilar|facial|face-mask|skin-care|micell|cleansing|wipe|make-up-remover|démaqu|reinig/.test(
      categoryText,
    )
  ) {
    return false;
  }
  const name = text(product.product_name) || text(product.product_name_en);
  const lowerName = name.toLocaleLowerCase();
  if (
    /elvive|tratamiento|capilar|cabell|cabelo|hidrata|argila|facial|hair mask|nutri|lipliner|lip liner|eyeliner|eye liner/.test(
      lowerName,
    )
  ) {
    return false;
  }
  const hasLashWord = /lash|eyelash|pestañ|cils|wimper|ресниц|rzęs|ciglia/.test(
    lowerName,
  );
  if (/brow|eyebrow|ceja|sobrancelha|kaş/.test(lowerName) && !hasLashWord) {
    return false;
  }
  if (categoryTags.includes('en:mascara')) return true;
  if (/\bmascaras?\b/.test(lowerName)) return true;
  if (/\bm[áa]scara\b/.test(lowerName)) return true;
  if (/maskara|wimperntusche|r[ií]mel|тушь/.test(lowerName)) return true;
  if (
    /máscara.*pestañ|mascara.*cils|tusz.*rzęs|mascara.*ciglia/.test(lowerName)
  ) {
    return true;
  }
  const genericName = (
    text(product.generic_name) || text(product.generic_name_en)
  ).toLocaleLowerCase();
  return /^(?:mascara|máscara (?:para|de) pestañas)$/.test(genericName);
}

function quantity(product) {
  const value = product.product_quantity;
  const unit = text(product.product_quantity_unit).toLocaleLowerCase();
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 99_999_999.9999 ||
    !['ml', 'g'].includes(unit)
  ) {
    return null;
  }
  const canonical = value.toFixed(4).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, '');
  return {
    value: canonical,
    unit: unit === 'ml' ? 'MILLILITER' : 'GRAM',
  };
}

function brandFromName(productName, brandLexicon) {
  const lowerName = productName.toLocaleLowerCase();
  return (
    brandLexicon.find((brand) => {
      const lowerBrand = brand.toLocaleLowerCase();
      return (
        lowerName === lowerBrand ||
        lowerName.startsWith(`${lowerBrand} `) ||
        lowerName.startsWith(`${lowerBrand}:`)
      );
    }) ?? ''
  );
}

function parseProduct(raw, rank, brandLexicon) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const code = text(raw.code);
  const productName = text(raw.product_name) || text(raw.product_name_en);
  const brandName =
    brandFromName(productName, brandLexicon) || text(raw.brands);
  if (
    !validGtin(code) ||
    brandName.length === 0 ||
    brandName.length > 200 ||
    productName.length === 0 ||
    productName.length > 300 ||
    !isMascara(raw)
  ) {
    return null;
  }
  return {
    rank,
    product: {
      sourceRecordId: code,
      gtin: code,
      brandName,
      familyName: productName,
      variantName: productName,
      shadeName: null,
      netQuantity: quantity(raw),
      isWaterproof: null,
    },
  };
}

async function page(term, pageNumber) {
  const url = new URL(API_URL);
  url.searchParams.set('search_terms', term);
  url.searchParams.set('search_simple', '1');
  url.searchParams.set('action', 'process');
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', String(PAGE_SIZE));
  url.searchParams.set('page', String(pageNumber));
  url.searchParams.set('fields', FIELDS);
  const response = await globalThis.fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: globalThis.AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`Open Beauty Facts HTTP ${response.status}`);
  const body = await response.json();
  const count =
    typeof body?.count === 'number'
      ? body.count
      : typeof body?.count === 'string' && /^\d+$/.test(body.count)
        ? Number(body.count)
        : Number.NaN;
  if (
    typeof body !== 'object' ||
    body === null ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Array.isArray(body.products)
  ) {
    throw new Error(
      `Open Beauty Facts response shape is invalid for ${term} page ${pageNumber}: count=${typeof body?.count}, products=${Array.isArray(body?.products)}`,
    );
  }
  return { count, products: body.products };
}

async function fetchProducts() {
  const rawProducts = new Map();
  let rank = 0;
  for (const term of SEARCH_TERMS) {
    const sizeBeforeTerm = rawProducts.size;
    const first = await page(term, 1);
    const pages = Math.max(1, Math.ceil(first.count / PAGE_SIZE));
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const body = pageNumber === 1 ? first : await page(term, pageNumber);
      for (const raw of body.products) {
        const code = text(raw?.code);
        const candidate = code === '' ? null : { rank, raw };
        rank += 1;
        if (!candidate) continue;
        const existing = rawProducts.get(code);
        if (!existing || candidate.rank < existing.rank) {
          rawProducts.set(code, candidate);
        }
      }
    }
    globalThis.console.error(
      JSON.stringify({
        term,
        apiCount: first.count,
        added: rawProducts.size - sizeBeforeTerm,
      }),
    );
  }
  const brandLexicon = [
    ...new Set(
      [...rawProducts.values()].flatMap(({ raw }) =>
        text(raw?.brands)
          .split(/[,;]/)
          .map(text)
          .filter((brand) => brand.length >= 2 && brand.length <= 200),
      ),
    ),
  ].toSorted((left, right) => right.length - left.length);
  return [...rawProducts.values()]
    .map(({ raw, rank }) => parseProduct(raw, rank, brandLexicon))
    .filter((candidate) => candidate !== null);
}

const options = parseArguments(argv.slice(2));
const candidates = await fetchProducts();
if (candidates.length < 200) {
  throw new Error(
    `Only ${candidates.length} eligible mascara products; need 200`,
  );
}
const products = candidates
  .toSorted((left, right) => left.rank - right.rank)
  .slice(0, TARGET_SIZE)
  .map(({ product }) => product)
  .toSorted((left, right) => left.gtin.localeCompare(right.gtin));
const manifest = {
  schemaVersion: 1,
  datasetId: 'open-beauty-facts-mascara',
  datasetVersion: options.datasetVersion,
  source: {
    label: 'Open Beauty Facts (ODbL 1.0)',
    uri: 'https://world.openbeautyfacts.org/',
    licenseName: 'Open Database License (ODbL) 1.0',
    licenseUri: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution:
      'Contains information from Open Beauty Facts, made available under the Open Database License (ODbL) 1.0.',
    rightsStatus: 'ALLOWED',
    retrievedAt: options.retrievedAt,
  },
  products,
};
await mkdir(dirname(options.output), { recursive: true });
await writeFile(
  options.output,
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);
globalThis.console.info(
  JSON.stringify({
    output: options.output,
    eligible: candidates.length,
    written: products.length,
  }),
);
