import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode } from './helpers.js';

/**
 * R5-05 (docs/auditoria-2/api-ronda5.md, BAJA-MEDIA, diseño original) /
 * R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md, BAJA-MEDIA,
 * reparación real): `step_up_sessions` no tenía columna ni comprobación de
 * organización/acción concreta -- un `stepUpToken` emitido una vez era
 * reutilizable, dentro de la ventana de vigencia, para aprobar cualquier
 * número de tarifas/expedientes distintos en cualquier organización.
 *
 * R5-05 (0061) hizo `org_id`/`purpose` OPCIONALES: si el cliente los
 * declaraba, `requireStepUp` exigía coincidencia; si no, la sesión quedaba
 * "genérica" y el alcance nunca se aplicaba. La reverificación adversarial
 * de ronda 5 confirmó que NINGÚN cliente real (`apps/web`) declaraba nunca
 * `orgId`/`purpose` -- el riesgo original de R5-05 seguía completamente
 * vigente en producción (R5-09).
 *
 * Reparación real (esta ronda): `orgId` (encabezado `X-Org-Id`) y
 * `purpose` (enum cerrado) son ahora OBLIGATORIOS al pedir CUALQUIER
 * step-up -- 400 explícito si faltan (`assertStepUpOrgId`/
 * `assertStepUpPurpose`, `lib/step-up.ts`) -- nunca existe ya una sesión
 * "genérica". Además cada sesión es de UN SOLO USO (columna `consumed_at`,
 * migración 0062).
 */
describe('R5-05/R5-09: step_up_sessions exige (usuario, org, propósito) SIEMPRE, de un solo uso', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('R5-09: pedir un step-up SIN X-Org-Id responde 400 explícito (nunca crea una sesión "genérica")', async () => {
    const owner = await registerAndLogin(app, 'r509-owner-1@example.com');
    await createOrgFor(app, owner, 'R509 Org 1', 'r509-org-1');
    const headers = { authorization: `Bearer ${owner.accessToken}` };

    const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
    const { secretBase32 } = enroll.json();
    const { generateTotpCodeForTesting } = await import('../src/lib/step-up.js');
    const code = await generateTotpCodeForTesting(secretBase32);

    const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code, purpose: 'company.rate_approval' } });
    expect(verify.statusCode).toBe(400);
    expect(verify.json().title).toContain('X-Org-Id');
  });

  it('R5-09: pedir un step-up SIN purpose (o con uno fuera del enum cerrado) responde 400 explícito', async () => {
    const owner = await registerAndLogin(app, 'r509-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'R509 Org 2', 'r509-org-2');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
    const { secretBase32, backupCodes } = enroll.json();
    const { generateTotpCodeForTesting } = await import('../src/lib/step-up.js');
    const code = await generateTotpCodeForTesting(secretBase32);

    // Completa el enrolamiento con un `purpose` válido -- un intento
    // rechazado por 400 (org/purpose inválidos) revierte TODO en la misma
    // transacción (incluida `verified_at`), así que un usuario sin 2FA
    // realmente verificado no podría, de otro modo, ni siquiera llegar a
    // probar el enum cerrado de `purpose` en `/2fa/step-up`.
    const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code, purpose: 'company.rate_approval' } });
    expect(verify.statusCode).toBe(200);

    // Ahora sí, ya enrolado y verificado: un `/2fa/step-up` SIN `purpose`
    // responde 400 (con un código de respaldo, para no chocar con el
    // rechazo de replay del código TOTP recién usado).
    const missingPurpose = await app.inject({ method: 'POST', url: '/auth/2fa/step-up', headers, payload: { code: backupCodes[0] } });
    expect(missingPurpose.statusCode).toBe(400);
    expect(missingPurpose.json().title).toContain('purpose');

    // Y un `purpose` fuera del enum cerrado también responde 400 (con OTRO
    // código de respaldo -- cada uno es de un solo uso).
    const invalidEnum = await app.inject({
      method: 'POST',
      url: '/auth/2fa/step-up',
      headers,
      payload: { code: backupCodes[1], purpose: 'algo-inventado-fuera-del-enum' },
    });
    expect(invalidEnum.statusCode).toBe(400);
    expect(invalidEnum.json().title).toContain('purpose');
  });

  it('un stepUpToken atado a un purpose específico es rechazado para OTRA acción (reutilización cruzada)', async () => {
    const owner = await registerAndLogin(app, 'r505-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'R505 Org 1', 'r505-org-1');
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });

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
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });

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
    // R5-09: single-use -- se piden DOS tokens (uno por intento real de aprobación).
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: orgA.id, purpose: 'company.rate_approval' });
    const stepUpTokenForB = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], { purpose: 'company.rate_approval', orgId: orgA.id });
    const stepUpTokenForA = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[1], { purpose: 'company.rate_approval', orgId: orgA.id });

    const headersB = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': orgB.id, 'x-step-up': stepUpTokenForB };
    const rateB = await app.inject({ method: 'POST', url: '/company/rates', headers: headersB, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approveB = await app.inject({ method: 'POST', url: `/company/rates/${rateB.json().id}/approve`, headers: headersB });

    expect(approveB.statusCode).toBe(403);
    expect(approveB.json().title).toContain('OTRA organización');

    // Un token atado a orgA SÍ funciona en la organización a la que fue atado.
    const headersA = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': orgA.id, 'x-step-up': stepUpTokenForA };
    const rateA = await app.inject({ method: 'POST', url: '/company/rates', headers: headersA, payload: { itemCode: 'y', description: 'y', unitPrice: 20, validFrom: '2020-01-01' } });
    const approveA = await app.inject({ method: 'POST', url: `/company/rates/${rateA.json().id}/approve`, headers: headersA });
    expect(approveA.statusCode).toBe(200);
  });

  it('R5-09: un stepUpToken ya usado (single-use) es rechazado en un segundo intento, aunque siga vigente y el org/purpose coincidan', async () => {
    const owner = await registerAndLogin(app, 'r509-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'R509 Org 3', 'r509-org-3');
    const { stepUpToken } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });

    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };
    const rate1 = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'a', description: 'a', unitPrice: 10, validFrom: '2020-01-01' } });
    const first = await app.inject({ method: 'POST', url: `/company/rates/${rate1.json().id}/approve`, headers });
    expect(first.statusCode).toBe(200);

    // Mismo token, MISMA org/purpose, todavía dentro de la ventana de
    // vigencia -- pero ya fue consumido por la aprobación anterior.
    const rate2 = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'b', description: 'b', unitPrice: 10, validFrom: '2020-01-01' } });
    const second = await app.inject({ method: 'POST', url: `/company/rates/${rate2.json().id}/approve`, headers });
    expect(second.statusCode).toBe(403);
    expect(second.json().title).toContain('un solo uso');
  });
});
