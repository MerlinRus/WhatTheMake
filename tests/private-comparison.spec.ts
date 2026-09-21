import { expect, test, type Page } from '@playwright/test';

const gtin = '5901234123457';
const catalogGtin = '4006381333931';
const observationId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const snapshotId = '33333333-3333-4333-8333-333333333333';
const secondId = '44444444-4444-4444-8444-444444444444';
const date = '2026-09-20T00:00:00.000Z';
const revision = {
  revisionId,
  revisionNumber: 1,
  source: { kind: 'USER_TRANSCRIPTION' },
  sourceText: 'Aqua, Beeswax',
  sourceSha256: 'a'.repeat(64),
  authorKind: 'GUEST',
  createdAt: date,
};
const first = {
  snapshotId,
  observationId,
  snapshotNumber: 1,
  category: 'MASCARA',
  barcode: { value: gtin, format: 'EAN_13', gtin14: gtin.padStart(14, '0') },
  identity: {
    brandName: 'Own First',
    familyName: 'Mascara One',
    variantName: 'Black',
    shadeName: null,
    netQuantity: null,
    isWaterproof: null,
  },
  identitySource: 'USER_CONFIRMED_PACKAGING',
  revision,
  formulaComplete: false,
  claimKinds: [],
  claimsSource: 'USER_CONFIRMED_PACKAGING',
  priceKopecks: 59900,
  priceSource: 'USER_ENTERED',
  createdAt: date,
};
const second = {
  ...first,
  snapshotId: secondId,
  observationId: '55555555-5555-4555-8555-555555555555',
  barcode: {
    value: catalogGtin,
    format: 'EAN_13',
    gtin14: catalogGtin.padStart(14, '0'),
  },
  identity: {
    ...first.identity,
    brandName: 'Own Second',
    familyName: 'Mascara Two',
  },
  formulaComplete: true,
  priceKopecks: null,
  priceSource: null,
};
const source = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Official source',
  sourceUrl: 'https://manufacturer.example/product',
  observedAt: date,
  importedAt: date,
};
const catalog = {
  schemaVersion: 1,
  identification: { method: 'GTIN', confidence: 'EXACT' },
  barcode: second.barcode,
  productVariantId: '66666666-6666-4666-8666-666666666666',
  productFamilyId: '77777777-7777-4777-8777-777777777777',
  category: 'MASCARA',
  brandName: 'Catalog Choice',
  familyName: 'Mascara Three',
  variantName: 'Black',
  shadeName: null,
  netQuantity: null,
  isWaterproof: true,
  formula: null,
  claims: [],
  identitySources: { family: source, variant: source, barcode: source },
};

function comparison(mixed = false, mode = 'UNKNOWN_GOALS') {
  return {
    comparison: {
      schemaVersion: 1,
      rulesVersion: 'private-mascara-comparison-v1',
      mode,
      slots: [
        { state: 'PRIVATE_READY', slotIndex: 0, snapshot: first },
        mixed
          ? {
              state: 'CATALOG_READY',
              slotIndex: 1,
              gtin: catalogGtin,
              variant: catalog,
              review: null,
            }
          : { state: 'PRIVATE_READY', slotIndex: 1, snapshot: second },
      ],
      warnings: ['Личные сведения не проверены производителем.'],
      recommendation: mixed
        ? {
            kind: 'PREFERRED',
            slotIndex: 1,
            framing: 'BETTER_FIT',
            confidence: 'MEDIUM',
            reasonCodes: ['WATERPROOF_MATCH'],
          }
        : {
            kind: 'NO_CLEAR_WINNER',
            confidence: 'LOW',
            reasonCodes: ['REVIEW_DATA_UNAVAILABLE'],
          },
      criteria: [
        'IDENTITY_AND_DATA',
        'HARD_CONSTRAINTS',
        'DESIRED_EFFECT',
        'CUSTOMER_REVIEWS',
        'FORMULA_AND_CLAIMS',
        'PRICE_AND_VALUE',
      ].map((kind) => ({
        kind,
        observations: [0, 1].map((slotIndex) => ({
          slotIndex,
          outcome: 'NO_DATA',
          confidence: 'LOW',
          reasonCode: 'NO_SUPPORTED_DIFFERENCE',
          explanation: 'Нет подтверждённых различий по этому критерию.',
          evidence: [],
        })),
      })),
    },
  };
}

