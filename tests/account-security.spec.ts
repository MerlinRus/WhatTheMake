import { expect, test, type Page } from '@playwright/test';

const account = {
  kind: 'ACCOUNT',
  accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'buyer@example.test',
  createdAt: '2026-09-20T00:00:00.000Z',
};
const anonymous = { kind: 'ANONYMOUS' };
const password = 'Original password 123';
const recoveryCode = 'a'.repeat(43);

async function fixture(page: Page, initial: typeof account | typeof anonymous) {
  let principal = initial;
  await page.route('**/api/v1/session', (route) =>
    route.fulfill({ json: { principal } }),
  );
  await page.route('**/api/v1/private-products?limit=30', (route) =>
    route.fulfill({ json: { snapshots: [] } }),
  );
  return {
    setPrincipal(value: typeof principal) {
      principal = value;
    },
  };
}

function security(page: Page) {
  return page.locator('.account-security');
}
function panel(page: Page) {
  return page.getByRole('region', { name: 'Аккаунт и личная история' });
}

test('account recovery code is shown only in memory and can be explicitly hidden', async ({
  page,
}) => {
  const state = await fixture(page, account);
  let posted: unknown;
  await page.route('**/api/v1/accounts/current/recovery-code', (route) => {
    posted = route.request().postDataJSON();
    return route.fulfill({ json: { recoveryCode } });
  });
  await page.route('**/api/v1/account-sessions/current', (route) => {
    state.setPrincipal(anonymous);
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await security(page)
    .getByLabel('Текущий пароль для резервного кода')
    .fill(password);
  await security(page)
    .getByRole('button', { name: 'Создать новый резервный код' })
    .click();
  await expect(security(page).getByLabel('Ваш резервный код')).toHaveValue(
    recoveryCode,
  );
  await expect(
    security(page).getByLabel('Текущий пароль для резервного кода'),
  ).toHaveValue('');
  expect(posted).toEqual({ currentPassword: password });
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).length + Object.keys(sessionStorage).length,
    ),
  ).toBe(0);
  await security(page)
    .getByRole('button', { name: 'Я сохранил(а) код — скрыть' })
    .click();
  await expect(security(page).getByLabel('Ваш резервный код')).toHaveCount(0);
  await security(page)
    .getByLabel('Текущий пароль для резервного кода')
    .fill(password);
  await security(page)
    .getByRole('button', { name: 'Создать новый резервный код' })
    .click();
  await expect(security(page).getByLabel('Ваш резервный код')).toHaveValue(
    recoveryCode,
  );
  await panel(page).getByRole('button', { name: 'Выйти из аккаунта' }).click();
  await expect(security(page).getByLabel('Ваш резервный код')).toHaveCount(0);
  await expect(
    security(page).getByRole('heading', {
      name: 'Восстановление по резервному коду',
    }),
  ).toBeVisible();
});

test('offline password reset validates confirmation, clears secrets and never auto-logins', async ({
  page,
}) => {
  await fixture(page, anonymous);
  const requests: unknown[] = [];
  let logins = 0;
  await page.route('**/api/v1/account-recovery', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { reset: true, requiresLogin: true } });
  });
  await page.route('**/api/v1/account-sessions', (route) => {
    logins += 1;
    return route.fulfill({ status: 500 });
  });
  await page.goto('/');
  await security(page)
    .getByLabel('Email аккаунта для восстановления')
    .fill(account.email);
  await security(page)
    .getByLabel('Резервный код для восстановления')
    .fill(recoveryCode);
  await security(page)
    .getByLabel('Новый пароль', { exact: true })
    .fill('Replacement password 456');
  await security(page)
    .getByLabel('Повторите новый пароль')
    .fill('Does not match 789');
  await security(page)
    .getByRole('button', { name: 'Сменить пароль по резервному коду' })
    .click();
  await expect(security(page).getByRole('alert')).toContainText('не совпадают');
  expect(requests).toHaveLength(0);
  await security(page)
    .getByLabel('Повторите новый пароль')
    .fill('Replacement password 456');
  await security(page)
    .getByRole('button', { name: 'Сменить пароль по резервному коду' })
    .click();
  await expect(security(page).getByRole('status')).toContainText(
    'Войдите заново с новым паролем',
  );
  expect(requests).toEqual([
    {
      email: account.email,
      code: recoveryCode,
      newPassword: 'Replacement password 456',
    },
  ]);
  for (const label of [
    'Резервный код для восстановления',
    'Новый пароль',
    'Повторите новый пароль',
  ])
    await expect(security(page).getByLabel(label, { exact: true })).toHaveValue(
      '',
    );
  expect(logins).toBe(0);
  await expect(
    panel(page).getByRole('button', { name: 'Создать аккаунт' }),
  ).toBeVisible();
});

