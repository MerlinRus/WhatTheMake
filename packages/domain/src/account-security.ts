export interface RotateAccountRecoveryCodeInput {
  accountId: string;
  expectedPasswordHash: string;
  codeHash: string;
}

export interface RecoverAccountInput {
  emailNormalized: string;
  codeHash: string;
  newPasswordHash: string;
}

export interface AccountSecurityRepository {
  /** Replaces the previous digest only while the reauthenticated password still matches. */
  rotateRecoveryCode(input: RotateAccountRecoveryCodeInput): Promise<boolean>;
  /** Consumes one code, replaces the password and revokes every account session atomically. */
  recoverAccount(input: RecoverAccountInput): Promise<boolean>;
}
