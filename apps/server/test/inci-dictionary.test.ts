import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  canonicalizeInci,
  INCI_LOOKUP_NORMALIZER_VERSION,
  parseInci,
  serializeInciDictionarySnapshot,
} from '@wtm/domain';

import {
  InciDictionaryValidationError,
  prepareInciDictionaryPublication,
  type InciDictionaryValidationCode,
} from '../src/inci-dictionary/service.js';
import {
  decodeInciDictionaryArtifact,
  MAXIMUM_DICTIONARY_BYTES,
} from '../src/cli/seed-inci-dictionary.js';

interface DictionaryAliasArtifact {
  aliasId: string;
  aliasText: string;
  lookupKey: string;
}

interface DictionaryIngredientArtifact {
  ingredientId: string;
  canonicalName: string;
  canonicalLookupKey: string;
  aliases: DictionaryAliasArtifact[];
}

interface DictionaryArtifact {
  dictionaryVersion: string;
  normalizerVersion: string;
  ingredients: DictionaryIngredientArtifact[];
}

function artifact(): DictionaryArtifact {
  return {
    dictionaryVersion: 'mascara-inci-v1',
    normalizerVersion: INCI_LOOKUP_NORMALIZER_VERSION,
    ingredients: [
      {
        ingredientId: '00000000-0000-0000-0000-000000000001',
        canonicalName: 'Aqua',
        canonicalLookupKey: 'aqua',
        aliases: [
          {
            aliasId: '00000000-0000-0000-0000-000000000101',
            aliasText: 'AQUA / WATER / EAU',
            lookupKey: 'aqua / water / eau',
          },
          {
            aliasId: '00000000-0000-0000-0000-000000000102',
            aliasText: 'Water',
            lookupKey: 'water',
          },
        ],
      },
      {
        ingredientId: '00000000-0000-0000-0000-000000000002',
        canonicalName: 'Glycerin',
        canonicalLookupKey: 'glycerin',
        aliases: [
          {
            aliasId: '00000000-0000-0000-0000-000000000201',
            aliasText: 'Glycerol',
            lookupKey: 'glycerol',
          },
        ],
      },
    ],
  };
}

function expectValidationCode(
  value: unknown,
  code: InciDictionaryValidationCode,
): void {
  const rawArtifact = typeof value === 'string' ? value : JSON.stringify(value);
  assert.throws(
    () => prepareInciDictionaryPublication(rawArtifact),
    (error: unknown) => {
      assert.ok(error instanceof InciDictionaryValidationError);
      assert.equal(error.code, code);
      return true;
    },
  );
}

test('dictionary artifact boundary rejects invalid UTF-8', () => {
  assert.throws(
    () => decodeInciDictionaryArtifact(Buffer.from([0xc3, 0x28])),
    /INCI dictionary must be valid UTF-8/u,
  );
});

test('dictionary artifact boundary enforces exact and oversized byte lengths', () => {
  const boundary = Buffer.alloc(MAXIMUM_DICTIONARY_BYTES, 0x61);
  assert.equal(
    Buffer.byteLength(decodeInciDictionaryArtifact(boundary), 'utf8'),
    MAXIMUM_DICTIONARY_BYTES,
  );

  assert.throws(
    () =>
      decodeInciDictionaryArtifact(
        Buffer.alloc(MAXIMUM_DICTIONARY_BYTES + 1, 0x61),
      ),
    /INCI dictionary must be a regular file no larger than 2 MiB/u,
  );
});

test('dictionary publication is deterministic across JSON formatting', () => {
  const source = artifact();
  const compact = prepareInciDictionaryPublication(JSON.stringify(source));
  const pretty = prepareInciDictionaryPublication(
    JSON.stringify(source, null, 2),
  );

  assert.deepEqual(pretty, compact);
  assert.deepEqual(compact.snapshot, source);
  assert.equal(
    compact.contentSha256,
    createHash('sha256')
      .update(serializeInciDictionarySnapshot(compact.snapshot), 'utf8')
      .digest('hex'),
  );
  assert.match(compact.contentSha256, /^[0-9a-f]{64}$/u);
});

test('dictionary publication accepts inclusive entry-count boundaries', () => {
  const one = artifact();
  one.ingredients = [one.ingredients[0]!];
  assert.equal(
    prepareInciDictionaryPublication(JSON.stringify(one)).snapshot.ingredients
      .length,
    1,
  );

  const maximum = artifact();
  maximum.ingredients = Array.from({ length: 5_000 }, (_, index) => {
    const suffix = index.toString(16).padStart(12, '0');
    const ordinal = index.toString().padStart(4, '0');
    return {
      ingredientId: `00000000-0000-0000-0000-${suffix}`,
      canonicalName: `Ingredient ${ordinal}`,
      canonicalLookupKey: `ingredient ${ordinal}`,
      aliases: [],
    };
  });
  assert.equal(
    prepareInciDictionaryPublication(JSON.stringify(maximum)).snapshot
      .ingredients.length,
    5_000,
  );
});

test('dictionary publication rejects invalid JSON and unknown fields', () => {
  expectValidationCode('{not-json', 'INVALID_JSON');

  const root = artifact();
  Object.assign(root, { unexpected: true });
  expectValidationCode(root, 'INVALID_SHAPE');

  const ingredient = artifact();
  Object.assign(ingredient.ingredients[0]!, { unexpected: true });
  expectValidationCode(ingredient, 'INVALID_SHAPE');

  const alias = artifact();
  Object.assign(alias.ingredients[0]!.aliases[0]!, { unexpected: true });
  expectValidationCode(alias, 'INVALID_SHAPE');
});

