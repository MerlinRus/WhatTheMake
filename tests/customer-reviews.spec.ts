import { expect, test, type Page } from '@playwright/test';

const gtin = '4006381333931';
const otherGtin = '5901234123457';
const variantId = '11111111-1111-4111-8111-111111111111';
const otherVariantId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-09-20T18:00:00.000Z';
const account = {
  kind: 'ACCOUNT',
  accountId: '33333333-3333-4333-8333-333333333333',
  email: 'reviewer@example.test',
  createdAt,
};
const source = {
  sourceKind: 'MANUFACTURER',
  sourceLabel: 'Test-only manufacturer fixture',
  sourceUrl: 'https://example.test/mascara',
  observedAt: createdAt,
  importedAt: createdAt,
};
function variant(code: string, id: string) {
  return {
    schemaVersion: 1,
    identification: { method: 'GTIN', confidence: 'EXACT' },
    barcode: { value: code, format: 'EAN_13', gtin14: code.padStart(14, '0') },
    productVariantId: id,
    productFamilyId: '44444444-4444-4444-8444-444444444444',
    category: 'MASCARA',
    brandName: 'Review Fixture',
    familyName: code === gtin ? 'Review Mascara' : 'Another Mascara',
    variantName: 'Black',
    shadeName: null,
    netQuantity: null,
    isWaterproof: false,
    formula: null,
    claims: [],
    identitySources: { family: source, variant: source, barcode: source },
  };
}
const sample = {
  reviewId: '55555555-5555-4555-8555-555555555555',
  productVariantId: variantId,
  revisionNumber: 1,
  stars: 4,
  text: 'Мне подошла щёточка: получается аккуратный макияж в один слой.',
  status: 'PENDING',
  duplicateText: false,
  verifiedPurchase: false,
  createdAt,
  updatedAt: createdAt,
};
function block(page: Page) {
  return page.getByRole('region', { name: 'Отзывы покупателей WTM' });
}
async function fixture(page: Page, signedIn = true) {
  let principal: object = signedIn ? account : { kind: 'ANONYMOUS' };
  let own: typeof sample | null = null;
  let failWrite = false;
  let deletes = 0;
  let puts = 0;
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({ json: { principal } }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  await page.route('**/api/v1/account-sessions', (route) => {
    principal = account;
    return route.fulfill({ json: { principal } });
  });
  await page.route('**/api/v1/account-sessions/current', (route) => {
    principal = { kind: 'ANONYMOUS' };
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/v1/catalog/barcodes/*', (route) => {
    const code = route.request().url().split('/').at(-1) ?? '';
    return route.fulfill({
      json: {
        variant: variant(code, code === gtin ? variantId : otherVariantId),
      },
    });
  });
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
  await page.route('**/api/v1/products/*/my-review', (route) => {
    if (route.request().method() === 'PUT') {
      puts += 1;
      if (failWrite) return route.fulfill({ status: 503, json: { error: {} } });
      const submitted = route.request().postDataJSON() as {
        stars: number;
        text: string;
        expectedAccountId: string;
      };
      expect(submitted.expectedAccountId).toBe(account.accountId);
      own = { ...sample, stars: submitted.stars, text: submitted.text };
      return route.fulfill({
        status: 201,
        json: { resultKind: 'CREATED', review: own },
      });
    }
    if (route.request().method() === 'DELETE') {
      expect(route.request().postDataJSON()).toEqual({
        expectedAccountId: account.accountId,
      });
      deletes += 1;
      own = null;
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({
      json: {
        review: route.request().url().includes(otherVariantId) ? null : own,
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('GTIN / EAN').fill(gtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(block(page)).toBeVisible();
  return {
    failWrites: () => {
      failWrite = true;
    },
    puts: () => puts,
    deletes: () => deletes,
    signOut: () => {
      principal = { kind: 'ANONYMOUS' };
    },
  };
}

test('review summary has honest no-data state and guests cannot publish', async ({
  page,
}) => {
  await fixture(page, false);
  const reviews = block(page);
  await expect(
    reviews.getByText(/Опубликованных отзывов пока нет/),
  ).toBeVisible();
  await expect(
    reviews.getByText(/Покупки и email не подтверждены/),
  ).toBeVisible();
  await expect(
    reviews.getByText(/Чтобы оставить отзыв, войдите/),
  ).toBeVisible();
  await expect(reviews.getByLabel('Ваш опыт использования')).toHaveCount(0);
  await expect(reviews.getByText('0 из 5', { exact: true })).toHaveCount(0);
});

test('login refreshes reviews on the same public product and logout clears the draft', async ({
  page,
}) => {
  await fixture(page, false);
  const reviews = block(page);
  await expect(
    reviews.getByText(/Чтобы оставить отзыв, войдите/),
  ).toBeVisible();
  const accountPanel = page.getByRole('region', {
    name: 'Аккаунт и личная история',
  });
  await accountPanel.getByRole('radio', { name: 'Вход', exact: true }).check();
  await accountPanel.getByLabel('Email', { exact: true }).fill(account.email);
  await accountPanel
    .getByLabel('Пароль', { exact: true })
    .fill('test-password-123');
  await accountPanel
    .getByRole('button', { name: 'Войти', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Review Mascara' }),
  ).toBeVisible();
  await expect(reviews.getByLabel('Ваш опыт использования')).toBeVisible();
  await reviews.getByLabel('Ваш опыт использования').fill(sample.text);
  await accountPanel.getByRole('button', { name: 'Выйти из аккаунта' }).click();
  await expect(
    page.getByRole('heading', { name: 'Review Mascara' }),
  ).toBeVisible();
  await expect(
    reviews.getByText(/Чтобы оставить отзыв, войдите/),
  ).toBeVisible();
  await expect(reviews.getByLabel('Ваш опыт использования')).toHaveCount(0);
  await accountPanel.getByLabel('Email', { exact: true }).fill(account.email);
  await accountPanel
    .getByLabel('Пароль', { exact: true })
    .fill('test-password-123');
  await accountPanel
    .getByRole('button', { name: 'Войти', exact: true })
    .click();
  await expect(reviews.getByLabel('Ваш опыт использования')).toHaveValue('');
});

test('account submits only pending review and deletion requires explicit confirmation', async ({
  page,
}) => {
  const f = await fixture(page);
  const reviews = block(page);
  await reviews.getByLabel('Ваш опыт использования').fill(sample.text);
  await reviews.getByLabel('Ваша оценка').selectOption('4');
  await reviews
    .getByRole('button', { name: 'Отправить отзыв на модерацию' })
    .click();
  await expect(
    reviews.getByText('На модерации. Пока не влияет на рейтинг.'),
  ).toBeVisible();
  await expect(
    reviews.getByText(/Опубликованных отзывов пока нет/),
  ).toBeVisible();
  expect(f.puts()).toBe(1);
  await reviews
    .getByRole('button', { name: 'Удалить свой отзыв', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Удалить свой отзыв?' });
  await expect(dialog).toBeVisible();
  expect(f.deletes()).toBe(0);
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(
    reviews.getByRole('button', { name: 'Удалить свой отзыв', exact: true }),
  ).toBeFocused();
  expect(f.deletes()).toBe(0);
  await reviews
    .getByRole('button', { name: 'Удалить свой отзыв', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Удалить отзыв из публикации', exact: true })
    .click();
  await expect(
    reviews.getByText(
      'Отзыв удалён из публикации и больше не влияет на рейтинг.',
    ),
  ).toBeVisible();
  await expect(reviews.getByLabel('Ваш опыт использования')).toHaveValue('');
  expect(f.deletes()).toBe(1);
});

test('failed review write preserves draft and rating for retry', async ({
  page,
}) => {
  const f = await fixture(page);
  f.failWrites();
  const reviews = block(page);
  await reviews.getByLabel('Ваш опыт использования').fill(sample.text);
  await reviews.getByLabel('Ваша оценка').selectOption('2');
  await reviews
    .getByRole('button', { name: 'Отправить отзыв на модерацию' })
    .click();
  await expect(reviews.getByRole('alert')).toContainText(
    'Текст сохранён в форме',
  );
  await expect(reviews.getByLabel('Ваш опыт использования')).toHaveValue(
    sample.text,
  );
  await expect(reviews.getByLabel('Ваша оценка')).toHaveValue('2');
  await expect(
    reviews.getByRole('button', { name: 'Отправить отзыв на модерацию' }),
  ).toBeEnabled();
});

test('late review response never repopulates a different product draft', async ({
  page,
}) => {
  await fixture(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  let settled!: () => void;
  const delivered = new Promise<void>((resolve) => {
    settled = resolve;
  });
  await page.route(
    `**/api/v1/products/${variantId}/my-review`,
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      started();
      await held;
      await route
        .fulfill({
          status: 201,
          json: { resultKind: 'CREATED', review: sample },
        })
        .catch(() => {});
      settled();
    },
  );
  await block(page).getByLabel('Ваш опыт использования').fill(sample.text);
  await block(page)
    .getByRole('button', { name: 'Отправить отзыв на модерацию' })
    .click();
  await writing;
  await page.getByLabel('GTIN / EAN').fill(otherGtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Another Mascara', exact: true }),
  ).toBeVisible();
  await expect(block(page).getByLabel('Ваш опыт использования')).toHaveValue(
    '',
  );
  release();
  await delivered;
  await page.evaluate(() => Promise.resolve());
  await expect(block(page).getByLabel('Ваш опыт использования')).toHaveValue(
    '',
  );
  await expect(
    block(page).getByText('На модерации. Пока не влияет на рейтинг.'),
  ).toHaveCount(0);
});

test('changed account blocks pending publication and clears private draft', async ({
  page,
}) => {
  const f = await fixture(page);
  const reviews = block(page);
  await reviews.getByLabel('Ваш опыт использования').fill(sample.text);
  f.signOut();
  await reviews
    .getByRole('button', { name: 'Отправить отзыв на модерацию' })
    .click();
  await expect(reviews.getByText(/Аккаунт изменился/)).toBeVisible();
  await expect(reviews.getByLabel('Ваш опыт использования')).toHaveCount(0);
  expect(f.puts()).toBe(0);
});

test('own review is not populated when identity changes during its GET', async ({
  page,
}) => {
  const f = await fixture(page);
  await expect(block(page).getByLabel('Ваш опыт использования')).toBeVisible();
  const foreignText = 'Чужой приватный отзыв не должен появиться в форме.';
  await page.route(
    `**/api/v1/products/${otherVariantId}/my-review`,
    (route) => {
      f.signOut();
      return route.fulfill({
        json: {
          review: {
            ...sample,
            productVariantId: otherVariantId,
            text: foreignText,
          },
        },
      });
    },
  );
  await page.getByLabel('GTIN / EAN').fill(otherGtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  await expect(
    block(page).getByText(/Не удалось подтвердить аккаунт для отзыва/),
  ).toBeVisible();
  await expect(block(page).getByLabel('Ваш опыт использования')).toHaveCount(0);
  await expect(page.getByText(foreignText, { exact: true })).toHaveCount(0);
});

for (const method of ['PUT', 'DELETE'] as const) {
  test(`identity change after preflight rejects review ${method} and clears private data`, async ({
    page,
  }) => {
    const f = await fixture(page);
    const reviews = block(page);
    await reviews.getByLabel('Ваш опыт использования').fill(sample.text);
    if (method === 'DELETE') {
      await reviews
        .getByRole('button', { name: 'Отправить отзыв на модерацию' })
        .click();
      await expect(
        reviews.getByText('На модерации. Пока не влияет на рейтинг.'),
      ).toBeVisible();
    }
    let rejected = false;
    await page.route(
      `**/api/v1/products/${variantId}/my-review`,
      async (route) => {
        if (route.request().method() !== method) return route.fallback();
        expect(route.request().postDataJSON().expectedAccountId).toBe(
          account.accountId,
        );
        f.signOut();
        rejected = true;
        return route.fulfill({
          status: 403,
          json: {
            error: { code: 'FORBIDDEN', message: 'Account session changed' },
          },
        });
      },
    );
    if (method === 'PUT') {
      await reviews
        .getByRole('button', { name: 'Отправить отзыв на модерацию' })
        .click();
    } else {
      await reviews
        .getByRole('button', { name: 'Удалить свой отзыв', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Удалить свой отзыв?' })
        .getByRole('button', {
          name: 'Удалить отзыв из публикации',
          exact: true,
        })
        .click();
    }
    await expect(reviews.getByText(/Прежний черновик очищен/)).toBeVisible();
    await expect(reviews.getByLabel('Ваш опыт использования')).toHaveCount(0);
    await expect(
      reviews.getByText('На модерации. Пока не влияет на рейтинг.'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: 'Удалить свой отзыв?' }),
    ).not.toBeVisible();
    expect(rejected).toBe(true);
    expect(f.deletes()).toBe(0);
    expect(f.puts()).toBe(method === 'DELETE' ? 1 : 0);
  });
}

test('review topics explain mention counts and link to the displayed source', async ({
  page,
}) => {
  await fixture(page, false);
  const firstId = '66666666-6666-4666-8666-666666666666';
  const reviews = [
    {
      reviewId: firstId,
      stars: 4,
      text: 'Мне понравился объём, но смывать тушь было непросто.',
    },
    {
      reviewId: '77777777-7777-4777-8777-777777777777',
      stars: 3,
      text: 'Объём не появился, хотя щёточка оказалась удобной.',
    },
    {
      reviewId: '88888888-8888-4888-8888-888888888888',
      stars: 5,
      text: 'Мне подошёл этот вариант для макияжа на каждый день.',
    },
  ].map((review) => ({ ...review, verifiedPurchase: false, createdAt }));
  await page.route('**/api/v1/products/*/reviews?limit=20', (route) =>
    route.fulfill({
      json: {
        summary: {
          source: 'WTM',
          sourceQuality: 'LOW',
          verifiedPurchase: false,
          ratingValue: 4,
          reviewCount: 3,
          asOf: createdAt,
          reviews,
          mentions: {
            source: 'WTM',
            sampleSize: 3,
            asOf: createdAt,
            topics: [
              {
                topic: 'VOLUME',
                matchedReviewCount: 2,
                reviewIds: [firstId, reviews[1]!.reviewId],
              },
            ],
          },
        },
      },
    }),
  );
  await page.getByLabel('GTIN / EAN').fill(otherGtin);
  await page.getByRole('button', { name: 'Найти', exact: true }).click();
  const mentions = block(page).getByRole('region', { name: 'Темы в отзывах' });
  await expect(
    mentions.getByText(
      /Это упоминания в показанных отзывах, не оценка свойства/,
    ),
  ).toBeVisible();
  await expect(
    mentions.getByText(/Объём — упоминаний в отзывах: 2 из 3/),
  ).toBeVisible();
  const link = mentions.getByRole('link', {
    name: 'Объём: перейти к отзыву 1',
  });
  const target = block(page).locator(`li[id$="-review-${firstId}"]`);
  await expect(target).toContainText(reviews[0]!.text);
  await expect(link).toHaveAttribute(
    'href',
    `#${await target.getAttribute('id')}`,
  );
});
