import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E8 — REQ-040: checklist de "sala de guerra" (`WarRoomChecklist`,
 * `@atiende/expediente`) persistido en `war_room_checklist_runs`
 * (migración 0099). Cobertura: las 4 dimensiones (anti-desechamiento,
 * cuenta regresiva, hash del ZIP, holgura obligatoria de 24h), el caso
 * negativo de expediente incompleto, el caso negativo de holgura
 * insuficiente pese a un expediente completo, y el control de rol en
 * `/war-room/run`.
 *
 * Todas las fechas límite se calculan relativas a `Date.now()` en tiempo de
 * ejecución (nunca una fecha absoluta hardcodeada cercana a "hoy") para que
 * la suite no se pudra con el paso del tiempo (mismo criterio que el
 * barrido de "date-rot" ya aplicado al resto de la suite de este repo).
 */

function isoHoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

async function createTender(app: FastifyInstance, orgId: string, externalId: string, submissionDeadline: string | null): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [
        {
          source: 'compras-mx',
          externalId,
          title: 'Servicio de vigilancia',
          sourceVersion: 'v1',
          ...(submissionDeadline ? { submissionDeadline } : {}),
        },
      ],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

/** Arma un expediente REALMENTE "ready" (checklist verde + aprobación vigente + paquete ensamblado sin faltantes), igual que A13 de expediente-package-and-submission.test.ts, para una convocatoria con la fecha límite que le pasen. */
async function buildReadyExpediente(app: FastifyInstance, orgId: string, ownerToken: string, tenderId: string): Promise<void> {
  const { backupCodes } = await enrollTwoFactorFull(app, ownerToken, { orgId, purpose: 'company.rate_approval' });
  const rateStepUp = await stepUpWithBackupCode(app, ownerToken, backupCodes[0], { orgId, purpose: 'company.rate_approval' });
  const expedienteStepUp = await stepUpWithBackupCode(app, ownerToken, backupCodes[1], { orgId, purpose: 'expediente.approval' });
  const headers = { authorization: `Bearer ${ownerToken}`, 'x-org-id': orgId };

  await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Vigilancia Total SA de CV', taxId: 'VTA010101AAA' } });
  const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'ronda-nocturna', description: 'Ronda nocturna', unitPrice: 300, validFrom: '2020-01-01' } });
  await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers: { ...headers, 'x-step-up': rateStepUp } });

  await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
  const economic = await app.inject({
    method: 'POST',
    url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
    headers,
    payload: { lineItems: [{ concept: 'ronda-nocturna', quantity: 10 }] },
  });
  expect(economic.json().economicTotals).not.toBeNull();

  const checklist = await app.inject({
    method: 'POST',
    url: `/expediente/tenders/${tenderId}/checklist/run`,
    headers,
    payload: { files: [], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 }, requiredSignatures: [] },
  });
  expect(checklist.json().overallStatus).toBe('verde');

  const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers: { ...headers, 'x-step-up': expedienteStepUp }, payload: { scope: 'expediente', scopeRef: 'expediente' } });
  expect(approve.json().fullyApproved).toBe(true);

  const assemble = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
  expect(assemble.statusCode).toBe(200);
  expect(assemble.json().status).toBe('ready');
}

