import { expect, test, type Page } from '@playwright/test';

const gtin = '5901234123457';
const observationId = 'f85bf269-76ce-47f5-8b2a-312cb93c653b';
const originalId = '11111111-1111-4111-8111-111111111111';
const latestId = '22222222-2222-4222-8222-222222222222';
const snapshotId = '33333333-3333-4333-8333-333333333333';
const createdAt = '2026-09-20T00:00:00.000Z';
const original = {
  revisionId: originalId,
  revisionNumber: 1,
  source: { kind: 'USER_TRANSCRIPTION' },
  sourceText: 'Aqua, Glycerin',
  sourceSha256: 'a'.repeat(64),
  authorKind: 'GUEST',
  createdAt,
};
const latest = {
  ...original,
  revisionId: latestId,
  revisionNumber: 2,
  source: { kind: 'USER_CORRECTION', basedOnRevisionId: originalId },
  sourceText: 'Aqua, Beeswax',
  sourceSha256: 'b'.repeat(64),
};

interface SnapshotInput {
  revisionId: string;
  formulaComplete: boolean;
  identity: Record<string, unknown>;
  claimKinds: string[];
  priceKopecks: number | null;
}

function response(input: SnapshotInput) {
  return {
    resultKind: 'CREATED',
    snapshot: {
      snapshotId,
      observationId,
      snapshotNumber: 1,
      category: 'MASCARA',
      barcode: {
        value: gtin,
        format: 'EAN_13',
        gtin14: gtin.padStart(14, '0'),
      },
      identity: input.identity,
      identitySource: 'USER_CONFIRMED_PACKAGING',
      revision: input.revisionId === originalId ? original : latest,
      formulaComplete: input.formulaComplete,
      claimKinds: input.claimKinds,
      claimsSource: 'USER_CONFIRMED_PACKAGING',
      priceKopecks: input.priceKopecks,
      priceSource: input.priceKopecks === null ? null : 'USER_ENTERED',
      createdAt,
    },
  };
}

async function openForm(page: Page, history: () => unknown[] = () => []) {
  let principal: object = { kind: 'ANONYMOUS' };
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({ json: { principal } }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) =>
    route.fulfill({ json: { snapshots: history() } }),
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
  await page.route('**/api/v1/guest-sessions', (route) => {
    principal = {
      kind: 'GUEST',
      guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt,
    };
    return route.fulfill({ json: { principal } });
  });
  await page.route('**/api/v1/product-observations', (route) =>
    route.fulfill({
      json: {
        observation: {
          schemaVersion: 1,
          observationId,
          barcode: {
            value: gtin,
            format: 'EAN_13',
            gtin14: gtin.padStart(14, '0'),
          },
          mediaCollection: {
            collectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            assets: [],
            createdAt,
          },
          createdAt,
          updatedAt: createdAt,
        },
      },
    }),
  );
  await page.route(
    `**/api/v1/product-observations/${observationId}/inci-revisions`,
    (route) =>
      route.fulfill({
        json: {
          workspace: { original, latest, revisionCount: 2, maxRevisions: 50 },
        },
      }),
  );
  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить по фото' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личная карточка по упаковке' }),
  ).toBeVisible();
}

async function fillIdentity(page: Page) {
  await page.getByLabel('Бренд', { exact: true }).fill('Test Brand');
  await page
    .getByLabel('Название продукта', { exact: true })
    .fill('Test Mascara');
  await page.getByLabel('Вариант продукта', { exact: true }).fill('Black');
  await page.getByLabel('Это тушь для ресниц', { exact: false }).check();
  await page.getByLabel('Я сверил(а)', { exact: false }).check();
}