async function openComparison(page: Page, listFails = false) {
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({
      json: {
        principal: {
          kind: 'GUEST',
          guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          createdAt: date,
        },
      },
    }),
  );
  await page.route(`**/api/v1/catalog/barcodes/${gtin}`, (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'test' },
      },
    }),
  );
  await page.route(`**/api/v1/discovery/barcodes/${gtin}`, (route) =>
    route.fulfill({
      json: {
        discovery: { state: 'NOT_FOUND', gtin, provider: 'OPEN_BEAUTY_FACTS' },
      },
    }),
  );
  await page.route('**/api/v1/guest-sessions', (route) =>
    route.fulfill({
      json: {
        principal: {
          kind: 'GUEST',
          guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          createdAt: date,
        },
      },
    }),
  );
  await page.route('**/api/v1/product-observations', (route) =>
    route.fulfill({
      json: {
        observation: {
          schemaVersion: 1,
          observationId,
          barcode: first.barcode,
          mediaCollection: {
            collectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            assets: [],
            createdAt: date,
          },
          createdAt: date,
          updatedAt: date,
        },
      },
    }),
  );
  await page.route(
    `**/api/v1/product-observations/${observationId}/inci-revisions`,
    (route) =>
      route.fulfill({
        json: {
          workspace: {
            original: revision,
            latest: revision,
            revisionCount: 1,
            maxRevisions: 50,
          },
        },
      }),
  );
  await page.route(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
    (route) =>
      route.fulfill({
        status: 201,
        json: { resultKind: 'CREATED', snapshot: first },
      }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) =>
    listFails
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { snapshots: [first, second] } }),
  );
  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить по фото' }).click();
  await page.getByLabel('Бренд', { exact: true }).fill('Own First');
  await page
    .getByLabel('Название продукта', { exact: true })
    .fill('Mascara One');
  await page.getByLabel('Вариант продукта', { exact: true }).fill('Black');
  await page.getByLabel('Это тушь для ресниц', { exact: false }).check();
  await page.getByLabel('Я сверил(а)', { exact: false }).check();
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(
    page.getByRole('heading', { name: 'С чем сравнить личную карточку?' }),
  ).toBeVisible();
  return page.locator('.private-comparison');
}

test('private comparison selects another owned snapshot with honest unknown-goals result', async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route('**/api/v1/comparisons/private-preview', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: comparison() });
  });
  const ui = await openComparison(page);
  await expect(ui.getByLabel('Не знаю — помогите выбрать')).toBeChecked();
  await expect(
    ui.getByLabel('Вторая личная карточка').locator('option'),
  ).toHaveCount(2);
  await ui.getByLabel('Вторая личная карточка').selectOption(secondId);
  await ui.getByRole('button', { name: 'Сравнить с личной карточкой' }).click();
  await expect(
    ui.getByRole('heading', { name: 'Явного победителя нет' }),
  ).toBeVisible();
  expect(requests[0]).toEqual({
    schemaVersion: 1,
    slots: [
      { kind: 'PRIVATE', snapshotId },
      { kind: 'PRIVATE', snapshotId: secondId },
    ],
    brief: {
      mode: 'UNKNOWN_GOALS',
      waterproof: 'NO_PREFERENCE',
      removal: 'NO_PREFERENCE',
      sensitiveEyes: false,
      contactLenses: false,
      avoidedIngredients: [],
    },
  });
  await expect(ui.getByRole('note')).toContainText(
    'не проверены производителем',
  );
  await expect(
    ui
      .locator('.comparison-result')
      .getByText('полнота не подтверждена', { exact: false }),
  ).toBeVisible();
  await expect(
    ui
      .locator('.comparison-result')
      .getByText('полнота подтверждена вами', { exact: false }),
  ).toBeVisible();
  await expect(
    ui
      .locator('.comparison-result')
      .getByText('Не рыночная оценка.', { exact: false }),
  ).toBeVisible();
});

