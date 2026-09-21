import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresDatabase } from '@wtm/infrastructure';
import { loadServerConfig } from '../config.js';
import { prepareIngredientKnowledgePublication } from '../ingredient-knowledge/publication.js';

async function main(): Promise<void> {
  let apply = false;
  let filePath = fileURLToPath(
    new URL('../../seeds/ingredient-knowledge/functions.json', import.meta.url),
  );
  let fileProvided = false;
  let modeProvided = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--apply' || argument === '--dry-run') {
      if (modeProvided) throw new Error('Choose one publication mode');
      modeProvided = true;
      apply = argument === '--apply';
    } else if (
      argument === '--file' &&
      !fileProvided &&
      process.argv[index + 1]
    ) {
      filePath = resolve(process.argv[++index] ?? '');
      fileProvided = true;
    } else throw new Error('Use --dry-run or --apply and optional --file');
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size > 256 * 1024)
    throw new Error('Knowledge artifact must be a regular file <=256 KiB');
  const bytes = await readFile(filePath);
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const config = loadServerConfig(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 2,
    applicationName: 'wtm-ingredient-knowledge-seed',
  });
  try {
    const dictionary = await database.inciDictionary.findPublishedSnapshot();
    if (!dictionary)
      throw new Error(
        'Publish the INCI dictionary before ingredient knowledge',
      );
    const publishedAt = new Date();
    const draft = prepareIngredientKnowledgePublication(
      raw,
      dictionary,
      publishedAt,
    );
    const report = await database.ingredientKnowledge.publishInitialSnapshot({
      draft,
      dictionaryVersion: dictionary.dictionaryVersion,
      publishedAt,
      dryRun: !apply,
    });
    console.info(JSON.stringify(report));
    if (
      report.kind === 'VERSION_CONFLICT' ||
      report.kind === 'ACTIVE_SNAPSHOT_CONFLICT'
    )
      process.exitCode = 2;
  } finally {
    await database.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'ERROR',
        message:
          error instanceof Error
            ? error.message
            : 'Knowledge publication failed',
      }),
    );
    process.exitCode = 1;
  }
}
