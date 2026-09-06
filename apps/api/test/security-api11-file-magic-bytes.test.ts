import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * API-11 (docs/auditoria-1/db-api-reverificacion.md, MEDIA; REQ-024 lado
 * API) — `apps/api/src/lib/storage.ts` no validaba tipo/magic bytes:
 * cualquier binario podía subirse como `company_documents.documentType`
 * arbitrario. `storeFile` ahora rechaza (422) ejecutables y llaves/
 * certificados en bruto (PEM o DER) ANTES de escribir a disco, sin
 * importar qué `documentType` se haya declarado.
 */
describe('API-11 — subida de documentos rechaza ejecutables y llaves/certificados por magic bytes', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un ejecutable PE (MZ) se rechaza con 422, sin escribir ningún archivo', async () => {
    const owner = await registerAndLogin(app, 'api11-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'API11 Org 1', 'api11-org-1');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const peBinary = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const res = await app.inject({
      method: 'POST',
      url: '/company/documents',
      headers,
      payload: { documentType: 'acta_constitutiva', contentBase64: peBinary.toString('base64') },
    });
    expect(res.statusCode).toBe(422);

    const rows = await db.query('select count(*)::int as count from company_documents where org_id = $1', [org.id]);
    expect(rows.rows[0].count).toBe(0);
  });

  it('una llave privada PEM se rechaza con 422', async () => {
    const owner = await registerAndLogin(app, 'api11-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'API11 Org 2', 'api11-org-2');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n';
    const res = await app.inject({
      method: 'POST',
      url: '/company/documents',
      headers,
      payload: { documentType: 'opinion_32d', contentBase64: Buffer.from(pem).toString('base64') },
    });
    expect(res.statusCode).toBe(422);
  });

  it('un certificado DER en bruto (.cer binario) se rechaza con 422', async () => {
    const owner = await registerAndLogin(app, 'api11-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'API11 Org 3', 'api11-org-3');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // Prefijo ASN.1 SEQUENCE (0x30 0x82) típico de X.509 DER.
    const der = Buffer.from([0x30, 0x82, 0x02, 0x50, 0x30, 0x82, 0x01, 0x38, 0xa0, 0x03, 0x02, 0x01]);
    const res = await app.inject({
      method: 'POST',
      url: '/company/documents',
      headers,
      payload: { documentType: 'acta_constitutiva', contentBase64: der.toString('base64') },
    });
    expect(res.statusCode).toBe(422);
  });

  it('un documento legítimo (texto plano) se sigue aceptando sin falsos positivos', async () => {
    const owner = await registerAndLogin(app, 'api11-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'API11 Org 4', 'api11-org-4');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const res = await app.inject({
      method: 'POST',
      url: '/company/documents',
      headers,
      payload: { documentType: 'opinion_32d', contentBase64: Buffer.from('Contenido real de un documento de negocio.').toString('base64') },
    });
    expect(res.statusCode).toBe(201);
  });
});
