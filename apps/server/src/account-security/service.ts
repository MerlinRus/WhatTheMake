import { createHash, randomBytes } from 'node:crypto';

import type {
  AccountRecoveryInput,
  AccountRecoveryResponse,
  RotateAccountRecoveryCodeResponse,
} from '@wtm/contracts';
import type {
  AccountSecurityRepository,
  IdentityRepository,
} from '@wtm/domain';

import { AppError } from '../errors.js';
import {
  createPasswordHasher,
  type PasswordHasher,
} from '../identity/passwords.js';
import type { IdentityService } from '../identity/service.js';

export interface AccountSecurityService {
  rotateRecoveryCode(
    token: string | null,
    currentPassword: string,
  ): Promise<RotateAccountRecoveryCodeResponse>;
  recoverAccount(input: AccountRecoveryInput): Promise<AccountRecoveryResponse>;
}

function invalidCredentials(): AppError {
  return new AppError({
    statusCode: 401,
    code: 'UNAUTHENTICATED',
    message: 'Invalid recovery credentials',
  });
}

function codeHash(code: string): string {
  return createHash('sha256').update(code, 'ascii').digest('hex');
}

export function createAccountSecurityService(options: {
  identity: Pick<IdentityService, 'current'>;
  identities: Pick<IdentityRepository, 'findAccountByEmail'>;
  repository: AccountSecurityRepository;
  passwordHasher?: PasswordHasher;
}): AccountSecurityService {
  const passwords = options.passwordHasher ?? createPasswordHasher();
  return {
    async rotateRecoveryCode(token, currentPassword) {
      const principal = await options.identity.current(token);
      if (!principal) throw invalidCredentials();
      if (principal.kind !== 'ACCOUNT')
        throw new AppError({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Account session required',
        });
      const credential = await options.identities.findAccountByEmail(
        principal.email,
      );
      if (!credential) {
        await passwords.consume(currentPassword);
        throw invalidCredentials();
      }
      const verified = await passwords.verify(
        currentPassword,
        credential.passwordHash,
      );
      if (
        !verified ||
        credential.status !== 'ACTIVE' ||
        credential.accountId !== principal.accountId
      )
        throw invalidCredentials();
      const recoveryCode = randomBytes(32).toString('base64url');
      const rotated = await options.repository.rotateRecoveryCode({
        accountId: principal.accountId,
        expectedPasswordHash: credential.passwordHash,
        codeHash: codeHash(recoveryCode),
      });
      if (!rotated) throw invalidCredentials();
      return { recoveryCode };
    },
    async recoverAccount(input) {
      // Equal expensive work for unknown emails, malformed codes and valid credentials.
      const newPasswordHash = await passwords.hash(input.newPassword);
      const emailNormalized = input.email
        .normalize('NFKC')
        .trim()
        .toLowerCase();
      const code = input.code.trim();
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized) ||
        !/^[A-Za-z0-9_-]{43}$/.test(code)
      )
        throw invalidCredentials();
      const reset = await options.repository.recoverAccount({
        emailNormalized,
        codeHash: codeHash(code),
        newPasswordHash,
      });
      if (!reset) throw invalidCredentials();
      return { reset: true, requiresLogin: true };
    },
  };
}