test('failed recovery clears secrets without echoing code or claiming reset', async ({
  page,
}) => {
  await fixture(page, anonymous);
  await page.route('**/api/v1/account-recovery', (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.goto('/');
  await security(page)
    .getByLabel('Email аккаунта для восстановления')
    .fill(account.email);
  await security(page)
    .getByLabel('Резервный код для восстановления')
    .fill(recoveryCode);
  await security(page)
    .getByLabel('Новый пароль', { exact: true })
    .fill(password);
  await security(page).getByLabel('Повторите новый пароль').fill(password);
  await security(page)
    .getByRole('button', { name: 'Сменить пароль по резервному коду' })
    .click();
  await expect(security(page).getByRole('alert')).toContainText(
    'Проверьте пароль или email и резервный код',
  );
  await expect(
    security(page).getByLabel('Резервный код для восстановления'),
  ).toHaveValue('');
  await expect(
    security(page).getByLabel('Новый пароль', { exact: true }),
  ).toHaveValue('');
  await expect(
    security(page).getByText(recoveryCode, { exact: true }),
  ).toHaveCount(0);
  await expect(
    security(page).getByText('Пароль изменён.', { exact: false }),
  ).toHaveCount(0);
});

test('account deletion requires typed confirmation and password, supports cancel, clears session', async ({
  page,
}) => {
  const state = await fixture(page, account);
  const requests: unknown[] = [];
  await page.route('**/api/v1/accounts/current', (route) => {
    expect(route.request().method()).toBe('DELETE');
    requests.push(route.request().postDataJSON());
    state.setPrincipal(anonymous);
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  const trigger = security(page).getByRole('button', {
    name: 'Удалить аккаунт и личные данные',
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', {
    name: 'Удалить аккаунт без возможности восстановления?',
  });
  await expect(
    dialog.getByRole('button', { name: 'Удалить аккаунт навсегда' }),
  ).toBeDisabled();
  await dialog.getByLabel('Пароль для удаления аккаунта').fill(password);
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(requests).toHaveLength(0);
  await trigger.click();
  await expect(dialog.getByLabel('Пароль для удаления аккаунта')).toHaveValue(
    '',
  );
  await dialog.getByLabel('Пароль для удаления аккаунта').fill(password);
  await dialog.getByLabel('Введите УДАЛИТЬ для аккаунта').fill('УДАЛИТЬ');
  await dialog
    .getByRole('button', { name: 'Удалить аккаунт навсегда' })
    .click();
  await expect(
    panel(page).getByText('Аккаунт и личные данные удалены из доступа.', {
      exact: false,
    }),
  ).toBeVisible();
  expect(requests).toEqual([{ password, confirmation: 'DELETE' }]);
  await expect(
    panel(page).getByRole('button', { name: 'Создать аккаунт' }),
  ).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Личная история', exact: true }),
  ).toHaveCount(0);
});

test('changed account identity blocks deletion before any destructive request', async ({
  page,
}) => {
  const state = await fixture(page, account);
  let deletes = 0;
  await page.route('**/api/v1/accounts/current', (route) => {
    deletes += 1;
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await security(page)
    .getByRole('button', {
      name: 'Удалить аккаунт и личные данные',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Удалить аккаунт без возможности восстановления?',
  });
  await dialog.getByLabel('Пароль для удаления аккаунта').fill(password);
  await dialog.getByLabel('Введите УДАЛИТЬ для аккаунта').fill('УДАЛИТЬ');
  state.setPrincipal({
    ...account,
    accountId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'different@example.test',
  });
  await dialog
    .getByRole('button', { name: 'Удалить аккаунт навсегда' })
    .click();
  await expect(
    panel(page).getByText('Сессия изменилась.', { exact: false }),
  ).toBeVisible();
  expect(deletes).toBe(0);
  await expect(
    panel(page).getByText('Вы вошли: different@example.test'),
  ).toBeVisible();
});
