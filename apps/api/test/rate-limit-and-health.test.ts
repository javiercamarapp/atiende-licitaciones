import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';

describe('rate limit', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('POST /auth/login devuelve 429 tras superar el límite por ruta (5/min)', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nadie@example.com', password: 'x' },
      });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await attempt());
    }

    const statuses = results.map((r) => r.statusCode);
    // Las primeras 5 son 401 (credenciales inválidas), la 6ª debe ser 429.
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe('salud (healthz/readyz)', () => {
  it('GET /healthz siempre responde 200 sin tocar la base de datos', async () => {
    const { app, db } = await createTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('GET /readyz responde 200 con la base de datos disponible', async () => {
    const { app, db } = await createTestApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('GET /readyz responde 503 si la base de datos no está disponible', async () => {
    const { app, db } = await createTestApp();
    await db.close();
    try {
      const res = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe('error');
    } finally {
      await app.close();
    }
  });
});
