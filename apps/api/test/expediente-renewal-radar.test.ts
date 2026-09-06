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

  it('R6-03: 5,000 contratos (15,000 alertas candidatas) escanean en <2s en PGlite -- sin N+1, en lote y paginado por cursor', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 6', 'c055-org-6');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // Siembra directa (bulk, una sola sentencia con dos CTE encadenados) --
    // 5,000 convocatorias repartidas en 50 `contracting_body` distintos
    // (para ejercitar de verdad el agrupamiento de convocatorias históricas
    // en lote) + 5,000 contratos, todos con `end_date` a 20 días -- cruza
    // los 3 umbrales por defecto (90/60/30) => 15,000 alertas candidatas,
    // igual que la medición original de la auditoría (R6-03).
    await db.query(
      `with new_tenders as (
         insert into tenders (org_id, source, external_id, title, contracting_body, published_at)
         select $1, 'perf-test', 'perf-' || gs, 'Contrato de prueba ' || gs, 'Entidad ' || (gs % 50), now() - (gs || ' days')::interval
           from generate_series(1, 5000) as gs
         returning id
       )
       insert into contracts (org_id, tender_id, status, end_date)
       select $1, id, 'adjudicado', current_date + 20
         from new_tenders`,
      [org.id]
    );

    const startedAt = Date.now();
    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    const elapsedMs = Date.now() - startedAt;
    console.log(`R6-03 perf: 5000 contratos, primer escaneo=${elapsedMs}ms`);

    expect(scan.statusCode).toBe(200);
    expect(scan.json().evaluatedContracts).toBe(5000);
    expect(scan.json().alertsCreated).toBe(15000);
    expect(scan.json().truncated).toBe(false);
    expect(scan.json().nextCursor).toBeNull();
    expect(elapsedMs).toBeLessThan(2000);

    // Segundo escaneo (dedupe en lote, no una consulta por alerta): también
    // debe ser rápido y no duplicar ninguna alerta.
    const startedAt2 = Date.now();
    const secondScan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    const elapsedMs2 = Date.now() - startedAt2;
    console.log(`R6-03 perf: 5000 contratos, segundo escaneo (dedupe)=${elapsedMs2}ms`);
    expect(secondScan.json().alertsCreated).toBe(0);
    expect(elapsedMs2).toBeLessThan(2000);

    const totalAlerts = await db.query<{ count: string }>('select count(*)::text as count from renewal_alerts where org_id = $1', [org.id]);
    expect(Number(totalAlerts.rows[0].count)).toBe(15000);
  }, 20_000);

  it('R6-03: paginación por cursor -- un pageSize pequeño produce varias páginas y `nextCursor` retoma exactamente donde se quedó, sin perder ni duplicar contratos', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 7', 'c055-org-7');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await db.query(
      `with new_tenders as (
         insert into tenders (org_id, source, external_id, title, contracting_body, published_at)
         select $1, 'perf-test', 'perf-' || gs, 'Contrato de prueba ' || gs, 'Entidad ' || gs, now()
           from generate_series(1, 25) as gs
         returning id
       )
       insert into contracts (org_id, tender_id, status, end_date)
       select $1, id, 'adjudicado', current_date + 20
         from new_tenders`,
      [org.id]
    );

    // pageSize=10 sobre 25 contratos, con un `maxDurationMs` mínimo (1ms)
    // para forzar `truncated:true` tras CADA página que no sea la última
    // (la última página, con menos filas que pageSize, siempre completa
    // sin importar el límite de tiempo -- ver `scanContractsPage`): 3
    // llamadas (10 + 10 + 5 contratos), cada una retomando exactamente
    // donde se quedó la anterior vía `nextCursor`, sin perder ni duplicar
    // ningún contrato.
    let cursor: string | null = null;
    let totalEvaluated = 0;
    let totalAlerts = 0;
    let iterations = 0;
    let lastTruncated = true;
    do {
      const scanCursor: string | null = cursor;
      const scan: Awaited<ReturnType<FastifyInstance['inject']>> = await app.inject({
        method: 'POST',
        url: '/expediente/renewals/scan',
        headers,
        payload: { pageSize: 10, maxDurationMs: 1, cursor: scanCursor },
      });
      expect(scan.statusCode).toBe(200);
      totalEvaluated += scan.json().evaluatedContracts;
      totalAlerts += scan.json().alertsCreated;
      cursor = scan.json().nextCursor;
      lastTruncated = scan.json().truncated;
      iterations += 1;
    } while (cursor !== null && iterations < 10);

    expect(iterations).toBe(3); // 25 contratos / pageSize 10 -> 3 páginas.
    expect(lastTruncated).toBe(false); // la última llamada SÍ termina (nextCursor null).
    expect(totalEvaluated).toBe(25);
    expect(totalAlerts).toBe(75); // 25 contratos x 3 umbrales (90/60/30, todos cruzados a 20 días).

    const distinctAlerts = await db.query<{ count: string }>('select count(*)::text as count from renewal_alerts where org_id = $1', [org.id]);
    expect(Number(distinctAlerts.rows[0].count)).toBe(75); // sin duplicados entre páginas.
  });

  it('R6-03: POST /renewals/scan/enqueue encola un job renewal_radar_scan (opción de ejecutarlo en segundo plano) en vez de escanear de forma síncrona', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-8@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 8', 'c055-org-8');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const enqueue = await app.inject({ method: 'POST', url: '/expediente/renewals/scan/enqueue', headers, payload: { leadDaysThresholds: [45] } });
    expect(enqueue.statusCode).toBe(202);
    expect(enqueue.json().status).toBe('queued');
    const jobId = enqueue.json().jobId;

    const job = await db.query<{ kind: string; status: string; payload: any }>('select kind, status, payload from jobs where id = $1', [jobId]);
    expect(job.rows[0].kind).toBe('renewal_radar_scan');
    expect(job.rows[0].status).toBe('queued');
    expect(job.rows[0].payload.leadDaysThresholds).toEqual([45]);
    expect(job.rows[0].payload.progress).toEqual({ cursor: null, evaluatedContracts: 0, alertsCreated: 0, done: false });

    // No genera NINGUNA alerta todavía -- encolar no es lo mismo que
    // escanear (sin consumidor de este `kind` en apps/worker en esta
    // ronda, ver docstring del módulo).
    const alertsCount = await db.query<{ count: string }>('select count(*)::text as count from renewal_alerts where org_id = $1', [org.id]);
    expect(Number(alertsCount.rows[0].count)).toBe(0);
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

    const enqueueAttempt = await app.inject({
      method: 'POST',
      url: '/expediente/renewals/scan/enqueue',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: {},
    });
    expect(enqueueAttempt.statusCode).toBe(403);
  });
});
