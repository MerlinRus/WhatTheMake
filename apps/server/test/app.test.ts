import assert from 'node:assert/strict';
import test from 'node:test';

import type { DatabaseHealthProbe } from '@wtm/infrastructure';

import { buildApp } from '../src/app.js';

function database(status: 'UP' | 'DOWN'): DatabaseHealthProbe {
  return {
    async health() {
      return { status, latencyMs: 1.25 };
    },
  };
}

test('liveness exposes version without depending on database readiness', async () => {
  const app = await buildApp({ database: database('DOWN') });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.json().version, {
      name: 'what-the-make',
      version: '0.1.0',
      buildSha: 'dev',
    });
  } finally {
    await app.close();
  }
});

test('readiness returns 200 only when PostgreSQL is available', async () => {
  const readyApp = await buildApp({ database: database('UP') });
  const downApp = await buildApp({ database: database('DOWN') });
  try {
    const ready = await readyApp.inject({
      method: 'GET',
      url: '/api/v1/ready',
    });
    const down = await downApp.inject({ method: 'GET', url: '/api/v1/ready' });

    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, 'UP');
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().status, 'DOWN');
    assert.deepEqual(down.json().checks.database, {
      status: 'DOWN',
      latencyMs: 1.25,
    });
  } finally {
    await readyApp.close();
    await downApp.close();
  }
});

test('readiness is down when database is not configured', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json().checks.database, {
      status: 'DOWN',
      latencyMs: 0,
    });
  } finally {
    await app.close();
  }
});

test('unknown route uses stable error envelope', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/missing',
    });
    const body = response.json();
    assert.equal(response.statusCode, 404);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(typeof body.error.requestId, 'string');
    assert.equal('stack' in body.error, false);
  } finally {
    await app.close();
  }
});
