import { expect, test, type Page, type Route } from '@playwright/test';

const date = '2026-09-20T00:00:00.000Z';
const gtin = '4006381333931';
const secondGtin = '5901234123457';
const account = {
  kind: 'ACCOUNT',
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'preferences@example.test',
  createdAt: date,
};
const anonymous = { kind: 'ANONYMOUS' };
const profile = {
  schemaVersion: 1,
  source: 'ACCOUNT_PROFILE',
  profileVersion: 1,
  createdAt: date,
  mode: 'UNKNOWN_GOALS',
  goals: [],
  waterproof: 'AVOID',
  removal: 'EASY_REQUIRED',
  sensitiveEyes: true,
  contactLenses: true,
  avoidedIngredients: ['PARFUM'],
};
const source = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Test fixture only',
  sourceUrl: 'https://example.test/product',
  observedAt: date,
  importedAt: date,
};
const variant = {
  schemaVersion: 1,
  identification: { method: 'GTIN', confidence: 'EXACT' },
  barcode: { value: gtin, format: 'EAN_13', gtin14: gtin.padStart(14, '0') },
  productVariantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  productFamilyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  category: 'MASCARA',
  brandName: 'Fixture',
  familyName: 'Preference Mascara',
  variantName: 'Black',
  shadeName: null,
  netQuantity: null,
  isWaterproof: false,
  formula: null,
  claims: [],
  identitySources: { family: source, variant: source, barcode: source },
};
const snapshot = {
  snapshotId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  observationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  snapshotNumber: 1,
  category: 'MASCARA',
  barcode: variant.barcode,
  identity: {
    brandName: 'Private Fixture',
    familyName: 'Private Mascara',
    variantName: 'Black',
    shadeName: null,
    netQuantity: null,
    isWaterproof: null,
  },
  identitySource: 'USER_CONFIRMED_PACKAGING',
  revision: {
    revisionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    revisionNumber: 1,
    source: { kind: 'USER_TRANSCRIPTION' },
    sourceText: 'Aqua',
    sourceSha256: 'a'.repeat(64),
    authorKind: 'ACCOUNT',
    createdAt: date,
  },
  formulaComplete: false,
  claimKinds: [],
  claimsSource: 'USER_CONFIRMED_PACKAGING',
  priceKopecks: null,
  priceSource: null,
  createdAt: date,
};
function editor(page: Page) {
  return page.getByRole('region', { name: 'Условия выбора туши' });
}
function panel(page: Page) {
  return page.getByRole('region', { name: 'Аккаунт и личная история' });
}

async function fixture(
  page: Page,
  signedIn = true,
  avoidedIngredients = profile.avoidedIngredients,
) {
  let principal: object = signedIn ? account : anonymous;
  let saved: typeof profile | null = signedIn
    ? {
        ...structuredClone(profile),
        avoidedIngredients: [...avoidedIngredients],
      }
    : null;
  const comparisons: Record<string, unknown>[] = [];
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({ json: { principal } }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) =>
    route.fulfill({ json: { snapshots: [snapshot] } }),
  );
  await page.route('**/api/v1/catalog/barcodes/*', (route) =>
    route.fulfill({ json: { variant } }),
  );
  await page.route('**/api/v1/products/*/reviews?limit=20', (route) =>
    route.fulfill({
      json: {
        summary: {
          source: 'WTM',
          sourceQuality: 'LOW',
          verifiedPurchase: false,
          ratingValue: null,
          reviewCount: 0,
          asOf: null,
          reviews: [],
        },
      },
    }),
  );
  await page.route('**/api/v1/products/*/my-review', (route) =>
    route.fulfill({ json: { review: null } }),
  );
  await page.route('**/api/v1/mascara-preferences/current', (route) =>
    route.fulfill({ json: { preference: saved } }),
  );
  await page.route('**/api/v1/mascara-preferences', (route) => {
    const input = route.request().postDataJSON() as Record<string, unknown>;
    saves.push(input);
    const { expectedAccountId, ...brief } = input;
    expect(expectedAccountId).toBe(account.accountId);
    saved = {
      ...profile,
      ...brief,
      goals: brief.mode === 'UNKNOWN_GOALS' ? [] : brief.goals,
      profileVersion: (saved?.profileVersion ?? 0) + 1,
    } as typeof profile;
    return route.fulfill({ status: 201, json: { brief: saved } });
  });
  await page.route('**/api/v1/comparisons/*', (route) => {
    comparisons.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 503, json: {} });
  });
  await page.route('**/api/v1/account-sessions/current', (route) => {
    principal = anonymous;
    return route.fulfill({ status: 204 });
  });
  return {
    comparisons,
    saves,
    setPrincipal(value: object) {
      principal = value;
    },
  };
}
async function openPublic(page: Page) {
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.getByRole('button', { name: 'Сравнить с другим' }).click();
  await page.getByLabel('GTIN варианта 2').fill(secondGtin);
  return page.getByRole('button', { name: 'Сравнить варианты', exact: true });
}

