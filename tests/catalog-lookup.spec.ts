import { expect, test, type Page } from '@playwright/test';

const knownGtin = '4006381333931';
const source = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Официальный каталог производителя',
  sourceUrl: 'https://manufacturer.example/catalog',
  observedAt: '2026-08-26T08:00:00.000Z',
  importedAt: '2026-08-26T08:01:00.000Z',
};
const knownPayload = {
  variant: {
    schemaVersion: 1,
    identification: { method: 'GTIN', confidence: 'EXACT' },
    barcode: {
      value: knownGtin,
      format: 'EAN_13',
      gtin14: '04006381333931',
    },
    productVariantId: 'b0f9bf8f-c1d6-4803-8899-73ca3359eae2',
    productFamilyId: 'c85f8055-d0b2-4a06-8a6d-306f3c81ed1e',
    category: 'MASCARA',
    brandName: 'Example Beauty',
    familyName: 'Decision Mascara',
    variantName: 'Black / 10 ml / washable',
    shadeName: 'Black',
    netQuantity: { value: '10.0000', unit: 'MILLILITER' },
    isWaterproof: false,
    formula: {
      formulaRevisionId: 'f4dcb2df-eb59-4568-9330-ad2e24499f42',
      revisionNumber: 2,
      inciText: 'AQUA, WAX, CI 77499',
      source,
    },
    claims: [
      {
        productClaimId: 'd2a03d59-4f2f-49a0-b718-ae491cc67b97',
        kind: 'VOLUME',
        text: 'Заметный объём',
        source,
      },
    ],
    identitySources: {
      family: source,
      variant: source,
      barcode: source,
    },
  },
};

async function mockKnownCatalog(page: Page): Promise<void> {
  await page.route(`**/api/v1/catalog/barcodes/${knownGtin}`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(knownPayload),
    }),
  );
}

async function installBarcodeCamera(page: Page): Promise<void> {
  await page.addInitScript((gtin) => {
    const left = [
      '0001101',
      '0011001',
      '0010011',
      '0111101',
      '0100011',
      '0110001',
      '0101111',
      '0111011',
      '0110111',
      '0001011',
    ];
    const alternate = [
      '0100111',
      '0110011',
      '0011011',
      '0100001',
      '0011101',
      '0111001',
      '0000101',
      '0010001',
      '0001001',
      '0010111',
    ];
    const right = [
      '1110010',
      '1100110',
      '1101100',
      '1000010',
      '1011100',
      '1001110',
      '1010000',
      '1000100',
      '1001000',
      '1110100',
    ];
    const parity = [
      'LLLLLL',
      'LLGLGG',
      'LLGGLG',
      'LLGGGL',
      'LGLLGG',
      'LGGLLG',
      'LGGGLL',
      'LGLGLG',
      'LGLGGL',
      'LGGLGL',
    ];
    const first = Number(gtin[0]);
    let bits = '101';
    for (let index = 1; index <= 6; index += 1) {
      const digit = Number(gtin[index]);
      bits +=
        parity[first]?.[index - 1] === 'G' ? alternate[digit] : left[digit];
    }
    bits += '01010';
    for (let index = 7; index <= 12; index += 1) {
      bits += right[Number(gtin[index])];
    }
    bits += '101';

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 760;
          canvas.height = 380;
          const context = canvas.getContext('2d');
          if (context === null) throw new Error('Canvas unavailable');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#000';
          const quietZone = 80;
          const moduleWidth = 6;
          for (let index = 0; index < bits.length; index += 1) {
            if (bits[index] === '1') {
              context.fillRect(
                quietZone + index * moduleWidth,
                38,
                moduleWidth,
                265,
              );
            }
          }
          context.font = '36px sans-serif';
          context.textAlign = 'center';
          context.fillText(gtin, canvas.width / 2, 350);

          const stream = canvas.captureStream(12);
          const track = stream.getVideoTracks()[0];
          if (track === undefined) throw new Error('Video track unavailable');
          let frame = false;
          const redraw = window.setInterval(() => {
            frame = !frame;
            context.fillStyle = frame ? '#fff' : '#fefefe';
            context.fillRect(0, 0, 2, 2);
          }, 80);
          const nativeStop = track.stop.bind(track);
          track.stop = () => {
            window.clearInterval(redraw);
            Reflect.set(
              window,
              '__wtmCameraStopCount',
              Number(Reflect.get(window, '__wtmCameraStopCount') ?? 0) + 1,
            );
            nativeStop();
          };
          Reflect.set(window, '__wtmCameraCanvas', canvas);
          return stream;
        },
      },
    });
  }, knownGtin);
}

async function installSlowCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const canvas = document.createElement('canvas');
          const stream = canvas.captureStream(1);
          const track = stream.getVideoTracks()[0];
          if (track === undefined) throw new Error('Video track unavailable');
          const nativeStop = track.stop.bind(track);
          track.stop = () => {
            Reflect.set(
              window,
              '__wtmCameraStopCount',
              Number(Reflect.get(window, '__wtmCameraStopCount') ?? 0) + 1,
            );
            nativeStop();
          };
          await new Promise((resolve) => window.setTimeout(resolve, 350));
          return stream;
        },
      },
    });
  });
}

test('manual GTIN fallback opens exact product variant', async ({ page }) => {
  await mockKnownCatalog(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Что именно у вас в руках?' }),
  ).toBeVisible();
  await page.getByLabel('GTIN / EAN').fill(knownGtin);
  await page.getByRole('button', { name: 'Найти' }).click();

  await expect(page.getByText('Точный вариант по GTIN')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Decision Mascara' }),
  ).toBeVisible();
  await expect(page.getByText('Оттенок: Black')).toBeVisible();
  await expect(page.getByText('10 мл')).toBeVisible();
  await expect(page.getByText('Заметный объём')).toBeVisible();
  await expect(page.getByText('Обычная')).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test('local camera decodes EAN-13 and stops its stream', async ({ page }) => {
  await installBarcodeCamera(page);
  await mockKnownCatalog(page);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (page.url() === 'about:blank') return;
    if (new URL(request.url()).origin !== new URL(page.url()).origin) {
      externalRequests.push(request.url());
    }
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Сканировать камерой' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Наведите на штрихкод' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Decision Mascara' }),
  ).toBeVisible({ timeout: 20_000 });

  await expect(page.getByLabel('GTIN / EAN')).toHaveValue(knownGtin);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const stopCount = await page.evaluate(() =>
    Number(Reflect.get(window, '__wtmCameraStopCount') ?? 0),
  );
  expect(stopCount).toBeGreaterThanOrEqual(1);
  expect(externalRequests).toEqual([]);
});

test('quick camera close stops a stream returned after unmount', async ({
  page,
}) => {
  await installSlowCamera(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Сканировать камерой' }).click();
  await page.getByRole('button', { name: 'Закрыть камеру' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(Reflect.get(window, '__wtmCameraStopCount') ?? 0),
      ),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(
    page.getByRole('button', { name: 'Сканировать камерой' }),
  ).toBeFocused();
});
