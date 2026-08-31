import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createPostgresDatabase } from '@wtm/infrastructure';

import { loadServerConfig } from '../config.js';
import {
  InciDictionaryValidationError,
  prepareInciDictionaryPublication,
} from '../inci-dictionary/service.js';

const DEFAULT_DICTIONARY_PATH = fileURLToPath(
  new URL('../../seeds/inci/dictionary.json', import.meta.url),
);
export const MAXIMUM_DICTIONARY_BYTES = 2 * 1024 * 1024;
const INVALID_DICTIONARY_FILE_MESSAGE =
  'INCI dictionary must be a regular file no larger than 2 MiB';

interface Command {
  dryRun: boolean;
  filePath: string;
}

function parseCommand(arguments_: readonly string[]): Command {
  let dryRun = false;
  let filePath = DEFAULT_DICTIONARY_PATH;
  let fileWasProvided = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may be specified only once');
      dryRun = true;
      continue;
    }
    if (argument === '--file') {
      if (fileWasProvided) throw new Error('--file may be specified only once');
      const value = arguments_[index + 1];
      if (!value) throw new Error('--file requires a path');
      filePath = value;
      fileWasProvided = true;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument ?? ''}`);
  }
  return { dryRun, filePath: resolve(filePath) };
}

export function decodeInciDictionaryArtifact(bytes: Buffer): string {
  if (bytes.byteLength > MAXIMUM_DICTIONARY_BYTES) {
    throw new Error(INVALID_DICTIONARY_FILE_MESSAGE);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('INCI dictionary must be valid UTF-8');
  }
}

async function readInciDictionaryArtifact(filePath: string): Promise<string> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size > MAXIMUM_DICTIONARY_BYTES) {
    throw new Error(INVALID_DICTIONARY_FILE_MESSAGE);
  }
  const bytes = await readFile(filePath);
  return decodeInciDictionaryArtifact(bytes);
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const publication = prepareInciDictionaryPublication(
    await readInciDictionaryArtifact(command.filePath),
  );
  const config = loadServerConfig(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: Math.min(config.databasePoolMax, 4),
    applicationName: 'wtm-inci-dictionary-seed',
  });

  try {
    const report = command.dryRun
      ? await database.inciDictionary.previewPublication(publication)
      : await database.inciDictionary.publish(publication);
    if (report.kind === 'PUBLISHED' || report.kind === 'ALREADY_PUBLISHED') {
      const published = await database.inciDictionary.findPublishedSnapshot();
      if (!isDeepStrictEqual(published, publication.snapshot)) {
        throw new Error(
          'Published INCI dictionary does not equal the source artifact',
        );
      }
    }
    console.info(JSON.stringify(report));
    if (report.kind === 'VERSION_CONFLICT') process.exitCode = 2;
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'ERROR',
        code:
          error instanceof InciDictionaryValidationError
            ? error.code
            : 'RUNTIME_ERROR',
        message:
          error instanceof Error
            ? error.message
            : 'INCI dictionary command failed',
      }),
    );
    process.exitCode = 1;
  }
}
