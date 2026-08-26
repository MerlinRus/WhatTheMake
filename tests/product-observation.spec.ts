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

test('guest captures a private unknown product and reuses it', async ({
  page,
}) => {
  const assets: Array<Record<string, unknown>> = [];
  await mockUnknownCatalog(page);
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