async function openComparison(page: Page, kind: 'PUBLIC' | 'PRIVATE') {
  if (kind === 'PUBLIC') return openPublic(page);
  await panel(page)
    .getByRole('button', { name: 'Сравнить эту карточку' })
    .click();
  await page.getByLabel('GTIN из каталога').check();
  await page.getByLabel('GTIN второго товара').fill(secondGtin);
  return page.getByRole('button', { name: 'Сравнить с личной карточкой' });
}

for (const kind of ['PUBLIC', 'PRIVATE'] as const) {
  test(`${kind} comparison loads saved hard constraints before UNKNOWN_GOALS submission`, async ({
    page,
  }) => {
    const state = await fixture(page);
    await page.goto('/');
    const submit = await openComparison(page, kind);
    const ui = editor(page);
    await expect(ui.getByLabel('Не знаю — помогите выбрать')).toBeChecked();
    await expect(ui.getByLabel('Водостойкость для сравнения')).toHaveValue(
      'AVOID',
    );
    await expect(
      ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
    ).toHaveValue('PARFUM');
    await ui.getByLabel('У меня есть пожелания').check();
    const lengthGoal = ui.getByLabel('Удлинение', { exact: true });
    await expect(lengthGoal).toBeVisible();
    await lengthGoal.check();
    await ui.getByLabel('Не знаю — помогите выбрать').check();
    await submit.click();
    await expect.poll(() => state.comparisons.length).toBe(1);
    expect(state.comparisons[0]?.brief).toEqual({
      mode: 'UNKNOWN_GOALS',
      waterproof: 'AVOID',
      removal: 'EASY_REQUIRED',
      sensitiveEyes: true,
      contactLenses: true,
      avoidedIngredients: ['PARFUM'],
    });
    expect(state.saves).toHaveLength(0);
  });

  test(`${kind} preserves ingredient commas through profile load, comparison, save and reload`, async ({
    page,
  }) => {
    const ingredients = ['1,2-HEXANEDIOL', 'PARFUM'];
    const state = await fixture(page, true, ingredients);
    await page.goto('/');
    let submit = await openComparison(page, kind);
    const ui = editor(page);
    const exclusions = ui.getByLabel(
      'Исключить ингредиенты — каждый с новой строки',
    );
    await expect(exclusions).toHaveValue('1,2-HEXANEDIOL\nPARFUM');
    await submit.click();
    await expect.poll(() => state.comparisons.length).toBe(1);
    expect(state.comparisons[0]?.brief).toMatchObject({
      avoidedIngredients: ingredients,
    });
    await ui
      .getByRole('button', { name: 'Сохранить предпочтения в аккаунте' })
      .click();
    await expect(ui.getByRole('status')).toHaveText(
      'Предпочтения сохранены в аккаунте.',
    );
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]?.avoidedIngredients).toEqual(ingredients);
    await expect(exclusions).toHaveValue('1,2-HEXANEDIOL\nPARFUM');
    await page.reload();
    submit = await openComparison(page, kind);
    await expect(exclusions).toHaveValue('1,2-HEXANEDIOL\nPARFUM');
    await submit.click();
    await expect.poll(() => state.comparisons.length).toBe(2);
    expect(state.comparisons[1]?.brief).toMatchObject({
      avoidedIngredients: ingredients,
    });
  });
}

