import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-04 (docs/auditoria-2/api-expediente.md, MEDIA): un documento cuyo
 * contenido extraído contenía HTML/`<script>` sin ningún indicio de ser
 * PDF pasaba la heurística `looksLikePlainText`, quedaba "extracted", y se
 * persistía/devolvía TAL CUAL (sin escapar) en `description`/`sourceExcerpt`
 * de `GET /tenders/:id/matrix` -- vector de XSS almacenado para cualquier
 * frontend que renderizara esos campos sin escapar.
 *
 * Fijado: `text-extraction.ts` (`sanitizePlainText`) elimina el contenido
 * de `<script>`/`<style>` por completo y quita cualquier otra etiqueta
 * HTML antes de persistir -- el texto guardado en `extracted_text` (y por
 * tanto lo que alimenta la matriz de requisitos) nunca contiene HTML
 * ejecutable.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'AE-04', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('AE-04: el texto extraído se sanitiza (sin HTML/script) antes de persistir', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un documento de texto plano con <script> embebido se persiste SIN el script (sanitizado)', async () => {
    const owner = await registerAndLogin(app, 'ae04-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE04 Org 1', 'ae04-org-1');
    const tenderId = await createTender(app, org.id, 'ae04-001');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const malicious = 'Es obligatorio presentar la garantía. <script>alert(document.cookie)</script> Fin del requisito.';
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers,
      payload: { documentKind: 'bases', filename: 'bases.txt', mimeType: 'text/plain', contentBase64: Buffer.from(malicious, 'utf8').toString('base64') },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');

    const { rows } = await db.query<{ extracted_text: string }>('select extracted_text from tender_documents where id = $1', [upload.json().id]);
    expect(rows[0].extracted_text).not.toMatch(/<script/i);
    expect(rows[0].extracted_text).not.toMatch(/alert\(document\.cookie\)/); // el contenido del <script> se ELIMINA, no solo la etiqueta.
    expect(rows[0].extracted_text).toContain('Es obligatorio presentar la garantía.');
    expect(rows[0].extracted_text).toContain('Fin del requisito.');

    // El texto sanitizado alimenta la matriz de requisitos -- confirmar
    // que tampoco llega HTML ejecutable hasta ahí.
    const build = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/matrix/build`, headers });
    expect(build.statusCode).toBe(200);
    const matrix = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/matrix`, headers });
    expect(matrix.statusCode).toBe(200);
    expect(JSON.stringify(matrix.json())).not.toMatch(/<script/i);
  });

  it('un documento que es ÍNTEGRAMENTE HTML/script queda "failed" (nunca "extracted" con texto vacío)', async () => {
    const owner = await registerAndLogin(app, 'ae04-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'AE04 Org 2', 'ae04-org-2');
    const tenderId = await createTender(app, org.id, 'ae04-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const onlyScript = '<script>alert(1)</script>';
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers,
      payload: { documentKind: 'bases', filename: 'bases.txt', mimeType: 'text/plain', contentBase64: Buffer.from(onlyScript, 'utf8').toString('base64') },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('failed');
  });
});
