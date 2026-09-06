import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E6 — documentos de bases (bóveda + extracción de texto) y matriz de
 * requisitos real (`RequirementMatrixBuilder`). Cobertura: A6 (conflicto de
 * plazos entre documentos nunca se resuelve en silencio).
 *
 * Los casos que necesitan CONTROLAR con precisión el texto extraído usan
 * `text/plain` (ruta determinista, sin depender de la reconstrucción interna
 * de líneas de un PDF renderizado) -- la extracción real vía `pdfjs-dist`
 * sobre un PDF genuino se prueba aparte en el primer caso de este archivo, en
 * el caso "R6-01/R6-02" de más abajo (fixtures con ambos formatos de
 * referencia cruzada) y en `test/expediente-text-extraction.test.ts`
 * (unitario, incluye "requires_ocr").
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pdf');

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function makePdfWithText(text: string): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = text.match(/.{1,70}(\s|$)/g) ?? [text];
  lines.forEach((line, i) => page.drawText(line.trim(), { x: 20, y: 360 - i * 16, size: 10, font }));
  const bytes = await doc.save();
  return Buffer.from(bytes).toString('base64');
}

async function createTender(app: FastifyInstance, orgId: string, externalId = 'exp-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Servicio de mantenimiento', sourceVersion: 'v1' }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — documentos de bases y matriz de requisitos (E6)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('sube un PDF real con texto, lo extrae vía pdfjs-dist y construye la matriz de requisitos', async () => {
    const owner = await registerAndLogin(app, 'matrix-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Matrix Org 1', 'matrix-org-1');
    const tenderId = await createTender(app, org.id);

    const contentBase64 = await makePdfWithText(
      'El licitante debera presentar la garantia de cumplimiento a mas tardar el 15 de octubre de 2026 a las 14:00 horas. ' +
        'Es obligatorio presentar el Anexo 3 firmado.'
    );

    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases.pdf', mimeType: 'application/pdf', contentBase64 },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');
    expect(upload.json().fileHash).toBeTruthy();

    const build = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/matrix/build`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(build.statusCode).toBe(200);
    expect(build.json().itemsCreated).toBeGreaterThan(0);
    expect(build.json().documentsUsed).toBe(1);

    const matrix = await app.inject({
      method: 'GET',
      url: `/expediente/tenders/${tenderId}/matrix`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(matrix.statusCode).toBe(200);
    const items = matrix.json();
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i: any) => i.invalidatedAt === null)).toBe(true);
    expect(items.some((i: any) => i.sourcePage !== null)).toBe(true);
  });

  it('R6-01/R6-02: un PDF con cross-reference STREAM (fixture xref-stream.pdf, el formato que genera pdf-lib y muchos generadores reales) se extrae correctamente vía la API -- ya NO falla como con pdf-parse@1.1.1', async () => {
    const owner = await registerAndLogin(app, 'matrix-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Matrix Org 5', 'matrix-org-5');
    const tenderId = await createTender(app, org.id, 'exp-005');

    const contentBase64 = readFileSync(path.join(FIXTURES_DIR, 'xref-stream.pdf')).toString('base64');
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases-xref-stream.pdf', mimeType: 'application/pdf', contentBase64 },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');
  });

  it('R6-01/R6-02: un PDF con tabla xref CLÁSICA (fixture xref-classic.pdf) también se extrae correctamente -- soportar xref-stream no rompe el formato anterior', async () => {
    const owner = await registerAndLogin(app, 'matrix-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'Matrix Org 6', 'matrix-org-6');
    const tenderId = await createTender(app, org.id, 'exp-006');

    const contentBase64 = readFileSync(path.join(FIXTURES_DIR, 'xref-classic.pdf')).toString('base64');
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases-xref-classic.pdf', mimeType: 'application/pdf', contentBase64 },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');
  });

  it('un documento de formato no soportado (ni PDF ni texto reconocible) queda "failed" explícito, nunca texto vacío en silencio', async () => {
    const owner = await registerAndLogin(app, 'matrix-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Matrix Org 2', 'matrix-org-2');
    const tenderId = await createTender(app, org.id, 'exp-002');

    const garbageBinary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xd8, 0xff, 0xe0]).toString('base64');
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'anexo', filename: 'imagen.png', mimeType: 'image/png', contentBase64: garbageBinary },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('failed');

    const build = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/matrix/build`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(build.statusCode).toBe(200);
    expect(build.json().documentsUsed).toBe(0);
    expect(build.json().documentsSkipped[0].reason).toContain('failed');
  });

  it('viewer no puede subir documentos ni editar la matriz; writer sí puede editar responsable/estado', async () => {
    const owner = await registerAndLogin(app, 'matrix-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Matrix Org 3', 'matrix-org-3');
    const tenderId = await createTender(app, org.id, 'exp-003');
    const viewer = await registerAndLogin(app, 'matrix-viewer-3@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);
    const writer = await registerAndLogin(app, 'matrix-writer-3@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);

    const contentBase64 = toBase64('Es obligatorio presentar el Anexo 1 firmado a mas tardar el 01 de enero de 2027.');
    const viewerUpload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases.txt', mimeType: 'text/plain', contentBase64 },
    });
    expect(viewerUpload.statusCode).toBe(403);

    const writerUpload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases.txt', mimeType: 'text/plain', contentBase64 },
    });
    expect(writerUpload.statusCode).toBe(201);
    expect(writerUpload.json().textExtractionStatus).toBe('extracted');

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/matrix/build`, headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id } });
    const matrix = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/matrix`, headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id } });
    expect(matrix.json().length).toBeGreaterThan(0);
    const itemId = matrix.json()[0].id;

    const viewerPatch = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/matrix/${itemId}`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { matrixStatus: 'en_progreso' },
    });
    expect(viewerPatch.statusCode).toBe(403);

    const writerPatch = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/matrix/${itemId}`,
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
      payload: { matrixStatus: 'en_progreso', assignedTo: writer.id },
    });
    expect(writerPatch.statusCode).toBe(200);
    expect(writerPatch.json().matrixStatus).toBe('en_progreso');
    expect(writerPatch.json().assignedTo).toBe(writer.id);
  });

  it('A6: dos versiones de bases con plazos distintos para el mismo tema generan un conflicto escalado, y la matriz vieja queda invalidada preservando historial', async () => {
    const owner = await registerAndLogin(app, 'matrix-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Matrix Org 4', 'matrix-org-4');
    const tenderId = await createTender(app, org.id, 'exp-004');

    const doc1 = toBase64('La entrega de proposiciones sera a mas tardar el 10 de octubre de 2026 a las 10:00 horas.');
    const upload1 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases-v1.txt', mimeType: 'text/plain', contentBase64: doc1 },
    });
    expect(upload1.statusCode).toBe(201);

    const build1 = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/matrix/build`, headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id } });
    expect(build1.json().itemsCreated).toBeGreaterThan(0);

    // Segunda versión de bases con un plazo DISTINTO para el mismo tema:
    // dispara tender_change_events -> invalidación automática (trigger 0022).
    const doc2 = toBase64('La entrega de proposiciones sera a mas tardar el 20 de octubre de 2026 a las 10:00 horas.');
    const upload2 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases-v2.txt', mimeType: 'text/plain', contentBase64: doc2 },
    });
    expect(upload2.statusCode).toBe(201);

    // Las filas de la primera generación ya deben estar invalidadas (por el
    // trigger, disparado al insertar tender_change_events en el upload2).
    const afterUpload2 = await app.inject({
      method: 'GET',
      url: `/expediente/tenders/${tenderId}/matrix?includeHistory=true`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(afterUpload2.json().some((i: any) => i.invalidatedAt !== null)).toBe(true);

    const build2 = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/matrix/build`, headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id } });
    expect(build2.statusCode).toBe(200);
    expect(build2.json().documentsUsed).toBe(2);
    expect(build2.json().conflictsCreated).toBeGreaterThan(0);

    const conflicts = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/conflicts`, headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id } });
    expect(conflicts.statusCode).toBe(200);
    expect(conflicts.json().length).toBeGreaterThan(0);
    expect(conflicts.json()[0].kind).toBe('deadline_mismatch');
    expect(conflicts.json()[0].status).toBe('escalado');

    const resolve = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/conflicts/${conflicts.json()[0].id}/resolve`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { resolutionNotes: 'Se confirmó con el área compradora la fecha correcta: 20 de octubre.' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().status).toBe('resuelto');

    // Historial preservado: la matriz completa (con historial) sigue
    // conteniendo las filas de la primera generación, ahora invalidadas.
    const fullHistory = await app.inject({
      method: 'GET',
      url: `/expediente/tenders/${tenderId}/matrix?includeHistory=true`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    const invalidatedCount = fullHistory.json().filter((i: any) => i.invalidatedAt !== null).length;
    const currentCount = fullHistory.json().filter((i: any) => i.invalidatedAt === null).length;
    expect(invalidatedCount).toBeGreaterThan(0);
    expect(currentCount).toBeGreaterThan(0);
  });
});
