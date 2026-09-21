export interface AccountErasureRepository {
  erase(input: {
    accountId: string;
    expectedPasswordHash: string;
    sessionTokenHash: string;
  }): Promise<'ERASED' | 'AUTH_CHANGED'>;
}
