import { expect, test, type Page } from '@playwright/test';

const gtin = '5901234123457';
const observationId = 'f85bf269-76ce-47f5-8b2a-312cb93c653b';
const collectionId = '36463885-1770-4823-9298-85bca3d8eeb9';

function observation(assets: Array<Record<string, unknown>>) {
  return {
    observation: {
      schemaVersion: 1,
      observationId,
      barcode: { value: gtin, format: 'EAN_13', gtin14: '05901234123457' },
      mediaCollection: {
        collectionId,
        assets,
        createdAt: '2026-08-26T10:00:00.000Z',
      },
      createdAt: '2026-08-26T10:00:00.000Z',
      updatedAt: '2026-08-26T10:00:00.000Z',
    },
  };
}

async function mockUnknownCatalog(page: Page): Promise<void> {
  await page.route(`**/api/v1/catalog/barcodes/${gtin}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Catalog variant not found',
          requestId: 'e2e',
        },
      }),
    }),
  );
}

async function mockEmptyInci(page: Page): Promise<void> {
  await page.route(
    `**/api/v1/product-observations/${observationId}/inci-revisions`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspace: {
            original: null,
            latest: null,
            revisionCount: 0,
            maxRevisions: 50,
          },
        }),
      }),
  );
}

test('guest captures a private unknown product and reuses it', async ({
  page,
}) => {
  const assets: Array<Record<string, unknown>> = [];
  await mockUnknownCatalog(page);
  await mockEmptyInci(page);
  await page.route('**/api/v1/guest-sessions', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        principal: {
          kind: 'GUEST',
          guestId: '9b5caf40-d60c-4d69-907b-84d4b070f7ca',
          createdAt: '2026-08-26T10:00:00.000Z',
        },
      }),
    }),
  );
  await page.route('**/api/v1/product-observations', (route) =>
    route.fulfill({
      status: assets.length === 0 ? 201 : 200,
      contentType: 'application/json',
      body: JSON.stringify(observation(assets)),
    }),
  );
  await page.route(
    `**/api/v1/media-collections/${collectionId}/assets?role=*`,
    (route) => {
      const role =
        new URL(route.request().url()).searchParams.get('role') ?? 'FRONT';
      const asset = {
        assetId: '597356e8-cc8b-4718-a783-fb4cd478e92c',
        role,
        mediaType: 'image/jpeg',
        byteSize: 7,
        createdAt: '2026-08-26T10:01:00.000Z',
      };
      assets.splice(0, assets.length, asset);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ asset }),
      });
    },
  );
  await page.route('**/api/v1/media-assets/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]),
    }),
  );

  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('button', { name: 'Добавить по фото' }).click();
  await expect(
    page.getByRole('heading', { name: 'Сфотографируйте упаковку' }),
  ).toBeVisible();

  const front = page.locator('.capture-role').filter({ hasText: 'Название' });
  await front.locator('input[type=file]').setInputFiles({
    name: 'front.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]),
  });
  await expect(page.getByText('1 из 5')).toBeVisible();
  await expect(front.getByAltText('Сохранённое фото: Название')).toBeVisible();

  await page.reload();
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('button', { name: 'Добавить по фото' }).click();
  await expect(page.getByText('1 из 5')).toBeVisible();
});

test('account opens a claimed guest observation', async ({ page }) => {
  const existingAsset = {
    assetId: '597356e8-cc8b-4718-a783-fb4cd478e92c',
    role: 'BARCODE',
    mediaType: 'image/jpeg',
    byteSize: 7,
    createdAt: '2026-08-26T10:01:00.000Z',
  };
  await mockUnknownCatalog(page);
  await mockEmptyInci(page);
  await page.route('**/api/v1/guest-sessions', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        principal: {
          kind: 'ACCOUNT',
          accountId: 'e579baba-e635-471c-bbcb-357a7d8c8c74',
          email: 'buyer@example.ru',
          createdAt: '2026-08-26T09:00:00.000Z',
        },
      }),
    }),
  );
  await page.route('**/api/v1/product-observations', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(observation([existingAsset])),
    }),
  );
  await page.route('**/api/v1/media-assets/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]),
    }),
  );

  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('button', { name: 'Добавить по фото' }).click();
  await expect(page.getByText('1 из 5')).toBeVisible();
  await expect(page.getByText('Повторный поиск этого штрихкода')).toBeVisible();
});

test('user corrects INCI and re-runs an explicitly selected revision', async ({
  page,
}) => {
  const originalRevisionId = 'a8b7e74f-97d0-4dd8-81e3-80a613fe5a3b';
  const correctedRevisionId = '8fe27965-07ea-40e2-8c81-9a7ed30aaaba';
  const originalText = 'Aqua, Wax <script>window.__wtmInciXss = true</script>';
  const correctedText = 'Aqua, Cera Alba, CI 77499';
  const original = {
    revisionId: originalRevisionId,
    revisionNumber: 1,
    source: {
      kind: 'OCR',
      mediaAssetId: '597356e8-cc8b-4718-a783-fb4cd478e92c',
      providerId: 'GOOGLE_VISION',
      providerVersion: 'v1',
    },
    sourceText: originalText,
    sourceSha256: '1'.repeat(64),
    authorKind: 'SYSTEM',
    createdAt: '2026-08-27T10:00:00.000Z',
  };
  const corrected = {
    revisionId: correctedRevisionId,
    revisionNumber: 2,
    source: {
      kind: 'USER_CORRECTION',
      basedOnRevisionId: originalRevisionId,
    },
    sourceText: correctedText,
    sourceSha256: '2'.repeat(64),
    authorKind: 'GUEST',
    createdAt: '2026-08-27T10:05:00.000Z',
  };
  const analyzedRevisionIds: string[] = [];

  await mockUnknownCatalog(page);
  await page.route('**/api/v1/guest-sessions', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        principal: {
          kind: 'GUEST',
          guestId: '9b5caf40-d60c-4d69-907b-84d4b070f7ca',
          createdAt: '2026-08-27T10:00:00.000Z',
        },
      }),
    }),
  );
  await page.route('**/api/v1/product-observations', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(observation([])),
    }),
  );
  await page.route(
    `**/api/v1/product-observations/${observationId}/inci-revisions`,
    async (route) => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({
          kind: 'USER_CORRECTION',
          basedOnRevisionId: originalRevisionId,
          sourceText: correctedText,
        });
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ resultKind: 'CREATED', revision: corrected }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspace: {
            original,
            latest: original,
            revisionCount: 1,
            maxRevisions: 50,
          },
        }),
      });
    },
  );
  await page.route('**/inci-revisions/*/analysis', (route) => {
    const revisionId = new URL(route.request().url()).pathname
      .split('/')
      .at(-2);
    expect(revisionId).toBeTruthy();
    analyzedRevisionIds.push(revisionId ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        analysis: {
          schemaVersion: 1,
          selectedRevisionId: revisionId,
          sourceSha256:
            revisionId === originalRevisionId ? '1'.repeat(64) : '2'.repeat(64),
          parserVersion: 'inci-parser-v1',
          parse: { kind: 'PARSED', tokenCount: 3, uncertainTokenCount: 0 },
          normalization: {
            kind: 'NOT_RUN',
            reason: 'NO_PUBLISHED_DICTIONARY',
          },
        },
      }),
    });
  });

  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.getByRole('button', { name: 'Добавить по фото' }).click();

  await expect(
    page.locator('.inci-source-evidence pre').getByText(originalText, {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, '__wtmInciXss')),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel('Исправленный текст состава').fill(correctedText);
  await page
    .getByRole('button', { name: 'Сохранить исправление и разобрать' })
    .click();
  await expect(
    page.getByText('Токенов: 3. Требуют проверки: 0.'),
  ).toBeVisible();
  expect(analyzedRevisionIds).toEqual([correctedRevisionId]);

  await page
    .getByLabel('Редакция для разбора')
    .selectOption(originalRevisionId);
  await page
    .getByRole('button', { name: 'Разобрать выбранную редакцию' })
    .click();
  await expect.poll(() => analyzedRevisionIds.at(-1)).toBe(originalRevisionId);
});
