import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const DEFAULT_COST = 65_536;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 96 * 1024 * 1024;
const HASH_PATTERN =
  /^scrypt\$v=1\$n=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;
const DUMMY_SALT = Buffer.from('what-the-make-dummy-salt', 'utf8');

interface ScryptParameters {
  cost: number;
  blockSize: number;
  parallelization: number;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
  consume(password: string): Promise<void>;
}

async function deriveKey(
  password: string,
  salt: Buffer,
  parameters: ScryptParameters,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function parseHash(
  encodedHash: string,
  expectedParameters: ScryptParameters,
): {
  parameters: ScryptParameters;
  salt: Buffer;
  expectedKey: Buffer;
} | null {
  const match = HASH_PATTERN.exec(encodedHash);
  if (!match) return null;

  const cost = Number(match[1]);
  const blockSize = Number(match[2]);
  const parallelization = Number(match[3]);
  const salt = Buffer.from(match[4] ?? '', 'base64url');
  const expectedKey = Buffer.from(match[5] ?? '', 'base64url');
  if (
    cost !== expectedParameters.cost ||
    blockSize !== expectedParameters.blockSize ||
    parallelization !== expectedParameters.parallelization ||
    salt.length !== SALT_LENGTH ||
    expectedKey.length !== KEY_LENGTH
  ) {
    return null;
  }
  return {
    parameters: { cost, blockSize, parallelization },
    salt,
    expectedKey,
  };
}

export function createPasswordHasher(
  parameters: ScryptParameters = {
    cost: DEFAULT_COST,
    blockSize: DEFAULT_BLOCK_SIZE,
    parallelization: DEFAULT_PARALLELIZATION,
  },
): PasswordHasher {
  const consume = async (password: string): Promise<void> => {
    await deriveKey(password, DUMMY_SALT, parameters);
  };

  return {
    async hash(password): Promise<string> {
      const salt = randomBytes(SALT_LENGTH);
      const derivedKey = await deriveKey(password, salt, parameters);
      return [
        'scrypt',
        'v=1',
        `n=${parameters.cost},r=${parameters.blockSize},p=${parameters.parallelization}`,
        salt.toString('base64url'),
        derivedKey.toString('base64url'),
      ].join('$');
    },

    async verify(password, encodedHash): Promise<boolean> {
      const parsed = parseHash(encodedHash, parameters);
      if (!parsed) {
        await consume(password);
        return false;
      }
      const actualKey = await deriveKey(
        password,
        parsed.salt,
        parsed.parameters,
      );
      return timingSafeEqual(actualKey, parsed.expectedKey);
    },

    consume,
  };
}
