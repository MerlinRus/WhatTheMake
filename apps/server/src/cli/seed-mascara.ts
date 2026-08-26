import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createPostgresDatabase } from '@wtm/infrastructure';

import {
  CatalogSeedValidationError,
  prepareCatalogImport,
} from '../catalog-import/service.js';
import { loadServerConfig } from '../config.js';

const DEFAULT_SEED_PATH = 'apps/server/seeds/mascara/seed.json';
const MAX_SEED_BYTES = 5 * 1024 * 1024;

type Command =
  | { operation: 'DRY_RUN' | 'PUBLISH'; filePath: string }
  | { operation: 'ROLLBACK'; importKey: string };

function parseCommand(arguments_: string[]): Command {
  let dryRun = false;
  let filePath = DEFAULT_SEED_PATH;
  let rollbackKey: string | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (argument === '--file') {
      const value = arguments_[index + 1];
      if (!value) throw new Error('--file requires a path');
      filePath = value;
      index += 1;
      continue;
    }
    if (argument === '--rollback') {
      const value = arguments_[index + 1];
      if (!value) throw new Error('--rollback requires an import key');
      rollbackKey = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }
  if (rollbackKey !== null) {
    if (dryRun || filePath !== DEFAULT_SEED_PATH) {
      throw new Error('--rollback cannot be combined with --dry-run or --file');
    }
    if (
      !/^[a-z0-9]+(?:-[a-z0-9]+)*@[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
        rollbackKey,
      )
    ) {
      throw new Error('--rollback import key is invalid');
    }
    return { operation: 'ROLLBACK', importKey: rollbackKey };
  }
  return {
    operation: dryRun ? 'DRY_RUN' : 'PUBLISH',
    filePath: resolve(filePath),
  };
}

function failedKind(kind: string): boolean {
  return [
    'QUARANTINED',
    'ALREADY_QUARANTINED',
    'VERSION_CONFLICT',
    'NOT_FOUND',
    'ROLLBACK_CONFLICT',
  ].includes(kind);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const config = loadServerConfig(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: Math.min(config.databasePoolMax, 4),
    applicationName: 'wtm-catalog-seed',
    onPoolError: (error) =>
      console.error('PostgreSQL pool error', error.message),
  });

  try {
    const report =
      command.operation === 'ROLLBACK'
        ? await database.catalogImports.rollback(command.importKey)
        : await (async () => {
            const seedStats = await stat(command.filePath);
            if (!seedStats.isFile() || seedStats.size > MAX_SEED_BYTES) {
              throw new Error(
                'Seed file must be a regular file no larger than 5 MiB',
              );
            }
            const input = prepareCatalogImport(
              await readFile(command.filePath, 'utf8'),
            );
            return command.operation === 'DRY_RUN'
              ? database.catalogImports.preview(input)
              : database.catalogImports.publish(input);
          })();
    console.info(JSON.stringify(report, null, 2));
    if (failedKind(report.kind)) process.exitCode = 2;
  } finally {
    await database.close();
  }
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof CatalogSeedValidationError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Catalog seed command failed';
  console.error(message);
  process.exitCode = 1;
}