describe('expediente — checklist de "sala de guerra" (REQ-040)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('GET antes de correr ningún checklist responde 404', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-404@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 404', 'wr-org-404');
    const tenderId = await createTender(app, org.id, 'wr-404', isoHoursFromNow(72));
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const get = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/war-room`, headers });
    expect(get.statusCode).toBe(404);
  });

  it('expediente incompleto (sin checklist ni paquete ensamblado): anti-desechamiento y hash del ZIP quedan rojos aunque haya tiempo de sobra', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 1', 'wr-org-1');
    const tenderId = await createTender(app, org.id, 'wr-001', isoHoursFromNow(72));
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const run = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.overallStatus).toBe('rojo');

    const byDim = Object.fromEntries(body.items.map((i: any) => [i.dimension, i]));
    expect(byDim.checklist_anti_desechamiento.status).toBe('rojo');
    expect(byDim.checklist_anti_desechamiento.detail).toContain('nunca se ha ejecutado');
    expect(byDim.hash_zip.status).toBe('rojo');
    expect(byDim.hash_zip.detail).toContain('Nunca se ha ensamblado');
    // Con 72h por delante, estas dos SÍ deberían ir verdes -- confirma que
    // las 4 dimensiones son independientes entre sí.
    expect(byDim.cuenta_regresiva.status).toBe('verde');
    expect(byDim.holgura_24h.status).toBe('verde');
    expect(body.hoursUntilDeadline).toBeGreaterThan(70);

    const persisted = await db.query('select overall_status from war_room_checklist_runs where org_id = $1', [org.id]);
    expect(persisted.rows.length).toBe(1);
    expect((persisted.rows[0] as any).overall_status).toBe('rojo');

    const get = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/war-room`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().overallStatus).toBe('rojo');
  });

  it('expediente completo + holgura sobrada (72h): las 4 dimensiones quedan verdes, incluido el hash del ZIP real en disco', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 2', 'wr-org-2');
    const tenderId = await createTender(app, org.id, 'wr-002', isoHoursFromNow(72));
    await buildReadyExpediente(app, org.id, owner.accessToken, tenderId);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const run = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.overallStatus).toBe('verde');
    for (const item of body.items) expect(item.status).toBe('verde');
    expect(body.hoursUntilDeadline).toBeGreaterThan(70);
  });

  it('expediente completo pero con MENOS de 24h para la fecha límite: holgura_24h rojo (y overallStatus rojo) aunque todo lo demás esté verde', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 3', 'wr-org-3');
    const tenderId = await createTender(app, org.id, 'wr-003', isoHoursFromNow(10));
    await buildReadyExpediente(app, org.id, owner.accessToken, tenderId);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const run = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    const byDim = Object.fromEntries(body.items.map((i: any) => [i.dimension, i]));
    expect(byDim.checklist_anti_desechamiento.status).toBe('verde');
    expect(byDim.hash_zip.status).toBe('verde');
    // Todavía queda tiempo (10h > 0) -- la cuenta regresiva por sí sola no
    // es roja -- pero la HOLGURA OBLIGATORIA sí, porque 10h < 24h.
    expect(byDim.cuenta_regresiva.status).toBe('verde');
    expect(byDim.holgura_24h.status).toBe('rojo');
    expect(body.overallStatus).toBe('rojo');
  });

  it('fecha límite ya vencida: cuenta_regresiva y holgura_24h quedan rojas', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 4', 'wr-org-4');
    const tenderId = await createTender(app, org.id, 'wr-004', isoHoursFromNow(-5));
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const run = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    const byDim = Object.fromEntries(body.items.map((i: any) => [i.dimension, i]));
    expect(byDim.cuenta_regresiva.status).toBe('rojo');
    expect(byDim.holgura_24h.status).toBe('rojo');
    expect(body.hoursUntilDeadline).toBeLessThan(0);
    expect(body.overallStatus).toBe('rojo');
  });

  it('sin fecha límite fijada: cuenta_regresiva y holgura_24h quedan rojas por falta de dato, sin fabricar una fecha', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 5', 'wr-org-5');
    const tenderId = await createTender(app, org.id, 'wr-005', null);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const run = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers });
    expect(run.statusCode).toBe(200);
    const body = run.json();
    expect(body.hoursUntilDeadline).toBeNull();
    expect(body.submissionDeadlineIso).toBeNull();
    const byDim = Object.fromEntries(body.items.map((i: any) => [i.dimension, i]));
    expect(byDim.cuenta_regresiva.status).toBe('rojo');
    expect(byDim.holgura_24h.status).toBe('rojo');
  });

  it('un rol de solo lectura (viewer) no puede correr el checklist de sala de guerra, aunque sí pueda leer el último resultado', async () => {
    const owner = await registerAndLogin(app, 'wr-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'War Room Org 6', 'wr-org-6');
    const tenderId = await createTender(app, org.id, 'wr-006', isoHoursFromNow(72));
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers: ownerHeaders });
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers: ownerHeaders });

    const viewer = await registerAndLogin(app, 'wr-viewer-6@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);
    const viewerHeaders = { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id };

    const forbidden = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/war-room/run`, headers: viewerHeaders });
    expect(forbidden.statusCode).toBe(403);

    const readAnyway = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/war-room`, headers: viewerHeaders });
    expect(readAnyway.statusCode).toBe(200);
  });
});
