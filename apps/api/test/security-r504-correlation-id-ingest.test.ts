import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * R5-04 (docs/auditoria-2/api-ronda5.md, MEDIA): la migración 0056 propagó
 * `correlation_id` a `source_runs`/`proposals`/`package_manifests`/`jobs`/
 * `audit_log` para cubrir la cadena "convocatoria -> matriz -> propuesta ->
 * paquete -> archivo", pero `tenders`/`tender_versions` (la CONVOCATORIA en
 * sí, primer eslabón) nunca tuvieron la columna, y el `audit_log` de
 * `POST /internal/tenders/ingest` nunca incluía `correlation_id` aunque
 * `request.correlationId` ya estaba disponible (lo llena el plugin global
 * para cualquier request). El test que "probaba" REQ-171 de punta a punta
 * en realidad creaba la convocatoria SIN `X-Correlation-Id` -- la
 * convocatoria nunca participaba en la traza verificada.
 *
 * Fijado: `correlation_id` nace en `POST /internal/tenders/ingest` (acepta
 * y propaga `X-Correlation-Id`, igual que cualquier otra ruta) y se hereda
 * en `tenders`/`tender_versions` (migración 0060) y en el `audit_log` de
 * ingesta -- ahora `GET /audit-log?correlationId=` reconstruye la traza
 * REAL desde la convocatoria hasta el manifiesto del paquete.
 */
async function createTenderWithCorrelation(app: FastifyInstance, orgId: string, externalId: string, correlationId: string): Promise<{ tenderId: string; versionId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY, 'x-correlation-id': correlationId },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de mensajería R5-04', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  // El plugin global refleja el MISMO correlation_id enviado (ya lo cubre
  // la suite "Comprobado correcto" de la auditoría) -- lo relevante de R5-04
  // es lo que sigue: que también quedó PERSISTIDO en los datos de esta request.
  expect(res.headers['x-correlation-id']).toBe(correlationId);
  return { tenderId: res.json().results[0].tenderId, versionId: res.json().results[0].versionId };
}

describe('R5-04: correlation_id nace en POST /internal/tenders/ingest y se hereda en tenders/tender_versions', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('el correlation_id de la request de ingesta queda persistido en tenders, tender_versions y audit_log (entidad "tenders")', async () => {
    const owner = await registerAndLogin(app, 'r504-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'R504 Org 1', 'r504-org-1');
    const correlationId = '11111111-2222-4333-8444-555555555501';

    const { tenderId, versionId } = await createTenderWithCorrelation(app, org.id, 'r504-001', correlationId);

    const tenderRow = await db.query<{ correlation_id: string | null }>('select correlation_id from tenders where id = $1', [tenderId]);
    expect(tenderRow.rows[0].correlation_id).toBe(correlationId);

    const versionRow = await db.query<{ correlation_id: string | null }>('select correlation_id from tender_versions where id = $1', [versionId]);
    expect(versionRow.rows[0].correlation_id).toBe(correlationId);

    const auditRow = await db.query<{ correlation_id: string | null }>(
      "select correlation_id from audit_log where entity = 'tenders' and entity_id = $1 and action = 'tender.ingest.created'",
      [tenderId]
    );
    expect(auditRow.rows.length).toBe(1);
    expect(auditRow.rows[0].correlation_id).toBe(correlationId);
  });

  it('sin X-Correlation-Id, se genera uno propio y también queda persistido (nunca NULL)', async () => {
    const owner = await registerAndLogin(app, 'r504-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'R504 Org 2', 'r504-org-2');
    const res = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: { records: [{ source: 'compras-mx', externalId: 'r504-002', title: 'x', sourceVersion: 'v1' }], organizationIds: [org.id] },
    });
    expect(res.statusCode).toBe(200);
    const generated = res.headers['x-correlation-id'];
    expect(generated).toBeTruthy();

    const tenderRow = await db.query<{ correlation_id: string | null }>('select correlation_id from tenders where id = $1', [res.json().results[0].tenderId]);
    expect(tenderRow.rows[0].correlation_id).toBe(generated);
  });

  it('una actualización posterior de la MISMA convocatoria hereda el correlation_id de esa nueva ingesta', async () => {
    const owner = await registerAndLogin(app, 'r504-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'R504 Org 3', 'r504-org-3');
    const firstCorrelation = '11111111-2222-4333-8444-555555555503';
    const { tenderId } = await createTenderWithCorrelation(app, org.id, 'r504-003', firstCorrelation);

    const secondCorrelation = '22222222-3333-4444-8555-666666666603';
    const update = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY, 'x-correlation-id': secondCorrelation },
      payload: { records: [{ source: 'compras-mx', externalId: 'r504-003', title: 'Servicio de mensajería R5-04 (actualizado)', sourceVersion: 'v2' }], organizationIds: [org.id] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().results[0].action).toBe('updated');

    const tenderRow = await db.query<{ correlation_id: string | null }>('select correlation_id from tenders where id = $1', [tenderId]);
    expect(tenderRow.rows[0].correlation_id).toBe(secondCorrelation);

    const versionRow = await db.query<{ correlation_id: string | null }>('select correlation_id from tender_versions where id = $1', [update.json().results[0].versionId]);
    expect(versionRow.rows[0].correlation_id).toBe(secondCorrelation);
  });

  it('traza end-to-end REAL: ingesta (con X-Correlation-Id) -> aprobación de tarifa -> checklist -> aprobación de expediente -> manifiesto del paquete, todo reconstruible en GET /audit-log?correlationId= (incluida la entidad "tenders")', async () => {
    const owner = await registerAndLogin(app, 'r504-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'R504 Org 4', 'r504-org-4');
    const correlationId = '33333333-4444-4555-8666-777777777704';
    const { tenderId } = await createTenderWithCorrelation(app, org.id, 'r504-004', correlationId);

    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-correlation-id': correlationId, 'x-step-up': stepUpToken };

    await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Mensajería R5-04 SA de CV', taxId: 'MRB010101AAA' } });
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'envio-r504', description: 'Envío R5-04', unitPrice: 120, validFrom: '2020-01-01' } });
    await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
    const economic = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'envio-r504', quantity: 3 }] },
    });
    expect(economic.statusCode).toBe(200);

    const checklist = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/checklist/run`,
      headers,
      payload: { files: [], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 }, requiredSignatures: [] },
    });
    expect(checklist.json().overallStatus).toBe('verde');

    const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers, payload: { scope: 'expediente', scopeRef: 'expediente' } });
    expect(approve.json().fullyApproved).toBe(true);

    const assemble = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(assemble.statusCode).toBe(200);
    expect(assemble.json().status).toBe('ready');

    const trace = await app.inject({ method: 'GET', url: `/audit-log?correlationId=${correlationId}&limit=100`, headers });
    expect(trace.statusCode).toBe(200);
    const entities = trace.json().items.map((e: { entity: string; correlationId: string | null }) => {
      expect(e.correlationId).toBe(correlationId);
      return e.entity;
    });
    // R5-04: a diferencia de antes, la convocatoria (entidad "tenders") SÍ
    // participa en la traza -- primer eslabón real de la cadena.
    expect(entities).toContain('tenders');
    expect(entities).toContain('approved_rates');
    expect(entities).toContain('proposals');
    expect(entities).toContain('compliance_items');
    expect(entities).toContain('proposal_approvals');
    expect(entities).toContain('package_manifests');
  });
});