test('dictionary publication rejects invalid shape and entry counts', () => {
  const wrongShape = artifact();
  Object.assign(wrongShape, { ingredients: 'not-an-array' });
  expectValidationCode(wrongShape, 'INVALID_SHAPE');

  const empty = artifact();
  empty.ingredients = [];
  expectValidationCode(empty, 'INVALID_ENTRY_COUNT');

  const tooMany = artifact();
  tooMany.ingredients = Array.from(
    { length: 5_001 },
    () => tooMany.ingredients[0]!,
  );
  expectValidationCode(tooMany, 'INVALID_ENTRY_COUNT');
});

test('dictionary publication rejects invalid version and normalizer', () => {
  const version = artifact();
  version.dictionaryVersion = '.invalid';
  expectValidationCode(version, 'INVALID_VERSION');

  const longVersion = artifact();
  longVersion.dictionaryVersion = `v${'1'.repeat(100)}`;
  expectValidationCode(longVersion, 'INVALID_VERSION');

  const normalizer = artifact();
  normalizer.normalizerVersion = 'inci-lookup-v999';
  expectValidationCode(normalizer, 'INVALID_NORMALIZER_VERSION');
});

test('dictionary publication rejects invalid UUIDs, names, and lookup keys', () => {
  const ingredientUuid = artifact();
  ingredientUuid.ingredients[0]!.ingredientId =
    '00000000-0000-0000-0000-00000000000A';
  expectValidationCode(ingredientUuid, 'INVALID_UUID');

  const aliasUuid = artifact();
  aliasUuid.ingredients[0]!.aliases[0]!.aliasId = 'not-a-uuid';
  expectValidationCode(aliasUuid, 'INVALID_UUID');

  const canonicalName = artifact();
  canonicalName.ingredients[0]!.canonicalName = ' Aqua';
  expectValidationCode(canonicalName, 'INVALID_NAME');

  const aliasName = artifact();
  aliasName.ingredients[0]!.aliases[0]!.aliasText = '';
  expectValidationCode(aliasName, 'INVALID_NAME');

  const longName = artifact();
  longName.ingredients[0]!.canonicalName = 'A'.repeat(301);
  expectValidationCode(longName, 'INVALID_NAME');

  const canonicalLookup = artifact();
  canonicalLookup.ingredients[0]!.canonicalLookupKey = 'not-aqua';
  expectValidationCode(canonicalLookup, 'INVALID_LOOKUP_KEY');

  const aliasLookup = artifact();
  aliasLookup.ingredients[0]!.aliases[0]!.lookupKey = 'not-normalized';
  expectValidationCode(aliasLookup, 'INVALID_LOOKUP_KEY');
});

test('dictionary publication rejects duplicate identities and mappings', () => {
  const duplicateIngredientId = artifact();
  duplicateIngredientId.ingredients[1]!.ingredientId =
    duplicateIngredientId.ingredients[0]!.ingredientId;
  expectValidationCode(duplicateIngredientId, 'DUPLICATE_ID');

  const duplicateAliasId = artifact();
  duplicateAliasId.ingredients[1]!.aliases[0]!.aliasId =
    duplicateAliasId.ingredients[0]!.aliases[0]!.aliasId;
  expectValidationCode(duplicateAliasId, 'DUPLICATE_ID');

  const duplicateCanonical = artifact();
  duplicateCanonical.ingredients[1]!.canonicalName = 'AQUA';
  duplicateCanonical.ingredients[1]!.canonicalLookupKey = 'aqua';
  expectValidationCode(duplicateCanonical, 'DUPLICATE_CANONICAL_KEY');

  const duplicateAliasMapping = artifact();
  duplicateAliasMapping.ingredients[0]!.aliases.push({
    ...duplicateAliasMapping.ingredients[0]!.aliases[0]!,
    aliasId: '00000000-0000-0000-0000-000000000103',
  });
  expectValidationCode(duplicateAliasMapping, 'DUPLICATE_ALIAS_MAPPING');
});

test('dictionary publication preserves cautious cross-ingredient ambiguity', () => {
  const ambiguous = artifact();
  ambiguous.ingredients[0]!.aliases.splice(1, 0, {
    aliasId: '00000000-0000-0000-0000-000000000103',
    aliasText: 'Shared',
    lookupKey: 'shared',
  });
  ambiguous.ingredients[1]!.aliases.push({
    aliasId: '00000000-0000-0000-0000-000000000202',
    aliasText: 'Shared',
    lookupKey: 'shared',
  });
  const publication = prepareInciDictionaryPublication(
    JSON.stringify(ambiguous),
  );
  const parsed = parseInci('Shared');
  assert.equal(parsed.kind, 'PARSED');
  if (parsed.kind !== 'PARSED') return;
  assert.equal(
    canonicalizeInci(parsed, publication.snapshot).tokens[0]?.components[0]
      ?.decision.kind,
    'AMBIGUOUS',
  );
});

test('dictionary publication rejects nondeterministic ingredient and alias order', () => {
  const ingredients = artifact();
  ingredients.ingredients.reverse();
  expectValidationCode(ingredients, 'NON_DETERMINISTIC_ORDER');

  const aliases = artifact();
  aliases.ingredients[0]!.aliases.reverse();
  expectValidationCode(aliases, 'NON_DETERMINISTIC_ORDER');
});
