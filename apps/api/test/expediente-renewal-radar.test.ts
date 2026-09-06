import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-055 — radar de renovaciones: a partir de contratos con fecha de fin y
 * de convocatorias históricas de la misma entidad, genera alertas de
 * renovación probable con antelación configurable; jobs en `jobs`, sin
 * envío externo.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string, contractingEntity = 'Secretaría de Ejemplo'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: `Convocatoria ${externalId}`, contractingEntity, sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe('expediente — radar de renovaciones (REQ-055)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('genera una alerta cuando un contrato entra dentro del umbral de antelación configurado, encola un job, y no la duplica en un segundo escaneo', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 1', 'c055-org-1');
    const tenderId = await createTender(app, org.id, 'c055-001');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 45); // ya cruzó los umbrales de 60 y 90 (retroactivo, primer escaneo); el de 30 todavía no.
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: toDateOnly(soon) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().evaluatedContracts).toBe(1);
    expect(scan.json().alertsCreated).toBe(2); // umbrales 60 y 90 cumplidos; 30 todavía no (45 > 30).

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    expect(alerts.statusCode).toBe(200);
    const alertRows = alerts.json();
    expect(alertRows.map((a: any) => a.leadDays).sort((a: number, b: number) => a - b)).toEqual([60, 90]);
    for (const a of alertRows) {
      expect(a.sourceKind).toBe('contract_end_date');
      expect(a.jobId).toBeTruthy();
    }

    const jobs = await db.query("select kind, status from jobs where org_id = $1 and kind = 'renewal_radar_alert'", [org.id]);
    expect(jobs.rows.length).toBe(alertRows.length);

    // Segundo escaneo: mismos umbrales ya cumplidos -> no duplica alertas.
    const secondScan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(secondScan.json().alertsCreated).toBe(0);
    const alertsAfter = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    expect(alertsAfter.json().length).toBe(alertRows.length);
  });

  it('90/60/30: un contrato a 20 días de vencer cruza los tres umbrales por defecto en un solo escaneo', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 2', 'c055-org-2');
    const tenderId = await createTender(app, org.id, 'c055-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 20);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: toDateOnly(soon) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(scan.json().alertsCreated).toBe(3);

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    const leadDays = alerts.json().map((a: any) => a.leadDays).sort((a: number, b: number) => a - b);
    expect(leadDays).toEqual([30, 60, 90]);
  });

  it('enriquece la alerta con convocatorias históricas de la misma entidad cuando existen', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 3', 'c055-org-3');
    await createTender(app, org.id, 'c055-hist-1', 'Secretaría Compartida');
    const currentTenderId = await createTender(app, org.id, 'c055-003', 'Secretaría Compartida');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${currentTenderId}/contract`, headers });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 10);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${currentTenderId}/contract`, headers, payload: { endDate: toDateOnly(soon) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: { leadDaysThresholds: [30] } });
    expect(scan.json().alertsCreated).toBe(1);

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    const alert = alerts.json()[0];
    expect(alert.notes).toContain('Convocatoria c055-hist-1');
  });

  it('un contrato ya vencido no genera alerta (fuera de alcance del radar de "próxima" renovación)', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 4', 'c055-org-4');
    const tenderId = await createTender(app, org.id, 'c055-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 5);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: toDateOnly(past) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(scan.json().alertsCreated).toBe(0);
  });

  it('viewer no puede iniciar un escaneo de renovaciones', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 5', 'c055-org-5');
    const viewer = await registerAndLogin(app, 'c055-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const attempt = await app.inject({
      method: 'POST',
      url: '/expediente/renewals/scan',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: {},
    });
    expect(attempt.statusCode).toBe(403);
  });
});
