export interface GuestIdentity {
  kind: 'GUEST';
  guestId: string;
  createdAt: Date;
}

export interface AccountIdentity {
  kind: 'ACCOUNT';
  accountId: string;
  email: string;
  createdAt: Date;
}

export type AuthenticatedIdentity = GuestIdentity | AccountIdentity;

export interface AccountCredential extends AccountIdentity {
  passwordHash: string;
  status: 'ACTIVE' | 'BLOCKED' | 'DELETED';
}

export interface CreateAccountInput {
  email: string;
  passwordHash: string;
  sessionTokenHash: string;
  guestSessionTokenHash?: string;
  expiresAt: Date;
}

export interface IdentityRepository {
  createGuestSession(sessionTokenHash: string): Promise<GuestIdentity>;
  resolveSession(
    sessionTokenHash: string,
  ): Promise<AuthenticatedIdentity | null>;
  deleteGuestBySession(sessionTokenHash: string): Promise<void>;
  createAccount(input: CreateAccountInput): Promise<AccountIdentity>;
  findAccountByEmail(email: string): Promise<AccountCredential | null>;
  createAccountSession(
    accountId: string,
    sessionTokenHash: string,
    expiresAt: Date,
    guestSessionTokenHash?: string,
  ): Promise<AccountIdentity | null>;
  revokeSession(sessionTokenHash: string): Promise<void>;
}

export class AccountEmailConflictError extends Error {
  constructor() {
    super('Account email already exists');
    this.name = 'AccountEmailConflictError';
  }
}
