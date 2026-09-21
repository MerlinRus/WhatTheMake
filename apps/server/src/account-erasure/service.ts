import type { AccountErasureRepository, IdentityRepository } from '@wtm/domain';
import { AppError } from '../errors.js';
import { hashSessionToken, type IdentityService } from '../identity/service.js';
import {
  createPasswordHasher,
  type PasswordHasher,
} from '../identity/passwords.js';

export interface AccountErasureInput {
  password: string;
  confirmation: 'DELETE';
}
export interface AccountErasureService {
  erase(token: string | null, input: AccountErasureInput): Promise<void>;
}

function unauthenticated(): AppError {
  return new AppError({
    statusCode: 401,
    code: 'UNAUTHENTICATED',
    message: 'Account password verification required',
  });
}

export function createAccountErasureService(options: {
  identity: Pick<IdentityService, 'current'>;
  identityRepository: Pick<IdentityRepository, 'findAccountByEmail'>;
  repository: AccountErasureRepository;
  passwordHasher?: PasswordHasher;
}): AccountErasureService {
  const passwords = options.passwordHasher ?? createPasswordHasher();
  return {
    async erase(token, input) {
      if (
        input.confirmation !== 'DELETE' ||
        input.password.length < 12 ||
        input.password.length > 128
      )
        throw new AppError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'Password and explicit deletion confirmation required',
        });
      const identity = await options.identity.current(token);
      if (!identity || !token) throw unauthenticated();
      if (identity.kind !== 'ACCOUNT')
        throw new AppError({
          statusCode: 403,
          code: 'FORBIDDEN',
          message: 'Account session required',
        });
      const credential = await options.identityRepository.findAccountByEmail(
        identity.email,
      );
      if (
        !credential ||
        credential.accountId !== identity.accountId ||
        credential.status !== 'ACTIVE'
      ) {
        await passwords.consume(input.password);
        throw unauthenticated();
      }
      if (!(await passwords.verify(input.password, credential.passwordHash)))
        throw unauthenticated();
      if (
        (await options.repository.erase({
          accountId: identity.accountId,
          expectedPasswordHash: credential.passwordHash,
          sessionTokenHash: hashSessionToken(token),
        })) !== 'ERASED'
      )
        throw unauthenticated();
    },
  };
}
