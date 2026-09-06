import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-03 (docs/auditoria-2/api-expediente.md, MEDIA; extiende API-11):
 * `assertSafeFileContent` solo comparaba las firmas peligrosas contra el
 * OFFSET 0 del buffer -- trivialmente evadible con padding al inicio, o
 * incrustando la firma peligrosa en medio/al final de un archivo que por
 * lo demás parece legítimo (polígloto). AE-05 (BAJA-MEDIA): ningún formato
 * comprimido genérico (ZIP) estaba en la lista negra, así que un ZIP
 * (vector de zip-bomb) se aceptaba igual que cualquier documento.
 *
 * Fijado: `lib/storage.ts` busca cada firma peligrosa (ejecutables, PEM,
 * ZIP) en TODO el buffer, y valida que un archivo que se presenta como PDF
 * (`%PDF-` en los primeros 1024 bytes) también contenga `%%EOF`.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'AE-03/AE-05', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

async function uploadDocument(app: FastifyInstance, tenderId: string, headers: Record<string, string>, buffer: Buffer, filename = 'doc.bin') {
  return app.inject({
    method: 'POST',
    url: `/expediente/tenders/${tenderId}/documents`,
    headers,
    payload: { documentKind: 'anexo', filename, contentBase64: buffer.toString('base64') },
  });
}

describe('AE-03/AE-05: magic bytes en todo el buffer + rechazo de ZIP (anti zip-bomb)', () => {
  let app: FastifyInstance;
  let db: DbClient;
  let headers: Record<string, string>;
  let tenderId: string;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
    const owner = await registerAndLogin(app, 'ae03-owner@example.com');
    const org = await createOrgFor(app, owner, 'AE03 Org', 'ae03-org');
    tenderId = await createTender(app, org.id, 'ae03-001');
    headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('rechaza un ejecutable MZ precedido de padding cero (firma NO en offset 0)', async () => {
    const padded = Buffer.concat([Buffer.alloc(64, 0), Buffer.from([0x4d, 0x5a]), Buffer.from('resto del ejecutable falso')]);
    const res = await uploadDocument(app, tenderId, headers, padded);
    expect(res.statusCode).toBe(422);
  });

  it('rechaza un PDF válido con un stub MZ completo anexado AL FINAL (polígloto)', async () => {
    const pdfLike = Buffer.from(`%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n`, 'latin1');
    const mzStub = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    const polyglot = Buffer.concat([pdfLike, mzStub]);
    const res = await uploadDocument(app, tenderId, headers, polyglot);
    expect(res.statusCode).toBe(422);
  });

  it('rechaza un PDF válido con la firma MZ incrustada EN MEDIO del contenido', async () => {
    const head = Buffer.from('%PDF-1.4\n', 'latin1');
    const mzStub = Buffer.from([0x4d, 0x5a]);
    const tail = Buffer.from('contenido de relleno %%EOF\n', 'latin1');
    const polyglot = Buffer.concat([head, Buffer.alloc(32, 0x20), mzStub, Buffer.alloc(32, 0x20), tail]);
    const res = await uploadDocument(app, tenderId, headers, polyglot);
    expect(res.statusCode).toBe(422);
  });

  it('rechaza un archivo que declara ser PDF (%PDF- en el header) pero NO contiene %%EOF', async () => {
    const truncated = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n(sin marcador de fin)', 'latin1');
    const res = await uploadDocument(app, tenderId, headers, truncated);
    expect(res.statusCode).toBe(422);
  });

  it('rechaza un ZIP genérico (magic bytes PK\\x03\\x04) como documento -- protección anti zip-bomb', async () => {
    const zipLike = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const res = await uploadDocument(app, tenderId, headers, zipLike);
    expect(res.statusCode).toBe(422);
  });

  it('sigue aceptando un PDF real y completo (%PDF-...%%EOF) sin falsos positivos', async () => {
    const realPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
    const res = await uploadDocument(app, tenderId, headers, realPdf, 'bases.pdf');
    expect(res.statusCode).toBe(201);
  });

  it('sigue aceptando texto plano legítimo sin falsos positivos', async () => {
    const plain = Buffer.from('Este es un documento de bases perfectamente legítimo, en texto plano.', 'utf8');
    const res = await uploadDocument(app, tenderId, headers, plain, 'bases.txt');
    expect(res.statusCode).toBe(201);
  });
});
