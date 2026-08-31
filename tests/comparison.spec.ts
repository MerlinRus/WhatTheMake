import { expect, test, type Page } from '@playwright/test';

const firstGtin = '4006381333931';
const secondGtin = '5901234123457';
const externalGtin = '3560070791460';
const source = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Official catalog',
  sourceUrl: 'https://manufacturer.example/catalog',
  observedAt: '2026-08-31T08:00:00.000Z',
  importedAt: '2026-08-31T08:01:00.000Z',
};

function variant(
  gtin: string,
  productVariantId: string,
  productFamilyId: string,
  familyName: string,
) {
  return {
    schemaVersion: 1,
    identification: { method: 'GTIN', confidence: 'EXACT' },
    barcode: { value: gtin, format: 'EAN_13', gtin14: gtin.padStart(14, '0') },
    productVariantId,
    productFamilyId,
    category: 'MASCARA',
    brandName: 'Lash Lab',
    familyName,
    variantName: 'Black / 10 ml',
    shadeName: 'Black',
    netQuantity: { value: '10.0000', unit: 'MILLILITER' },
    isWaterproof: false,
    formula: null,
    claims: [],
    identitySources: { family: source, variant: source, barcode: source },
  };
}

const first = variant(
  firstGtin,
  'b0f9bf8f-c1d6-4803-8899-73ca3359eae2',
  'c85f8055-d0b2-4a06-8a6d-306f3c81ed1e',
  'Decision One',
);
const second = variant(
  secondGtin,
  'd8c195c0-e563-4a1b-a625-19ad756a6e93',
  'e41eac8c-b301-496a-8786-7a7f31bfdd7c',
  'Decision Two',
);

function comparisonPayload() {
  const criterionKinds = [
    'IDENTITY_AND_DATA',
    'HARD_CONSTRAINTS',
    'DESIRED_EFFECT',
    'CUSTOMER_REVIEWS',
    'FORMULA_AND_CLAIMS',
    'PRICE_AND_VALUE',
  ] as const;
  return {
    comparison: {
      schemaVersion: 1,
      rulesVersion: 'mascara-comparison-v1',
      mode: 'UNKNOWN_GOALS',
      slots: [
        {
          state: 'READY',
          slotIndex: 0,
          gtin: firstGtin,
          variant: first,
          review: null,
        },
        {
          state: 'READY',
          slotIndex: 1,
          gtin: secondGtin,
          variant: second,
          review: null,
        },
      ],
      recommendation: {
        kind: 'NO_CLEAR_WINNER',
        confidence: 'LOW',
        reasonCodes: ['REVIEW_DATA_UNAVAILABLE'],
      },
      criteria: criterionKinds.map((kind) => ({
        kind,
        observations: [0, 1].map((slotIndex) => ({
          slotIndex,
          productVariantId:
            slotIndex === 0 ? first.productVariantId : second.productVariantId,
          outcome: 'NO_DATA',
          confidence: 'LOW',
          reasonCode:
            kind === 'PRICE_AND_VALUE'
              ? 'PRICE_DATA_UNAVAILABLE'
              : 'REVIEW_DATA_UNAVAILABLE',
          explanation:
            kind === 'PRICE_AND_VALUE'
              ? 'Нет разрешённых данных о цене.'
              : 'Нет разрешённых данных об отзывах покупателей.',
          evidence: [],
        })),
      })),
    },
  };
}

async function openKnownProduct(page: Page): Promise<void> {
  await page.route(`**/api/v1/catalog/barcodes/${firstGtin}`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ variant: first }),
    }),
  );
  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(firstGtin);
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(
    page.getByRole('heading', { name: 'Decision One' }),
  ).toBeVisible();
}

test('shopper compares two exact variants and gets an honest no-winner', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/api/v1/comparisons/preview', async (route) => {
    const input = route.request().postDataJSON();
    expect(input.gtins).toEqual([firstGtin, secondGtin]);
    expect(input.brief.mode).toBe('UNKNOWN_GOALS');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(comparisonPayload()),
    });
  });
  await openKnownProduct(page);
  await page.getByRole('button', { name: 'Сравнить с другим' }).click();
  await expect(page.locator('.comparison-workspace')).toBeFocused();
  await page.getByLabel('У меня есть пожелания').check();
  await expect(page.getByLabel('Чувствительные глаза')).toBeVisible();
  await expect(page.getByLabel('Контактные линзы')).toBeVisible();
  await page.getByLabel('Не знаю — помогите выбрать').check();
  await page.getByLabel('GTIN варианта 2').fill(secondGtin);
  await page.getByRole('button', { name: 'Сравнить варианты' }).click();

  await expect(
    page.getByRole('heading', { name: 'Явного победителя нет' }),
  ).toBeVisible();
  await expect(
    page.getByText('Нет разрешённых данных об отзывах покупателей.').first(),
  ).toBeVisible();
  await expect(page.getByText('Цена и ценность')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByText('Точность вариантов')).toBeVisible();
  const desktopOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(desktopOverflow).toBe(false);
  await page.getByRole('button', { name: 'Закрыть' }).click();
  await expect(
    page.getByRole('button', { name: 'Сравнить с другим' }),
  ).toBeFocused();
});

test('unknown local GTIN automatically searches Open Beauty Facts', async ({
  page,
}) => {
  await page.route(
    `**/api/v1/catalog/barcodes/${externalGtin}`,
    async (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'e2e' },
        }),
      }),
  );
  let discoveryCalls = 0;
  await page.route(
    `**/api/v1/discovery/barcodes/${externalGtin}`,
    async (route) => {
      discoveryCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          discovery: {
            state: 'FOUND',
            candidate: {
              schemaVersion: 1,
              gtin: externalGtin,
              confidence: 'LOW',
              provider: 'OPEN_BEAUTY_FACTS',
              providerLabel: 'Open Beauty Facts',
              productUrl: `https://world.openbeautyfacts.org/product/${externalGtin}`,
              fetchedAt: '2026-08-31T09:00:00.000Z',
              brandName: 'External Brand',
              productName: 'External Mascara',
              quantity: '9 ml',
            },
          },
        }),
      });
    },
  );

  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(externalGtin);
  await page.getByRole('button', { name: 'Найти' }).click();
  await expect(
    page.getByRole('heading', { name: 'External Mascara' }),
  ).toBeVisible();
  await expect(
    page.getByText('Open Beauty Facts · данные не проверены'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Подтвердить по фото' }),
  ).toBeVisible();
  expect(discoveryCalls).toBe(1);
});
