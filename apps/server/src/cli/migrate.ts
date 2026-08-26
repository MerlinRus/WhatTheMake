import { createPostgresDatabase } from '@wtm/infrastructure';

import { loadServerConfig } from '../config.js';

const config = loadServerConfig(process.env);
const database = createPostgresDatabase({
  connectionString: config.databaseUrl,
  maxConnections: config.databasePoolMax,
  applicationName: 'wtm-migrations',
  onPoolError: (error) => console.error('PostgreSQL pool error', error),
});

try {
  const summary = await database.migrate(config.migrationsDirectory);
  console.info('Migrations complete', summary);
} finally {
  await database.close();
}
