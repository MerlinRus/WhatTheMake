import {
  createLocalMediaStorage,
  createMediaRecoveryWorker,
  createPostgresDatabase,
  type MediaRecoveryWorker,
} from '@wtm/infrastructure';

import { buildApp } from './app.js';
import { createCatalogLookupService } from './catalog/service.js';
import { loadServerConfig } from './config.js';
import { createIdentityService } from './identity/service.js';
import { createMediaService } from './media/service.js';
import { createMascaraPreferencesService } from './preferences/service.js';
import { createProductObservationService } from './product-observations/service.js';

async function start(): Promise<void> {
  const config = loadServerConfig(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: config.databasePoolMax,
    applicationName: 'what-the-make',
    onPoolError: (error) => console.error('PostgreSQL pool error', error),
  });

  try {
    await database.migrate(config.migrationsDirectory);
    const identityService = createIdentityService({
      repository: database.identity,
    });
    const cookieName =
      config.nodeEnvironment === 'production'
        ? '__Host-wtm_session'
        : 'wtm_session';
    const mediaStorage = createLocalMediaStorage({
      rootDirectory: config.mediaRoot,
    });
    const mediaService = createMediaService({
      identity: identityService,
      repository: database.media,
      storage: mediaStorage,
      maxBytes: config.mediaMaxBytes,
      recoveryDelayMs: config.mediaUploadRecoveryDelayMs,
    });
    let mediaRecoveryWorker: MediaRecoveryWorker | null = null;
    const app = await buildApp({
      database,
      logger: { level: config.logLevel },
      version: {
        name: 'what-the-make',
        version: config.version,
        buildSha: config.buildSha,
      },
      trustProxy:
        config.nodeEnvironment === 'production'
          ? (_address: string, hop: number) => hop === 0
          : false,
      webRoot: config.webRoot,
      catalog: {
        service: createCatalogLookupService({ repository: database.catalog }),
      },
      identity: {
        service: identityService,
        publicOrigin: config.publicOrigin,
        cookieName,
        secureCookie: config.nodeEnvironment === 'production',
      },
      mascaraPreferences: {
        service: createMascaraPreferencesService({
          identity: identityService,
          repository: database.preferences,
        }),
        publicOrigin: config.publicOrigin,
        cookieName,
      },
      media: {
        service: mediaService,
        publicOrigin: config.publicOrigin,
        cookieName,
        maxBytes: config.mediaMaxBytes,
      },
      productObservations: {
        service: createProductObservationService({
          identity: identityService,
          repository: database.productObservations,
        }),
        publicOrigin: config.publicOrigin,
        cookieName,
      },
      onClose: async () => {
        await mediaRecoveryWorker?.stop();
        await database.close();
      },
    });
    mediaRecoveryWorker = createMediaRecoveryWorker({
      repository: database.media,
      storage: mediaStorage,
      pollIntervalMs: config.mediaRecoveryPollMs,
      leaseMs: config.mediaRecoveryLeaseMs,
      retryBaseMs: config.mediaRecoveryRetryBaseMs,
      retryMaxMs: config.mediaRecoveryRetryMaxMs,
      onError: (context, error) => {
        app.log.error(
          {
            ...context,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          },
          'Media recovery attempt failed',
        );
      },
    });

    let stopping = false;
    const stop = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) return;
      stopping = true;
      app.log.info({ signal }, 'Stopping server');
      await app.close();
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => void stop(signal));
    }

    await app.listen({ host: config.host, port: config.port });
    mediaRecoveryWorker.start();
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

start().catch((error: unknown) => {
  console.error('WTM server failed to start', error);
  process.exitCode = 1;
});
