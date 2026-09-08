import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';
import { updateCollectionStatusConditioned } from '../src/modules/expediente/collection.routes.js';
import { withTx } from '../src/lib/expediente/context.js';

/**
 * REQ-051 — máquina de estados de COBRANZA para `post_award_followups` de
 * kind='facturacion'/'pago': transiciones válidas en tabla, motivo/actor/
 * evidencia obligatorios, transición inválida -> 409, historial inmutable,
 * "pagada" exige step-up (2FA reciente, nunca automático), alertas
 * (alertLevel/GET /post-award-alerts) para cobranza vencida/en disputa.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'cob-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Contrato con cobranza', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

async function createFacturaFollowup(app: FastifyInstance, tenderId: string, headers: Record<string, string>, label = 'Factura #001'): Promise<{ id: string; collectionStatus: string | null }> {
  const create = await app.inject({
    method: 'POST',
    url: `/expediente/tenders/${tenderId}/post-award`,
    headers,
    payload: { kind: 'facturacion', label, cfdiReference: 'ABCDEF12-3456-7890-ABCD-EF1234567890', acceptanceDate: '2026-01-05' },
  });
  expect(create.statusCode).toBe(201);
  return create.json();
}

describe('expediente — máquina de estados de cobranza (REQ-051)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('kind="facturacion" arranca en "emitida" con historial inicial, y kind="hito" nunca tiene ciclo de cobranza', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 1', 'cob-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const factura = await createFacturaFollowup(app, tenderId, headers);
    expect(factura.collectionStatus).toBe('emitida');

    const history = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-history`, headers });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(1);
    expect(history.json()[0].fromStatus).toBeNull();
    expect(history.json()[0].toStatus).toBe('emitida');
    expect(history.json()[0].actorId).toBe(owner.id);

    const hito = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Entrega de anexo', responsibleParty: 'Responsable X' },
    });
    expect(hito.json().collectionStatus).toBeNull();

    const hitoHistory = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award/${hito.json().id}/collection-history`, headers });
    expect(hitoHistory.statusCode).toBe(422);

    const hitoTransition = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${hito.json().id}/collection-transition`,
      headers,
      payload: { toStatus: 'enviada', reason: 'Intento sobre un kind sin ciclo de cobranza.' },
    });
    expect(hitoTransition.statusCode).toBe(422);
  });

  it('avanza por el camino normal hasta "pagada" (con step-up) y el historial queda completo e inmutable', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 2', 'cob-org-2');
    const tenderId = await createTender(app, org.id, 'cob-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const factura = await createFacturaFollowup(app, tenderId, headers);

    const toEnviada = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'enviada', reason: 'Factura enviada a la dependencia.' },
    });
    expect(toEnviada.statusCode).toBe(200);
    expect(toEnviada.json().collectionStatus).toBe('enviada');

    const toRevision = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'en_revision', reason: 'La dependencia confirma recepción y la pone en revisión.' },
    });
    expect(toRevision.statusCode).toBe(200);

    const toAprobada = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'aprobada_para_pago', reason: 'Revisión concluida sin observaciones, aprobada para pago.', evidenceRef: 'oficio-123' },
    });
    expect(toAprobada.statusCode).toBe(200);

    // "pagada" sin step-up -> 403, sin cambiar el estado.
    const pagadaSinStepUp = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'pagada', reason: 'Pago verificado en cuenta bancaria.' },
    });
    expect(pagadaSinStepUp.statusCode).toBe(403);

    const list = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award`, headers });
    expect(list.json().find((f: any) => f.id === factura.id).collectionStatus).toBe('aprobada_para_pago');

    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.collection_transition' });
    const pagada = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { toStatus: 'pagada', reason: 'Pago verificado en cuenta bancaria.' },
    });
    expect(pagada.statusCode).toBe(200);
    expect(pagada.json().collectionStatus).toBe('pagada');

    // Historial completo: alta + 4 transiciones = 5 filas, cada una con motivo y actor.
    const history = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-history`, headers });
    const items = history.json();
    expect(items).toHaveLength(5);
    for (const item of items) {
      expect(item.reason).toBeTruthy();
      expect(item.actorId).toBe(owner.id);
    }
    expect(items[items.length - 1].toStatus).toBe('pagada');

    // Historial inmutable: `collection_status_history` tiene RLS habilitada
    // sin políticas de UPDATE/DELETE -- bajo `app_role` (mismo contexto de
    // tenant que usa toda `apps/api`, ver `withTx`), Postgres no expone
    // NINGUNA fila a esos dos comandos (0 filas afectadas, no un error;
    // `app_role` se creó `nobypassrls`, migración 0001) -- se comprueba
    // afectando 0 filas Y releyendo que el contenido real no cambió,
    // en vez de solo esperar una excepción que RLS sin trigger no lanza.
    const blockedUpdate = await withTx(app.db, org.id, owner.id, (tx) =>
      tx.query('update collection_status_history set reason = $1 where id = $2', ['manipulado', items[0].id])
    );
    expect(blockedUpdate.rowCount).toBe(0);
    const blockedDelete = await withTx(app.db, org.id, owner.id, (tx) => tx.query('delete from collection_status_history where id = $1', [items[0].id]));
    expect(blockedDelete.rowCount).toBe(0);
    const stillIntact = await db.query('select reason from collection_status_history where id = $1', [items[0].id]);
    expect(stillIntact.rows[0].reason).not.toBe('manipulado');

    // Una vez "pagada" (terminal), cualquier transición nueva es inválida.
    const afterPagada = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'en_revision', reason: 'Intento de reabrir tras pagada.' },
    });
    expect(afterPagada.statusCode).toBe(409);
  });

  it('una transición fuera del grafo responde 409 con el detalle de estados permitidos, sin cambiar el estado', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 3', 'cob-org-3');
    const tenderId = await createTender(app, org.id, 'cob-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const factura = await createFacturaFollowup(app, tenderId, headers);

    const invalid = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'pagada', reason: 'Intento de saltar directo a pagada.' },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().detail.allowedNextStates).toEqual(expect.arrayContaining(['enviada', 'en_disputa']));

    const list = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award`, headers });
    expect(list.json().find((f: any) => f.id === factura.id).collectionStatus).toBe('emitida');
  });

  it('un stepUpToken de OTRO propósito es rechazado (403) al intentar marcar "pagada"', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 4', 'cob-org-4');
    const tenderId = await createTender(app, org.id, 'cob-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const factura = await createFacturaFollowup(app, tenderId, headers);
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`, headers, payload: { toStatus: 'enviada', reason: 'r1' } });
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`, headers, payload: { toStatus: 'en_revision', reason: 'r2' } });
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`, headers, payload: { toStatus: 'aprobada_para_pago', reason: 'r3' } });

    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });
    const wrongPurpose = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { toStatus: 'pagada', reason: 'Intento con step-up de otro propósito.' },
    });
    expect(wrongPurpose.statusCode).toBe(403);
  });

  it('viewer no puede transicionar el estado de cobranza', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 5', 'cob-org-5');
    const tenderId = await createTender(app, org.id, 'cob-005');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const factura = await createFacturaFollowup(app, tenderId, headers);

    const viewer = await registerAndLogin(app, 'cob-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);
    const viewerHeaders = { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id };

    const attempt = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers: viewerHeaders,
      payload: { toStatus: 'enviada', reason: 'Intento de viewer.' },
    });
    expect(attempt.statusCode).toBe(403);
  });

  it('"vencida_sin_pago"/"en_disputa" marcan alertLevel="vencido" (reusando GET /post-award-alerts) y encolan un job de alerta; "pagada" nunca alerta', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 6', 'cob-org-6');
    const tenderId = await createTender(app, org.id, 'cob-006');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const factura = await createFacturaFollowup(app, tenderId, headers, 'Factura vencida');

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`, headers, payload: { toStatus: 'enviada', reason: 'r1' } });
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`, headers, payload: { toStatus: 'en_revision', reason: 'r2' } });
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`, headers, payload: { toStatus: 'aprobada_para_pago', reason: 'r3' } });

    const toVencida = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers,
      payload: { toStatus: 'vencida_sin_pago', reason: 'Pasó el plazo de pago legal y la dependencia no ha pagado.' },
    });
    expect(toVencida.statusCode).toBe(200);
    expect(toVencida.json().alertLevel).toBe('vencido');

    const jobs = await db.query("select kind, status from jobs where org_id = $1 and kind = 'collection_status_alert'", [org.id]);
    expect(jobs.rows.length).toBe(1);
    expect(jobs.rows[0].status).toBe('queued');

    const alerts = await app.inject({ method: 'GET', url: '/expediente/post-award-alerts', headers });
    expect(alerts.statusCode).toBe(200);
    const labels = alerts.json().map((a: { label: string }) => a.label);
    expect(labels).toContain('Factura vencida');

    // Recupera la cobranza (pago tardío) y la marca "pagada": deja de alertar.
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.collection_transition' });
    const pagada = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award/${factura.id}/collection-transition`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { toStatus: 'pagada', reason: 'Pago tardío finalmente recibido y verificado.' },
    });
    expect(pagada.statusCode).toBe(200);
    expect(pagada.json().alertLevel).toBeNull();

    const alertsAfterPago = await app.inject({ method: 'GET', url: '/expediente/post-award-alerts', headers });
    expect(alertsAfterPago.json().map((a: { label: string }) => a.label)).not.toContain('Factura vencida');
  });

  it('R6-10 (mismo patrón): UPDATE condicionado con un fromStatus OBSOLETO no aplica ningún cambio -- 409 con el mensaje de carrera, sin transición fantasma ni entrada de audit_log', async () => {
    const owner = await registerAndLogin(app, 'cob-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'Cob Org 7', 'cob-org-7');
    const tenderId = await createTender(app, org.id, 'cob-007');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const factura = await createFacturaFollowup(app, tenderId, headers);
    expect(factura.collectionStatus).toBe('emitida');

    await expect(
      withTx(app.db, org.id, owner.id, (tx) =>
        updateCollectionStatusConditioned(tx, {
          orgId: org.id,
          followupId: factura.id,
          fromStatus: 'en_revision', // OBSOLETO: el estado real es "emitida".
          toStatus: 'aprobada_para_pago',
        })
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('El estado de cobranza cambió mientras se procesaba esta transición'),
      detail: expect.objectContaining({ fromStatus: 'en_revision', toStatus: 'aprobada_para_pago', currentStatus: 'emitida' }),
    });

    const after = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award`, headers });
    expect(after.json().find((f: any) => f.id === factura.id).collectionStatus).toBe('emitida');

    const history = await db.query('select 1 from collection_status_history where followup_id = $1 and to_status = $2', [factura.id, 'aprobada_para_pago']);
    expect(history.rows).toHaveLength(0);
    const audit = await db.query("select 1 from audit_log where entity = 'post_award_followups' and entity_id = $1 and action = 'collection_status.transition' and after->>'collectionStatus' = 'aprobada_para_pago'", [factura.id]);
    expect(audit.rows).toHaveLength(0);
  });
});
