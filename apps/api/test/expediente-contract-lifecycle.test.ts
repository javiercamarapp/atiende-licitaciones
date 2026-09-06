import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-051 — máquina de estados del contrato post-adjudicación: transiciones
 * válidas en tabla, motivo/actor/evidencia obligatorios, transición
 * inválida -> 409, historial inmutable, alertas por estado (job
 * `contract_state_alert`, sin envío externo), step-up para transiciones
 * económicas/legales sensibles (rescindir/penalizar/en_inconformidad/
 * modificar).
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'c051-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Contrato de suministro', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — máquina de estados del contrato (REQ-051)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('crea el contrato en "adjudicado" y avanza por el camino normal hasta "cerrado" con historial inmutable', async () => {
    const owner = await registerAndLogin(app, 'c051-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'C051 Org 1', 'c051-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(create.statusCode).toBe(201);
    expect(create.json().status).toBe('adjudicado');

    const dup = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(dup.statusCode).toBe(409);

    const toFirmado = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'contrato_firmado_declarado', reason: 'El proveedor declara haber firmado el contrato en papel.', evidenceRef: 'firma-001' },
    });
    expect(toFirmado.statusCode).toBe(200);
    expect(toFirmado.json().status).toBe('contrato_firmado_declarado');

    const toEjecucion = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'en_ejecucion', reason: 'Inicio de ejecución conforme a calendario pactado.' },
    });
    expect(toEjecucion.statusCode).toBe(200);

    const toEntregado = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'entregado', reason: 'Entrega total conforme a bases.' },
    });
    expect(toEntregado.statusCode).toBe(200);

    const toFacturado = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'facturado', reason: 'Factura emitida y entregada.' },
    });
    expect(toFacturado.statusCode).toBe(200);

    const toPagado = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'pagado', reason: 'Pago verificado en cuenta.' },
    });
    expect(toPagado.statusCode).toBe(200);

    const toCerrado = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'cerrado', reason: 'Contrato cerrado administrativamente.' },
    });
    expect(toCerrado.statusCode).toBe(200);
    expect(toCerrado.json().status).toBe('cerrado');

    const history = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract/history`, headers });
    expect(history.statusCode).toBe(200);
    const items = history.json();
    // alta + 6 transiciones = 7 filas, en orden, cada una con motivo y actor.
    expect(items.length).toBe(7);
    for (const item of items) {
      expect(item.reason).toBeTruthy();
      expect(item.actorId).toBe(owner.id);
    }
    expect(items[items.length - 1].toStatus).toBe('cerrado');

    // Historial inmutable: la tabla contract_state_history no admite UPDATE/DELETE (RLS sin esas políticas).
    await expect(db.query('update contract_state_history set reason = $1 where id = $2', ['manipulado', items[0].id])).rejects.toThrow();
  });

  it('una transición fuera del grafo responde 409 con el detalle de estados permitidos, y no cambia el estado', async () => {
    const owner = await registerAndLogin(app, 'c051-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'C051 Org 2', 'c051-org-2');
    const tenderId = await createTender(app, org.id, 'c051-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const invalid = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'pagado', reason: 'Intento de saltar directo a pagado.' },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().detail.allowedNextStates).toEqual(expect.arrayContaining(['contrato_firmado_declarado']));

    const current = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(current.json().status).toBe('adjudicado');
  });

  it('rescindir/penalizar/modificar/en_inconformidad exigen step-up (2FA reciente); sin él, 403 y el estado no cambia', async () => {
    const owner = await registerAndLogin(app, 'c051-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'C051 Org 3', 'c051-org-3');
    const tenderId = await createTender(app, org.id, 'c051-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const withoutStepUp = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'rescindido', reason: 'Incumplimiento grave del proveedor.' },
    });
    expect(withoutStepUp.statusCode).toBe(403);

    const stillAdjudicado = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(stillAdjudicado.json().status).toBe('adjudicado');

    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.contract_transition' });
    const withStepUp = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { toStatus: 'rescindido', reason: 'Incumplimiento grave del proveedor.' },
    });
    expect(withStepUp.statusCode).toBe(200);
    expect(withStepUp.json().status).toBe('rescindido');

    // El job de alerta se encoló (sin envío externo).
    const jobs = await db.query("select kind, status from jobs where org_id = $1 and kind = 'contract_state_alert'", [org.id]);
    expect(jobs.rows.length).toBe(1);
    expect(jobs.rows[0].status).toBe('queued');

    // "rescindido" -> "cerrado" NO exige step-up (no está en CONTRACT_STEP_UP_TRANSITIONS).
    const toCerrado = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'cerrado', reason: 'Cierre administrativo tras rescisión.' },
    });
    expect(toCerrado.statusCode).toBe(200);
  });

  it('un stepUpToken de OTRO propósito es rechazado (403) al intentar rescindir', async () => {
    const owner = await registerAndLogin(app, 'c051-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'C051 Org 4', 'c051-org-4');
    const tenderId = await createTender(app, org.id, 'c051-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const scope = { orgId: org.id, purpose: 'expediente.approval' as const };
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, scope);
    const wrongPurpose = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { toStatus: 'rescindido', reason: 'Intento con step-up de otro propósito.' },
    });
    expect(wrongPurpose.statusCode).toBe(403);
  });

  it('viewer no puede registrar el contrato ni transicionarlo', async () => {
    const owner = await registerAndLogin(app, 'c051-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'C051 Org 5', 'c051-org-5');
    const tenderId = await createTender(app, org.id, 'c051-005');
    const viewer = await registerAndLogin(app, 'c051-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const viewerHeaders = { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id };
    const attempt = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers: viewerHeaders });
    expect(attempt.statusCode).toBe(403);
  });

  it('R6-04: dos transiciones concurrentes del MISMO contrato partiendo del MISMO fromStatus -- exactamente una 200, la otra 409, y el historial nunca queda con dos filas para el mismo salto', async () => {
    const owner = await registerAndLogin(app, 'c051-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'C051 Org 6', 'c051-org-6');
    const tenderId = await createTender(app, org.id, 'c051-006');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    // Antes de R6-04, el UPDATE de la transición no condicionaba sobre el
    // `fromStatus` leído -- dos solicitudes concurrentes que parten del
    // mismo estado ("adjudicado") podían ambas pasar la validación en
    // memoria y ambas tener éxito (200), cada una insertando una fila de
    // historial con un `from_status` que ya no correspondía al estado real
    // inmediatamente anterior en la cadena.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/expediente/tenders/${tenderId}/contract/transition`,
        headers,
        payload: { toStatus: 'contrato_firmado_declarado', reason: 'Solicitud concurrente A.' },
      }),
      app.inject({
        method: 'POST',
        url: `/expediente/tenders/${tenderId}/contract/transition`,
        headers,
        payload: { toStatus: 'contrato_firmado_declarado', reason: 'Solicitud concurrente B.' },
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const contract = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(contract.json().status).toBe('contrato_firmado_declarado');

    // El historial tiene EXACTAMENTE una fila para el salto
    // adjudicado -> contrato_firmado_declarado (la otra solicitud nunca
    // escribió nada, gracias al UPDATE condicionado -- ver R6-04).
    const history = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract/history`, headers });
    const jumps = history.json().filter((h: any) => h.fromStatus === 'adjudicado' && h.toStatus === 'contrato_firmado_declarado');
    expect(jumps).toHaveLength(1);
  });
});
