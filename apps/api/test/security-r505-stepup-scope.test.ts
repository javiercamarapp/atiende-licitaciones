import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode } from './helpers.js';

/**
 * R5-05 (docs/auditoria-2/api-ronda5.md, BAJA-MEDIA, diseño): `step_up_sessions`
 * no tenía columna ni comprobación de organización/acción concreta -- un
 * `stepUpToken` emitido una vez era reutilizable, dentro de la ventana de
 * vigencia, para aprobar cualquier número de tarifas/expedientes distintos
 * en cualquier organización. Fijado: `org_id`/`purpose` OPCIONALES en
 * `step_up_sessions` (migración 0061) -- si el cliente los declara al pedir
 * el step-up (`X-Org-Id` / body.purpose), `requireStepUp` exige que la
 * acción que lo consuma declare EXACTAMENTE el mismo org/purpose, o la
 * rechaza. Una sesión "genérica" (sin declarar ninguno, comportamiento
 * previo a esta ronda) sigue funcionando igual que antes -- no rompe
 * clientes existentes.
 */
describe('R5-05: step_up_sessions puede atarse a (usuario, org, propósito)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un stepUpToken atado a un purpose específico es rechazado para OTRA acción (reutilización cruzada)', async () => {
    const owner = await registerAndLogin(app, 'r505-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'R505 Org 1', 'r505-org-1');
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken);

    // Sesión pedida EXPLÍCITAMENTE para 'expediente.approval', no para aprobar una tarifa.
    const stepUpToken = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], { purpose: 'expediente.approval', orgId: org.id });

    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });

    expect(approve.statusCode).toBe(403);
    expect(approve.json().title).toContain('OTRA acción');
  });

  it('un stepUpToken atado a un purpose específico SÍ funciona para la acción declarada', async () => {
    const owner = await registerAndLogin(app, 'r505-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'R505 Org 2', 'r505-org-2');
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken);

    const stepUpToken = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], { purpose: 'company.rate_approval', orgId: org.id });

    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });

    expect(approve.statusCode).toBe(200);
  });

  it('un stepUpToken atado a una ORGANIZACIÓN es rechazado al intentarse usar en OTRA organización', async () => {
    const owner = await registerAndLogin(app, 'r505-owner-3@example.com');
    const orgA = await createOrgFor(app, owner, 'R505 Org 3A', 'r505-org-3a');
    const orgB = await createOrgFor(app, owner, 'R505 Org 3B', 'r505-org-3b');
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken);

    const stepUpToken = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], { purpose: 'company.rate_approval', orgId: orgA.id });

    const headersB = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': orgB.id, 'x-step-up': stepUpToken };
    const rateB = await app.inject({ method: 'POST', url: '/company/rates', headers: headersB, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approveB = await app.inject({ method: 'POST', url: `/company/rates/${rateB.json().id}/approve`, headers: headersB });

    expect(approveB.statusCode).toBe(403);
    expect(approveB.json().title).toContain('OTRA organización');

    // El mismo token SÍ funciona en la organización a la que fue atado.
    const headersA = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': orgA.id, 'x-step-up': stepUpToken };
    const rateA = await app.inject({ method: 'POST', url: '/company/rates', headers: headersA, payload: { itemCode: 'y', description: 'y', unitPrice: 20, validFrom: '2020-01-01' } });
    const approveA = await app.inject({ method: 'POST', url: `/company/rates/${rateA.json().id}/approve`, headers: headersA });
    expect(approveA.statusCode).toBe(200);
  });

  it('una sesión GENÉRICA (sin purpose/org declarados) sigue sirviendo para cualquier acción -- comportamiento previo preservado', async () => {
    const owner = await registerAndLogin(app, 'r505-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'R505 Org 4', 'r505-org-4');
    const { stepUpToken } = await enrollTwoFactorFull(app, owner.accessToken); // sin purpose/orgId

    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });
    expect(approve.statusCode).toBe(200);
  });
});
