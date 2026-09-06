import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';

/**
 * AE-15 (docs/auditoria-2/api-expediente-reverificacion.md, BAJA): el
 * `bodyLimit` por defecto de Fastify (1 MiB) era INCOHERENTE con el límite
 * de subida "~22MB" (base64, `lib/storage.ts` MAX_BASE64_LENGTH) que el
 * README documenta como soportado -- una subida legítima de, digamos,
 * 5-20MB se rechazaba con 413 mucho antes de llegar al chequeo explícito
 * de `decodeBase64Content`. `app.ts` fija ahora un `bodyLimit` real por
 * encima de `MAX_BASE64_LENGTH`.
 */
describe('bodyLimit de Fastify (AE-15)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('un cuerpo de ~5MB (por encima del 1MiB por defecto de Fastify, muy por debajo del límite real) NO se rechaza por bodyLimit', async () => {
    // 5MB de payload -- habría sido rechazado por el bodyLimit POR DEFECTO
    // de Fastify (1 MiB), antes de esta corrección.
    const bigPassword = 'x'.repeat(5 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ae15-nadie@example.com', password: bigPassword },
    });
    // 401 (credenciales inválidas) es la respuesta REAL esperada -- lo
    // importante es que NO sea 413 (rechazado por tamaño de cuerpo).
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).toBe(401);
  });

  it('un cuerpo por ENCIMA del límite real configurado responde 413 explícito', async () => {
    // Un poco más grande que MAX_BASE64_LENGTH (30_000_000) + margen (2MB)
    // configurado en app.ts -- debe rechazarse igual, solo que con un techo
    // mucho más alto y coherente con lo documentado, no con el 1MiB
    // genérico de Fastify.
    const tooBig = 'x'.repeat(33 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ae15-nadie-2@example.com', password: tooBig },
    });
    expect(res.statusCode).toBe(413);
  }, 20_000);
});
