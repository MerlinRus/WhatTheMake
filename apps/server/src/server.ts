import {
  createLocalMediaStorage,
  createMediaRecoveryWorker,
  createPostgresDatabase,
  createOpenBeautyFactsProductProvider,
  type MediaRecoveryWorker,
} from '@wtm/infrastructure';

import { buildApp } from './app.js';
import { createCatalogLookupService } from './catalog/service.js';
import {
  createComparisonService,
  createNoDataComparisonReviewSignalProvider,
} from './comparison/service.js';
import { loadServerConfig } from './config.js';
import { createIdentityService } from './identity/service.js';
import { createInciCorrectionService } from './inci-corrections/service.js';
import { createMediaService } from './media/service.js';
import { createMascaraPreferencesService } from './preferences/service.js';
import { createProductObservationService } from './product-observations/service.js';
import { createProductDiscoveryService } from './product-discovery/service.js';
import {
  createProviderRuntime,
  type ProviderRuntime,
  type ProviderRuntimeEvent,
} from './provider-runtime.js';

async function start(): Promise<void> {
  const config = loadServerConfig(process.env);
  const database = createPostgresDatabase({
    connectionString: config.databaseUrl,
    maxConnections: config.databasePoolMax,
    applicationName: 'what-the-make',
    onPoolError: (error) => console.error('PostgreSQL pool error', error),
  });
  let providerRuntime: ProviderRuntime | null = null;
  let reportProviderEvent: ((event: ProviderRuntimeEvent) => void) | undefined;

  try {
    await database.migrate(config.migrationsDirectory);
    providerRuntime = createProviderRuntime({
      config,
      ocrCache: database.ocrCache,
      onEvent: (event) => reportProviderEvent?.(event),
    });
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
    const productObservationService = createProductObservationService({
      identity: identityService,
      repository: database.productObservations,
    });
    const catalogService = createCatalogLookupService({
      repository: database.catalog,
    });
    const productDiscoveryService = createProductDiscoveryService({
      provider: createOpenBeautyFactsProductProvider(),
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
        service: catalogService,
      },
      comparisons: {
        service: createComparisonService({
          catalog: catalogService,
          discovery: productDiscoveryService,
          reviews: createNoDataComparisonReviewSignalProvider(),
        }),
        publicOrigin: config.publicOrigin,
      },
      identity: {
        service: identityService,
        publicOrigin: config.publicOrigin,
        cookieName,
        secureCookie: config.nodeEnvironment === 'production',
      },
      inciCorrections: {
        service: createInciCorrectionService({
          identity: identityService,
          repository: database.productObservationInci,
          dictionary: database.inciDictionary,
          media: mediaService,
          observations: productObservationService,
          ...(providerRuntime.ocr ? { ocr: providerRuntime.ocr } : {}),
        }),
        publicOrigin: config.publicOrigin,
        cookieName,
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
        service: productObservationService,
        publicOrigin: config.publicOrigin,
        cookieName,
      },
      productDiscovery: {
        service: productDiscoveryService,
      },
      onClose: async () => {
        await mediaRecoveryWorker?.stop();
        await providerRuntime?.shutdown();
        await database.close();
      },
    });
    reportProviderEvent = (event) => {
      app.log.info(event, 'Provider runtime event');
    };
    app.log.info(
      { providers: providerRuntime.metadata },
      'External providers configured',
    );
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
    await providerRuntime?.shutdown().catch(() => {});
    await database.close().catch(() => {});
    throw error;
  }
}

start().catch((error: unknown) => {
  console.error('WTM server failed to start', error);
  process.exitCode = 1;
});