test('history preserves the middle revision and rejects delayed analysis after reopening it', async ({
  page,
}) => {
  const newer = {
    ...latest,
    revisionId: '44444444-4444-4444-8444-444444444444',
    revisionNumber: 3,
    source: { kind: 'USER_CORRECTION', basedOnRevisionId: latestId },
    sourceText: 'Aqua, Parfum',
    sourceSha256: 'c'.repeat(64),
  };
  const saved = response({
    revisionId: latestId,
    formulaComplete: false,
    identity: {
      brandName: 'Test Brand',
      familyName: 'Test Mascara',
      variantName: 'Black',
      shadeName: null,
      netQuantity: null,
      isWaterproof: null,
    },
    claimKinds: [],
    priceKopecks: null,
  });
  const analyzed: string[] = [];
  const corrections: unknown[] = [];
  const snapshots: SnapshotInput[] = [];
  let historyLoads = 0;
  // Model a response already received before cancellation: transport abort alone
  // cannot prevent a delayed continuation from publishing stale component state.
  await page.addInitScript(
    ({ revisionId }) => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const result = await originalFetch(input, init);
        if (!url.endsWith(`/inci-revisions/${revisionId}/analysis`))
          return result;
        const body = await result.text();
        return new Promise<Response>((resolve) => {
          Reflect.set(window, '__releaseStaleAnalysis', async () => {
            resolve(
              new Response(body, {
                status: result.status,
                headers: result.headers,
              }),
            );
            await new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            );
          });
        });
      };
    },
    { revisionId: newer.revisionId },
  );
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({
      json: {
        principal: {
          kind: 'GUEST',
          guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          createdAt,
        },
      },
    }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) => {
    ++historyLoads;
    return route.fulfill({ json: { snapshots: [saved.snapshot] } });
  });
  await page.route(
    `**/api/v1/product-observations/${observationId}/inci-revisions`,
    (route) => {
      if (route.request().method() === 'POST') {
        corrections.push(route.request().postDataJSON());
        return route.fulfill({ status: 503, json: {} });
      }
      return route.fulfill({
        json: {
          workspace: {
            original,
            latest: newer,
            revisionCount: 3,
            maxRevisions: 50,
          },
        },
      });
    },
  );
  await page.route('**/inci-revisions/*/analysis', (route) => {
    const revisionId = new URL(route.request().url()).pathname
      .split('/')
      .at(-2);
    analyzed.push(revisionId ?? '');
    return route.fulfill({
      json: {
        analysis: {
          schemaVersion: 1,
          selectedRevisionId: revisionId,
          sourceSha256:
            revisionId === newer.revisionId
              ? newer.sourceSha256
              : latest.sourceSha256,
          parserVersion: 'inci-parser-v1',
          parse: {
            kind: 'PARSED',
            tokenCount: revisionId === newer.revisionId ? 3 : 2,
            uncertainTokenCount: 0,
          },
          normalization: { kind: 'NOT_RUN', reason: 'NO_PUBLISHED_DICTIONARY' },
        },
      },
    });
  });
  await page.route(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
    (route) => {
      snapshots.push(route.request().postDataJSON() as SnapshotInput);
      return route.fulfill({ status: 201, json: saved });
    },
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Открыть карточку', exact: true })
    .click();
  const select = page.getByLabel('Редакция для разбора');
  const draft = page.getByLabel('Исправленный текст состава');
  await expect(select).toHaveValue(latestId);
  await expect(select.locator('option')).toHaveCount(3);
  await expect(draft).toHaveValue(latest.sourceText);
  await expect(
    page.getByRole('button', { name: 'Сохранить исправление и разобрать' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Разобрать выбранную редакцию' })
    .click();
  await expect(
    page.getByText('Токенов: 2. Требуют проверки: 0.'),
  ).toBeVisible();
  expect(analyzed).toEqual([latestId]);
  await select.selectOption(originalId);
  await expect(draft).toHaveValue(original.sourceText);
  await select.selectOption(newer.revisionId);
  await expect(draft).toHaveValue(newer.sourceText);
  await page
    .getByRole('button', { name: 'Разобрать выбранную редакцию' })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof Reflect.get(window, '__releaseStaleAnalysis')),
    )
    .toBe('function');
  const previousLoads = historyLoads;
  await page.getByRole('button', { name: 'Обновить сессию и историю' }).click();
  await expect.poll(() => historyLoads).toBeGreaterThan(previousLoads);
  await page
    .getByRole('button', { name: 'Открыть карточку', exact: true })
    .click();
  await expect(select).toHaveValue(latestId);
  await expect(draft).toHaveValue(latest.sourceText);
  await page.evaluate(async () => {
    await Reflect.get(window, '__releaseStaleAnalysis')();
  });
  await expect(page.locator('.inci-analysis')).toHaveCount(0);
  await expect(select).toHaveValue(latestId);
  await expect(select).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await select.selectOption(latestId);
  await expect(draft).toHaveValue(latest.sourceText);
  await fillIdentity(page);
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личная карточка сохранена' }),
  ).toBeVisible();
  expect(snapshots[0]?.revisionId).toBe(latestId);
  await draft.fill('Aqua, Beeswax, Mica');
  await page
    .getByRole('button', { name: 'Сохранить исправление и разобрать' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Не удалось сохранить редакцию',
  );
  expect(corrections).toEqual([
    {
      kind: 'USER_CORRECTION',
      basedOnRevisionId: latestId,
      sourceText: 'Aqua, Beeswax, Mica',
    },
  ]);
});