test('account comparison waits for its profile and offers retry instead of dropping constraints', async ({
  page,
}) => {
  const state = await fixture(page);
  let pending!: Route;
  await page.route('**/api/v1/mascara-preferences/current', (route) => {
    pending = route;
  });
  await page.goto('/');
  const submit = await openPublic(page);
  await expect(editor(page).getByRole('status')).toContainText(
    'Загружаем условия',
  );
  await expect(submit).toBeDisabled();
  await expect(
    editor(page).getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toBeDisabled();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await pending.fulfill({ status: 503, json: {} });
  await expect(editor(page).getByRole('alert')).toContainText(
    'не пропустить сохранённые ограничения',
  );
  await expect(submit).toBeDisabled();
  await page.route('**/api/v1/mascara-preferences/current', (route) =>
    route.fulfill({ json: { preference: profile } }),
  );
  await editor(page)
    .getByRole('button', { name: 'Повторить загрузку условий' })
    .click();
  await expect(submit).toBeEnabled();
  await expect(
    editor(page).getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('PARFUM');
  expect(state.comparisons).toHaveLength(0);
});

test('explicit profile save persists across reopening and a failed save preserves input', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/');
  await openPublic(page);
  const ui = editor(page);
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('PARFUM');
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill('NICKEL');
  await ui
    .getByRole('button', { name: 'Сохранить предпочтения в аккаунте' })
    .click();
  await expect(ui.getByRole('status')).toHaveText(
    'Предпочтения сохранены в аккаунте.',
  );
  expect(state.saves[0]?.expectedAccountId).toBe(account.accountId);
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await page.getByRole('button', { name: 'Сравнить с другим' }).click();
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('NICKEL');
  await page.route('**/api/v1/mascara-preferences', (route) =>
    route.fulfill({ status: 503, json: {} }),
  );
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill('BEESWAX');
  await ui
    .getByRole('button', { name: 'Сохранить предпочтения в аккаунте' })
    .click();
  await expect(ui.getByRole('alert')).toContainText(
    'Сохранение не подтверждено',
  );
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('BEESWAX');
});

test('a late save response never overwrites edits made during the request', async ({
  page,
}) => {
  await fixture(page);
  let pending!: Route;
  await page.route('**/api/v1/mascara-preferences', (route) => {
    pending = route;
  });
  await page.goto('/');
  await openPublic(page);
  const ui = editor(page);
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('PARFUM');
  await ui
    .getByRole('button', { name: 'Сохранить предпочтения в аккаунте' })
    .click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill('NICKEL');
  await pending.fulfill({
    status: 201,
    json: { brief: { ...profile, profileVersion: 2 } },
  });
  await expect(ui.getByRole('status')).toContainText(
    'Новые правки пока не сохранены',
  );
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('NICKEL');
});

test('late profile data cannot survive logout and guest comparison retains only its local draft', async ({
  page,
}) => {
  const state = await fixture(page);
  let pending!: Route;
  await page.route('**/api/v1/mascara-preferences/current', (route) => {
    pending = route;
  });
  await page.goto('/');
  await openPublic(page);
  await expect.poll(() => Boolean(pending)).toBe(true);
  await panel(page).getByRole('button', { name: 'Выйти из аккаунта' }).click();
  await expect(editor(page)).toHaveCount(0);
  await pending.fulfill({ json: { preference: profile } }).catch(() => {});
  await page.getByRole('button', { name: 'Сравнить с другим' }).click();
  const ui = editor(page);
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toBeEnabled();
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('');
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill('NICKEL');
  await page.getByLabel('GTIN варианта 2').fill(secondGtin);
  await page
    .getByRole('button', { name: 'Сравнить варианты', exact: true })
    .click();
  await expect.poll(() => state.comparisons.length).toBe(1);
  expect(state.comparisons[0]?.brief).toMatchObject({
    avoidedIngredients: ['NICKEL'],
  });
  expect(state.saves).toHaveLength(0);
});

test('session change before comparison clears old conditions and never dispatches them', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto('/');
  const submit = await openPublic(page);
  const ui = editor(page);
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('PARFUM');
  state.setPrincipal({
    ...account,
    accountId: '99999999-9999-4999-8999-999999999999',
    email: 'other@example.test',
  });
  await submit.click();
  await expect(ui.getByRole('alert')).toContainText('Прежние условия очищены');
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue('');
  await expect(submit).toBeDisabled();
  expect(state.comparisons).toHaveLength(0);
});

test('guest exclusions exceeding fifty are rejected without silently dropping the last one', async ({
  page,
}) => {
  const state = await fixture(page, false);
  await page.goto('/');
  const submit = await openPublic(page);
  const ui = editor(page);
  const exclusions = Array.from(
    { length: 51 },
    (_, index) => `INGREDIENT${index}`,
  ).join('\n');
  await ui
    .getByLabel('Исключить ингредиенты — каждый с новой строки')
    .fill(exclusions);
  await submit.click();
  await expect(ui.getByRole('alert')).toContainText('до 50 ингредиентов');
  await expect(
    ui.getByLabel('Исключить ингредиенты — каждый с новой строки'),
  ).toHaveValue(exclusions);
  expect(state.comparisons).toHaveLength(0);
  await expect(
    ui.getByRole('button', { name: 'Сохранить предпочтения в аккаунте' }),
  ).toHaveCount(0);
});
