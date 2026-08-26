import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogPromotionFingerprintMaterial,
  normalizeCatalogPromotionIdentity,
} from '../src/product-observation.js';
import type { Gtin14 } from '../src/gtin.js';

test('catalog promotion identity normalizes labels and decimal quantity', () => {
  const normalized = normalizeCatalogPromotionIdentity({
    brandName: '  Lash   Lab  ',
    familyName: 'Ｆｏｃｕｓ',
    variantName: ' Black ',
    shadeName: '  Deep   Black ',
    netQuantity: { value: '0010.5000', unit: 'MILLILITER' },
    isWaterproof: false,
  });

  assert.deepEqual(normalized, {
    brandName: 'Lash Lab',
    familyName: 'Focus',
    variantName: 'Black',
    shadeName: 'Deep Black',
    netQuantityValue: '10.5',
    netQuantityUnit: 'MILLILITER',
    waterproof: false,
  });
});

test('catalog promotion fingerprint ignores harmless formatting only', () => {
  const first = normalizeCatalogPromotionIdentity({
    brandName: 'Lash Lab',
    familyName: 'Focus',
    variantName: 'Black',
    shadeName: null,
    netQuantity: { value: '10', unit: 'MILLILITER' },
    isWaterproof: false,
  });
  const equivalent = normalizeCatalogPromotionIdentity({
    brandName: ' lash  lab ',
    familyName: 'ＦＯＣＵＳ',
    variantName: 'BLACK',
    shadeName: null,
    netQuantity: { value: '10.0000', unit: 'MILLILITER' },
    isWaterproof: false,
  });
  const different = normalizeCatalogPromotionIdentity({
    brandName: 'Lash Lab',
    familyName: 'Focus',
    variantName: 'Black',
    shadeName: null,
    netQuantity: { value: '10', unit: 'MILLILITER' },
    isWaterproof: true,
  });
  assert.ok(first && equivalent && different);
  const gtin14 = '05901234123457' as Gtin14;
  assert.equal(
    catalogPromotionFingerprintMaterial(gtin14, first),
    catalogPromotionFingerprintMaterial(gtin14, equivalent),
  );
  assert.notEqual(
    catalogPromotionFingerprintMaterial(gtin14, first),
    catalogPromotionFingerprintMaterial(gtin14, different),
  );
});

test('catalog promotion identity rejects zero quantity', () => {
  assert.equal(
    normalizeCatalogPromotionIdentity({
      brandName: 'Lash Lab',
      familyName: 'Focus',
      variantName: 'Black',
      shadeName: null,
      netQuantity: { value: '0.0000', unit: 'MILLILITER' },
      isWaterproof: null,
    }),
    null,
  );
});
