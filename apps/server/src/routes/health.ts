import type { FastifyInstance } from 'fastify';

import {
  LiveResponseSchema,
  ReadyResponseSchema,
  type LiveResponse,
  type ReadyResponse,
  type Version,
} from '@wtm/contracts';
import type { DatabaseHealthProbe } from '@wtm/infrastructure';

export interface HealthRoutesOptions {
  database: DatabaseHealthProbe | null;
  version: Version;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions,
): Promise<void> {
  app.get<{ Reply: LiveResponse }>(
    '/api/v1/live',
    { schema: { response: { 200: LiveResponseSchema } } },
    async () => ({
      status: 'UP',
      now: new Date().toISOString(),
      version: options.version,
    }),
  );

  app.get<{ Reply: ReadyResponse }>(
    '/api/v1/ready',
    {
      schema: {
        response: {
          200: ReadyResponseSchema,
          503: ReadyResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      const database = options.database
        ? await options.database.health()
        : { status: 'DOWN' as const, latencyMs: 0 };
      const status = database.status === 'UP' ? 'UP' : 'DOWN';
      const payload: ReadyResponse = {
        status,
        now: new Date().toISOString(),
        version: options.version,
        checks: { database },
      };
      return reply.code(status === 'UP' ? 200 : 503).send(payload);
    },
  );
}