test('mixed comparison sends explicit constraints and resolves recommendation by slot index', async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route('**/api/v1/comparisons/private-preview', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: comparison(true, 'PERSONALIZED') });
  });
  const ui = await openComparison(page);
  await ui.getByLabel('GTIN из каталога', { exact: true }).check();
  await ui.getByLabel('GTIN второго товара').fill(catalogGtin);
  await ui.getByLabel('У меня есть пожелания').check();
  await ui.getByLabel('Удлинение', { exact: true }).check();
  await ui.getByLabel('Водостойкость для сравнения').selectOption('REQUIRED');
  await ui.getByLabel('Снятие для сравнения').selectOption('EASY_REQUIRED');
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill('Beeswax\nParfum');
  await ui.getByLabel('Чувствительные глаза').check();
  await ui.getByLabel('Контактные линзы').check();
  await ui.getByRole('button', { name: 'Сравнить с личной карточкой' }).click();
  await expect(
    ui.getByRole('heading', {
      name: 'Лучше подходит: Catalog Choice · Mascara Three · Black',
    }),
  ).toBeVisible();
  expect(requests[0]).toEqual({
    schemaVersion: 1,
    slots: [
      { kind: 'PRIVATE', snapshotId },
      { kind: 'CATALOG', gtin: catalogGtin },
    ],
    brief: {
      mode: 'PERSONALIZED',
      goals: ['LENGTH'],
      waterproof: 'REQUIRED',
      removal: 'EASY_REQUIRED',
      sensitiveEyes: true,
      contactLenses: true,
      avoidedIngredients: ['Beeswax', 'Parfum'],
    },
  });
  await expect(
    ui.getByRole('link', { name: 'Источник карточки' }),
  ).toHaveAttribute('href', source.sourceUrl);
  await expect(
    ui.getByText('Отзывы покупателей недоступны.', { exact: true }),
  ).toBeVisible();
  await ui.getByLabel('Снятие для сравнения').selectOption('NO_PREFERENCE');
  await expect(
    ui.getByRole('heading', { name: /^Лучше подходит:/ }),
  ).toHaveCount(0);
});

test('list outage allows catalog fallback; comparison retries and discards stale response', async ({
  page,
}) => {
  let count = 0;
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/comparisons/private-preview', async (route) => {
    count += 1;
    if (count === 1) return route.fulfill({ status: 503, json: {} });
    if (count === 2) await delayed;
    await route.fulfill({ json: comparison(true) }).catch(() => {});
  });
  const ui = await openComparison(page, true);
  await expect(ui.getByRole('alert')).toContainText(
    'Не удалось загрузить ваши карточки',
  );
  await ui.getByLabel('GTIN из каталога', { exact: true }).check();
  await ui.getByLabel('GTIN второго товара').fill(catalogGtin);
  await ui.getByRole('button', { name: 'Сравнить с личной карточкой' }).click();
  await expect(ui.getByRole('alert')).toContainText(
    'Сравнение временно недоступно',
  );
  const pending = page.waitForRequest('**/api/v1/comparisons/private-preview');
  await ui.getByRole('button', { name: 'Сравнить с личной карточкой' }).click();
  await pending;
  await expect(
    ui.getByRole('button', { name: 'Сравниваем карточки…' }),
  ).toBeDisabled();
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill('Parfum');
  release?.();
  await expect(
    ui.getByRole('button', { name: 'Сравнить с личной карточкой' }),
  ).toBeEnabled();
  await expect(
    ui.getByRole('heading', { name: /^Лучше подходит:/ }),
  ).toHaveCount(0);
  await ui.getByRole('button', { name: 'Сравнить с личной карточкой' }).click();
  await expect(
    ui.getByRole('heading', { name: /^Лучше подходит:/ }),
  ).toBeVisible();
});
