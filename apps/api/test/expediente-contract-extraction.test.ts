import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-052 — extracción del contrato firmado: el usuario SUBE el contrato
 * (declarativo, el sistema nunca firma); extracción de texto con el mismo
 * motor que bases (sin OCR -> requires_ocr); campos detectados con
 * página/cláusula/confianza; el usuario confirma o corrige -- nunca se dan
 * por válidos sin confirmación.
 */

const SIGNED_CONTRACT_TEXT = `
CONTRATO NÚMERO: ADM-2026-0042

CLÁUSULA PRIMERA. OBJETO.
El presente instrumento tiene por objeto el suministro de equipo de cómputo.

CLÁUSULA SEGUNDA. MONTO.
Monto total: $1,250,000.00 (un millón doscientos cincuenta mil pesos 00/100 M.N.)

CLÁUSULA TERCERA. PLAZO DE ENTREGA.
Plazo de entrega: 45 días naturales contados a partir de la firma del presente contrato.

CLÁUSULA CUARTA. GARANTÍAS.
Garantía de cumplimiento: fianza equivalente al 10% del monto total del contrato.

CLÁUSULA QUINTA. PENAS CONVENCIONALES.
Pena convencional: 0.5% del valor de los bienes no entregados oportunamente por cada día de atraso.

CLÁUSULA SEXTA. FORMA DE PAGO.
Forma de pago: transferencia electrónica dentro de los 17 días hábiles siguientes a la entrega.

CLÁUSULA SÉPTIMA. ADMINISTRADOR DEL CONTRATO.
El administrador del contrato será el Lic. Juan Pérez, Director de Recursos Materiales.
`;

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function createTender(app: FastifyInstance, orgId: string, externalId = 'c052-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Suministro de equipo', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — extracción del contrato firmado (REQ-052)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('sube el contrato firmado (texto plano), extrae campos como "sugerido" y el usuario los confirma/corrige explícitamente', async () => {
    const owner = await registerAndLogin(app, 'c052-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'C052 Org 1', 'c052-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/documents`,
      headers,
      payload: { filename: 'contrato-firmado.txt', mimeType: 'text/plain', contentBase64: toBase64(SIGNED_CONTRACT_TEXT) },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');
    const documentId = upload.json().id;

    const fields = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract/documents/${documentId}/fields`, headers });
    expect(fields.statusCode).toBe(200);
    const fieldRows: any[] = fields.json();
    expect(fieldRows.length).toBeGreaterThan(0);
    // REQ-052: ningún campo se da por válido sin confirmación -- todos entran "sugerido".
    for (const f of fieldRows) {
      expect(f.status).toBe('sugerido');
      expect(f.confidence).toBeGreaterThan(0);
    }

    const numeroContrato = fieldRows.find((f) => f.fieldKey === 'numero_contrato');
    expect(numeroContrato).toBeTruthy();
    expect(numeroContrato.extractedValue).toContain('ADM-2026-0042');

    const montoTotal = fieldRows.find((f) => f.fieldKey === 'monto_total');
    expect(montoTotal).toBeTruthy();
    expect(montoTotal.extractedValue).toContain('1,250,000.00');

    const penaConvencional = fieldRows.find((f) => f.fieldKey === 'pena_convencional');
    expect(penaConvencional).toBeTruthy();
    expect(penaConvencional.sourceClause).toContain('QUINTA');

    // Confirmar un campo tal cual se detectó.
    const confirm = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/fields/${numeroContrato.id}/confirm`,
      headers,
      payload: { action: 'confirm' },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('confirmado');
    expect(confirm.json().confirmedValue).toBe(numeroContrato.extractedValue);
    expect(confirm.json().confirmedBy).toBe(owner.id);

    // Corregir otro campo (el usuario detecta un error del extractor).
    const correct = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/fields/${montoTotal.id}/confirm`,
      headers,
      payload: { action: 'correct', correctedValue: '$1,300,000.00 (corregido por el usuario)' },
    });
    expect(correct.statusCode).toBe(200);
    expect(correct.json().status).toBe('corregido');
    expect(correct.json().confirmedValue).toBe('$1,300,000.00 (corregido por el usuario)');

    // action='correct' sin correctedValue -> 422.
    const missingCorrection = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/fields/${montoTotal.id}/confirm`,
      headers,
      payload: { action: 'correct' },
    });
    expect(missingCorrection.statusCode).toBe(422);
  });

  it('un documento sin contenido reconocible (ni PDF con texto ni texto plano) queda "failed" y no genera campos', async () => {
    const owner = await registerAndLogin(app, 'c052-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'C052 Org 2', 'c052-org-2');
    const tenderId = await createTender(app, org.id, 'c052-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const binaryGarbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x10, 0x20, 0x30, 0x40]).toString('base64');
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/documents`,
      headers,
      payload: { filename: 'contrato-ilegible.bin', contentBase64: binaryGarbage },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('failed');

    const fields = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract/documents/${upload.json().id}/fields`, headers });
    expect(fields.json()).toEqual([]);
  });

  it('subir el contrato sin haber registrado antes el contrato (POST /contract) responde 404', async () => {
    const owner = await registerAndLogin(app, 'c052-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'C052 Org 3', 'c052-org-3');
    const tenderId = await createTender(app, org.id, 'c052-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/documents`,
      headers,
      payload: { filename: 'contrato.txt', mimeType: 'text/plain', contentBase64: toBase64('texto irrelevante') },
    });
    expect(upload.statusCode).toBe(404);
  });

  it('viewer no puede subir el contrato ni confirmar campos', async () => {
    const owner = await registerAndLogin(app, 'c052-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'C052 Org 4', 'c052-org-4');
    const tenderId = await createTender(app, org.id, 'c052-004');
    const viewer = await registerAndLogin(app, 'c052-viewer-4@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id } });

    const viewerHeaders = { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id };
    const attempt = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/documents`,
      headers: viewerHeaders,
      payload: { filename: 'contrato.txt', mimeType: 'text/plain', contentBase64: toBase64(SIGNED_CONTRACT_TEXT) },
    });
    expect(attempt.statusCode).toBe(403);
  });
});