test('guest capture stays open and a saved snapshot refreshes account history immediately', async ({
  page,
}) => {
  const history: unknown[] = [];
  await page.route(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
    (route) => {
      const saved = response(route.request().postDataJSON() as SnapshotInput);
      history.push(saved.snapshot);
      return route.fulfill({ status: 201, json: saved });
    },
  );
  await openForm(page, () => history);
  const accountPanel = page.getByRole('region', {
    name: 'Аккаунт и личная история',
  });
  await expect(
    accountPanel.getByRole('button', {
      name: 'Удалить гостевые данные',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    accountPanel.getByText('Сохранённых карточек пока нет.', { exact: false }),
  ).toBeVisible();
  await fillIdentity(page);
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личная карточка сохранена' }),
  ).toBeVisible();
  await expect(
    accountPanel.getByRole('heading', { name: 'Test Brand · Test Mascara' }),
  ).toBeVisible();
  await expect(page.getByLabel('Бренд', { exact: true })).toHaveValue(
    'Test Brand',
  );
});

test('private product saves the explicitly selected immutable revision and integer price', async ({
  page,
}) => {
  const requests: SnapshotInput[] = [];
  await page.route(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
    (route) => {
      const input = route.request().postDataJSON() as SnapshotInput;
      requests.push(input);
      return route.fulfill({ status: 201, json: response(input) });
    },
  );
  await openForm(page);
  await page.getByLabel('Редакция для разбора').selectOption(originalId);
  await fillIdentity(page);
  await expect(
    page.getByLabel('В выбранной редакции весь состав', { exact: false }),
  ).not.toBeChecked();
  await page.getByLabel('Цена в магазине', { exact: false }).fill('599,90');
  await page.getByLabel('Количество — необязательно').fill('8,5');
  await page.getByLabel('Удлинение', { exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личная карточка сохранена' }),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    revisionId: originalId,
    formulaComplete: false,
    priceKopecks: 59990,
    claimKinds: ['LENGTH'],
    identity: {
      netQuantity: { value: '8.5', unit: 'MILLILITER' },
      isWaterproof: null,
    },
  });
  await expect(
    page.getByText('Полнота состава не подтверждена.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText('Это не рыночная цена.', { exact: false }),
  ).toBeVisible();
  await page.getByText('Сохранённый текст и источник', { exact: true }).click();
  await expect(
    page.getByText(`Идентификатор карточки: ${snapshotId}`),
  ).toBeVisible();
});

test('private product validates price and preserves input after a failed save', async ({
  page,
}) => {
  const requests: SnapshotInput[] = [];
  await page.route(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
    (route) => {
      const input = route.request().postDataJSON() as SnapshotInput;
      requests.push(input);
      return requests.length === 1
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ status: 201, json: response(input) });
    },
  );
  await openForm(page);
  await fillIdentity(page);
  await page.getByLabel('Цена в магазине', { exact: false }).fill('0,001');
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(page.getByRole('alert')).toContainText('Не больше двух знаков');
  expect(requests).toHaveLength(0);
  await page.getByLabel('Цена в магазине', { exact: false }).fill('');
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(page.getByRole('alert')).toContainText('Проверьте соединение');
  await expect(page.getByLabel('Бренд', { exact: true })).toHaveValue(
    'Test Brand',
  );
  await expect(page.getByLabel('Я сверил(а)', { exact: false })).toBeChecked();
  await page
    .getByLabel('В выбранной редакции весь состав', { exact: false })
    .check();
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await expect(
    page.getByRole('heading', { name: 'Личная карточка сохранена' }),
  ).toBeVisible();
  expect(requests[1]).toMatchObject({
    revisionId: latestId,
    formulaComplete: true,
    priceKopecks: null,
    claimKinds: [],
  });
  await expect(
    page.getByText('Полнота состава подтверждена вами.', { exact: false }),
  ).toBeVisible();
});

test('changing the selected revision aborts the pending save and requires confirmation again', async ({
  page,
}) => {
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
    async (route) => {
      const input = route.request().postDataJSON() as SnapshotInput;
      await delayed;
      await route
        .fulfill({ status: 201, json: response(input) })
        .catch(() => {});
    },
  );
  await openForm(page);
  await fillIdentity(page);
  const saving = page.waitForRequest(
    `**/api/v1/product-observations/${observationId}/private-snapshots`,
  );
  await page.getByRole('button', { name: 'Сохранить личную карточку' }).click();
  await saving;
  await expect(
    page.getByRole('button', { name: 'Сохраняем карточку…' }),
  ).toBeDisabled();
  await page.getByLabel('Редакция для разбора').selectOption(originalId);
  release?.();
  await expect(
    page.getByRole('button', { name: 'Сохранить личную карточку' }),
  ).toBeEnabled();
  await expect(
    page.getByLabel('Я сверил(а)', { exact: false }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel('В выбранной редакции весь состав', { exact: false }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('heading', { name: 'Личная карточка сохранена' }),
  ).toHaveCount(0);
});
