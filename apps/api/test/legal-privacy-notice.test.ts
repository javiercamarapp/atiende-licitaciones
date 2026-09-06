import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';

/**
 * REQ-119/REQ-131: GET /legal/privacy-notice sirve el aviso de privacidad
 * versionado desde apps/api/docs/legal/privacy-notice.md -- pública (sin
 * sesión), marcada como borrador pendiente de validación jurídica, con
 * responsable/autoridad supervisora/ley aplicable citados desde
 * docs/legal/verificacion-legal.md.
 */
describe('GET /legal/privacy-notice', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('responde 200 SIN autenticación, versionado y marcado como borrador pendiente de validación jurídica', async () => {
    const res = await app.inject({ method: 'GET', url: '/legal/privacy-notice' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe(1);
    expect(body.status).toBe('borrador_pendiente_validacion_juridica');
    expect(body.responsible).toContain('Atiende Licitaciones');
    expect(body.supervisoryAuthority).toContain('Secretaría Anticorrupción y Buen Gobierno');
    expect(body.applicableLaw).toContain('LFPDPPP');
    expect(body.sourceDocument).toBe('docs/legal/verificacion-legal.md');
    expect(body.contentMarkdown).toContain('Aviso de privacidad');
    expect(body.contentMarkdown).toContain('Derechos ARCO');
    expect(body.contentMarkdown).toContain('320,000');
  });
});
