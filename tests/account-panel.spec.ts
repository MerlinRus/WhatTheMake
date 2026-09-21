import { expect, test, type Page } from '@playwright/test';

const createdAt = '2026-09-20T18:00:00.000Z';
const guest = {
  kind: 'GUEST',
  guestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt,
};
const account = {
  kind: 'ACCOUNT',
  accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'buyer@example.test',
  createdAt,
};
const anonymous = { kind: 'ANONYMOUS' };
const snapshot = {
  snapshotId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  observationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  snapshotNumber: 1,
  category: 'MASCARA',
  barcode: {
    value: '5901234123457',
    format: 'EAN_13',
    gtin14: '05901234123457',
  },
  identity: {
    brandName: 'History Brand',
    familyName: 'Private Mascara',
    variantName: 'Black',
    shadeName: null,
    netQuantity: null,
    isWaterproof: null,
  },
  identitySource: 'USER_CONFIRMED_PACKAGING',
  revision: {
    revisionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    revisionNumber: 1,
    source: { kind: 'USER_TRANSCRIPTION' },
    sourceText: 'Aqua',
    sourceSha256: 'a'.repeat(64),
    authorKind: 'GUEST',
    createdAt,
  },
  formulaComplete: false,
  claimKinds: [],
  claimsSource: 'USER_CONFIRMED_PACKAGING',
  priceKopecks: null,
  priceSource: null,
  createdAt,
};

function panel(page: Page) {
  return page.getByRole('region', { name: 'Аккаунт и личная история' });
}

async function fixture(
  page: Page,
  initial: typeof guest | typeof account | typeof anonymous,
) {
  let principal = initial;
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({ json: { principal } }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) =>
    route.fulfill({
      json: { snapshots: principal.kind === 'ANONYMOUS' ? [] : [snapshot] },
    }),
  );
  return {
    setPrincipal(value: typeof principal) {
      principal = value;
    },
  };
}

test('guest registration uses existing API, keeps owned history and clears password', async ({
  page,
}) => {
  const state = await fixture(page, guest);
  let posted: unknown;
  await page.route('**/api/v1/accounts', (route) => {
    posted = route.request().postDataJSON();
    state.setPrincipal(account);
    return route.fulfill({ status: 201, json: { principal: account } });
  });
  await page.goto('/');
  await expect(
    panel(page).getByRole('heading', {
      name: 'History Brand · Private Mascara',
    }),
  ).toBeVisible();
  await panel(page).getByLabel('Email', { exact: true }).fill(account.email);
  await panel(page)
    .getByLabel('Пароль', { exact: true })
    .fill('test-password-123');
  await panel(page).getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(
    panel(page).getByText(`Вы вошли: ${account.email}`),
  ).toBeVisible();
  expect(posted).toEqual({
    email: account.email,
    password: 'test-password-123',
  });
  await expect(
    panel(page).getByRole('button', { name: 'Открыть карточку' }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('button', { name: 'Сравнить эту карточку' }),
  ).toBeVisible();
  await expect(panel(page).getByLabel('Пароль', { exact: true })).toHaveCount(
    0,
  );
  expect(await page.evaluate(() => Object.keys(localStorage).length)).toBe(0);
});

test('failed login clears secret and reports invalid credentials', async ({
  page,
}) => {
  await fixture(page, anonymous);
  await page.route('**/api/v1/account-sessions', (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto('/');
  await panel(page).getByRole('radio', { name: 'Вход', exact: true }).check();
  await panel(page).getByLabel('Email', { exact: true }).fill(account.email);
  await panel(page)
    .getByLabel('Пароль', { exact: true })
    .fill('wrong-password-123');
  await panel(page).getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(panel(page).getByRole('alert')).toContainText(
    'Проверьте email и пароль',
  );
  await expect(panel(page).getByLabel('Пароль', { exact: true })).toHaveValue(
    '',
  );
});

test('account logout removes private rows and returns anonymous controls', async ({
  page,
}) => {
  const state = await fixture(page, account);
  await page.route('**/api/v1/account-sessions/current', (route) => {
    expect(route.request().method()).toBe('DELETE');
    state.setPrincipal(anonymous);
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await expect(
    panel(page).getByText('Black · GTIN 5901234123457'),
  ).toBeVisible();
  await panel(page).getByRole('button', { name: 'Выйти из аккаунта' }).click();
  await expect(
    panel(page).getByRole('button', { name: 'Создать аккаунт' }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('heading', {
      name: 'History Brand · Private Mascara',
    }),
  ).toHaveCount(0);
});

test('guest deletion requires typed confirmation and cancellation never deletes', async ({
  page,
}) => {
  const state = await fixture(page, guest);
  let deletes = 0;
  await page.route('**/api/v1/guest-sessions/current', (route) => {
    deletes += 1;
    expect(route.request().method()).toBe('DELETE');
    state.setPrincipal(anonymous);
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  const trigger = panel(page).getByRole('button', {
    name: 'Удалить гостевые данные',
    exact: true,
  });
  await trigger.click();
  const confirmation = page.getByRole('dialog', {
    name: 'Удалить гостевые данные и фотографии?',
  });
  const confirm = confirmation.getByRole('button', {
    name: 'Удалить гостевые данные и фотографии',
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await confirmation.getByRole('button', { name: 'Отмена' }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(deletes).toBe(0);
  await trigger.click();
  await confirmation.getByLabel('Введите УДАЛИТЬ').fill('УДАЛИТЬ');
  await confirm.click();
  await expect(
    panel(page).getByText('Гостевые данные удалены.', { exact: true }),
  ).toBeVisible();
  expect(deletes).toBe(1);
  await expect(
    panel(page).getByRole('heading', {
      name: 'History Brand · Private Mascara',
    }),
  ).toHaveCount(0);
});

test('malformed session fails closed and can be retried', async ({ page }) => {
  await fixture(page, anonymous);
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({
      json: {
        principal: { kind: 'ACCOUNT', email: 'missing-id@example.test' },
      },
    }),
  );
  await page.goto('/');
  await expect(panel(page).getByRole('alert')).toContainText(
    'некорректную сессию',
  );
  await expect(panel(page).getByLabel('Email', { exact: true })).toHaveCount(0);
  await expect(
    panel(page).getByRole('button', { name: 'Обновить сессию и историю' }),
  ).toBeEnabled();
});

test('changed guest identity blocks deletion before any DELETE request', async ({
  page,
}) => {
  const state = await fixture(page, guest);
  let deletes = 0;
  await page.route('**/api/v1/guest-sessions/current', (route) => {
    deletes += 1;
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await panel(page)
    .getByRole('button', { name: 'Удалить гостевые данные', exact: true })
    .click();
  const confirmation = page.getByRole('dialog');
  await confirmation.getByLabel('Введите УДАЛИТЬ').fill('УДАЛИТЬ');
  state.setPrincipal(account);
  await confirmation
    .getByRole('button', {
      name: 'Удалить гостевые данные и фотографии',
      exact: true,
    })
    .click();
  await expect(panel(page).getByRole('alert')).toContainText(
    'Сессия изменилась',
  );
  expect(deletes).toBe(0);
});
