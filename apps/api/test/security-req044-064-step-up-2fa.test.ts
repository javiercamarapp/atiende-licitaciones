import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor } from './helpers.js';
import { generateTotpCodeForTesting } from '../src/lib/step-up.js';

/**
 * REQ-044/064: doble confirmación económica -- re-autenticación (TOTP)
 * exigida específicamente en la aprobación de tarifas y en la aprobación
 * de expediente, distinta del rol que aprueba. Cobertura: sin 2FA enrolado
 * -> 403 con instrucción; replay de TOTP rechazado; ventana de step-up
 * expirada rechazada; con step-up vigente, la aprobación procede.
 */
describe('REQ-044/064 — 2FA/step-up en aprobaciones económicas', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('sin 2FA enrolado, aprobar una tarifa responde 403 con instrucción explícita de enrolar', async () => {
    const owner = await registerAndLogin(app, 'step-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Step Org 1', 'step-org-1');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().title).toContain('POST /auth/2fa/enroll');
  });

  it('enrolado pero SIN X-Step-Up, aprobar una tarifa responde 403 pidiendo el encabezado', async () => {
    const owner = await registerAndLogin(app, 'step-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Step Org 2', 'step-org-2');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await enrollTwoFactor(app, owner.accessToken);

    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().title).toContain('X-Step-Up');
  });

  it('con X-Step-Up vigente, aprobar una tarifa y un expediente proceden', async () => {
    const owner = await registerAndLogin(app, 'step-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Step Org 3', 'step-org-3');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken);

    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers: { ...headers, 'x-step-up': stepUpToken } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe('approved');

    const tender = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': 'test-platform-api-key-01234567890' },
      payload: { records: [{ source: 'compras-mx', externalId: 'step-003', title: 'x', sourceVersion: 'v1' }], organizationIds: [org.id] },
    });
    const tenderId = tender.json().results[0].tenderId;
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
    const approveExpediente = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { scope: 'documento', scopeRef: 'documento:tecnica' },
    });
    expect(approveExpediente.statusCode).toBe(200);
  });

  it('replay: el MISMO código TOTP usado dos veces en verify-enrollment es rechazado la segunda vez', async () => {
    const owner = await registerAndLogin(app, 'step-owner-4@example.com');
    await createOrgFor(app, owner, 'Step Org 4', 'step-org-4');
    const headers = { authorization: `Bearer ${owner.accessToken}` };

    const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
    const { secretBase32 } = enroll.json();
    const code = await generateTotpCodeForTesting(secretBase32);

    const first = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code } });
    expect(first.statusCode).toBe(200);

    // Mismo código otra vez (aunque siga siendo válido dentro de su propia
    // ventana de 30s de otplib): debe rechazarse por replay.
    const replay = await app.inject({ method: 'POST', url: '/auth/2fa/step-up', headers, payload: { code } });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().title).toContain('replay');
  });

  it('ventana expirada: un stepUpToken vencido es rechazado explícitamente', async () => {
    const owner = await registerAndLogin(app, 'step-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Step Org 5', 'step-org-5');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken);

    // Se fuerza la expiración directamente en la tabla (equivalente a que
    // haya pasado STEP_UP_WINDOW_MINUTES desde la verificación real).
    await db.query("update step_up_sessions set expires_at = now() - interval '1 minute' where id = $1", [stepUpToken]);

    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers: { ...headers, 'x-step-up': stepUpToken } });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().title.toLowerCase()).toContain('expir');
  });

  it('un stepUpToken de OTRO usuario es rechazado (no se puede usar la sesión de step-up de alguien más)', async () => {
    const owner = await registerAndLogin(app, 'step-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'Step Org 6', 'step-org-6');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const otherUser = await registerAndLogin(app, 'step-other-6@example.com');
    const { stepUpToken: otherToken } = await enrollTwoFactor(app, otherUser.accessToken);

    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'x', description: 'x', unitPrice: 10, validFrom: '2020-01-01' } });
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers: { ...headers, 'x-step-up': otherToken } });
    expect(approve.statusCode).toBe(403);
  });

  it('backup code: un código de respaldo sin usar habilita un step-up; el mismo código ya no sirve una segunda vez', async () => {
    const owner = await registerAndLogin(app, 'step-owner-7@example.com');
    await createOrgFor(app, owner, 'Step Org 7', 'step-org-7');
    const headers = { authorization: `Bearer ${owner.accessToken}` };

    const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
    const { secretBase32, backupCodes } = enroll.json();
    const code = await generateTotpCodeForTesting(secretBase32);
    await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code } });

    const backupCode = backupCodes[0] as string;
    const stepUp1 = await app.inject({ method: 'POST', url: '/auth/2fa/step-up', headers, payload: { code: backupCode } });
    expect(stepUp1.statusCode).toBe(201);

    const stepUp2 = await app.inject({ method: 'POST', url: '/auth/2fa/step-up', headers, payload: { code: backupCode } });
    expect(stepUp2.statusCode).toBe(403);
  });
});
