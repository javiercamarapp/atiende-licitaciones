import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, enrollTwoFactorFull, stepUpWithBackupCode } from './helpers.js';

/**
 * E21 (docs/BACKLOG.md): `POST /auth/2fa/disable` (desactivar 2FA de la
 * cuenta propia) y `POST /auth/2fa/backup-codes/regenerate` (regenerar
 * códigos de respaldo, invalidando los anteriores) -- ambos exigen step-up
 * (mismo `requireStepUp` que el resto de `apps/api`, ver lib/step-up.ts).
 *
 * Regla de negocio explícita: nunca dejar la cuenta sin ningún método de
 * acceso -- desactivar 2FA se rechaza (409) si la cuenta no tiene
 * contraseña NI una identidad de Google vinculada.
 */
describe('E21: POST /auth/2fa/disable y POST /auth/2fa/backup-codes/regenerate', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  describe('POST /auth/2fa/disable', () => {
    it('éxito: con step-up vigente, desactiva 2FA (borra secreto TOTP y códigos de respaldo) y lo audita', async () => {
      const user = await registerAndLogin(app, 'e21-disable-ok@example.com');
      const org = await createOrgFor(app, user, 'E21 Disable Org', 'e21-disable-org');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.disable' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ disabled: true });

      const status = await app.inject({ method: 'GET', url: '/auth/2fa/status', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(status.json()).toEqual({ enrolled: false, enrolledAt: null });

      const totpRows = await db.query('select 1 from user_totp_secrets where user_id = $1', [user.id]);
      expect(totpRows.rows.length).toBe(0);
      const backupRows = await db.query('select 1 from user_backup_codes where user_id = $1', [user.id]);
      expect(backupRows.rows.length).toBe(0);

      const audit = await db.query<{ action: string; entity: string }>(
        "select action, entity from audit_log where action = 'twofa.disabled' and actor_id = $1",
        [user.id]
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].entity).toBe('user_totp_secrets');
    });

    it('rechazo sin step-up válido: falta el encabezado X-Step-Up (403), y el 2FA sigue intacto', async () => {
      const user = await registerAndLogin(app, 'e21-disable-no-header@example.com');
      const org = await createOrgFor(app, user, 'E21 Disable Org 2', 'e21-disable-org-2');
      await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.disable' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
      });
      expect(res.statusCode).toBe(403);

      const totpRows = await db.query<{ verified_at: string | null }>('select verified_at from user_totp_secrets where user_id = $1', [user.id]);
      expect(totpRows.rows.length).toBe(1);
      expect(totpRows.rows[0].verified_at).not.toBeNull();
    });

    it('rechazo sin step-up válido: un X-Step-Up inexistente/inválido responde 403 y no desactiva nada', async () => {
      const user = await registerAndLogin(app, 'e21-disable-bad-token@example.com');
      const org = await createOrgFor(app, user, 'E21 Disable Org 3', 'e21-disable-org-3');
      await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.disable' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': '00000000-0000-0000-0000-000000000000' },
      });
      expect(res.statusCode).toBe(403);

      const totpRows = await db.query('select 1 from user_totp_secrets where user_id = $1', [user.id]);
      expect(totpRows.rows.length).toBe(1);
    });

    it('un stepUpToken emitido con OTRO propósito (p.ej. twofa.backup_codes_regenerate) es rechazado con 403', async () => {
      const user = await registerAndLogin(app, 'e21-disable-wrong-purpose@example.com');
      const org = await createOrgFor(app, user, 'E21 Disable Org 4', 'e21-disable-org-4');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.backup_codes_regenerate' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rechazo (409) si desactivar dejaría la cuenta sin ningún método de acceso (sin contraseña ni Google) -- el 2FA NO se borra y el stepUpToken se consume igual', async () => {
      const user = await registerAndLogin(app, 'e21-disable-no-access@example.com');
      const org = await createOrgFor(app, user, 'E21 Disable Org 5', 'e21-disable-org-5');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.disable' });

      // Simula una cuenta sin contraseña propia (p.ej. creada solo por
      // Google y luego desvinculada) -- directo en DB, como propietario
      // (bypassa RLS), igual que el resto de setup de este archivo de tests.
      await db.query('update users set password_hash = null where id = $1', [user.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
      });
      expect(res.statusCode).toBe(409);

      // El 2FA sigue activo: la operación se rechazó ANTES de mutar nada.
      const totpRows = await db.query<{ verified_at: string | null }>('select verified_at from user_totp_secrets where user_id = $1', [user.id]);
      expect(totpRows.rows.length).toBe(1);
      expect(totpRows.rows[0].verified_at).not.toBeNull();

      // El stepUpToken presentado sí se consumió (mismo patrón que
      // `company/routes.ts#rates/:id/approve` sobre una tarifa ya
      // decidida): un rechazo de negocio no debe dejar el token reutilizable.
      const session = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [stepUpToken]);
      expect(session.rows.length).toBe(1);
      expect(session.rows[0].consumed_at).not.toBeNull();
    });

    it('con contraseña null pero una identidad de Google vinculada, sí se permite desactivar 2FA', async () => {
      const user = await registerAndLogin(app, 'e21-disable-google-ok@example.com');
      const org = await createOrgFor(app, user, 'E21 Disable Org 6', 'e21-disable-org-6');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.disable' });

      await db.query('update users set password_hash = null where id = $1', [user.id]);
      await db.query(
        `insert into user_identities (user_id, provider, subject, email) values ($1, 'google', $2, $3)`,
        [user.id, `google-sub-${user.id}`, user.email]
      );

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/disable',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ disabled: true });
    });
  });

  describe('POST /auth/2fa/backup-codes/regenerate', () => {
    it('éxito: emite 10 códigos nuevos distintos de los anteriores y lo audita', async () => {
      const user = await registerAndLogin(app, 'e21-regen-ok@example.com');
      const org = await createOrgFor(app, user, 'E21 Regen Org', 'e21-regen-org');
      const { backupCodes: originalCodes, stepUpToken } = await enrollTwoFactorFull(app, user.accessToken, {
        orgId: org.id,
        purpose: 'twofa.backup_codes_regenerate',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/backup-codes/regenerate',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
      });
      expect(res.statusCode).toBe(201);
      const { backupCodes: newCodes } = res.json();
      expect(newCodes).toHaveLength(10);
      expect(new Set(newCodes).size).toBe(10);
      expect(newCodes.some((c: string) => originalCodes.includes(c))).toBe(false);

      // 2FA sigue enrolado y verificado (solo los códigos cambiaron).
      const status = await app.inject({ method: 'GET', url: '/auth/2fa/status', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(status.json().enrolled).toBe(true);

      const audit = await db.query<{ action: string; entity: string; after: { backupCodesIssued: number } }>(
        "select action, entity, after from audit_log where action = 'twofa.backup_codes_regenerated' and actor_id = $1",
        [user.id]
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].entity).toBe('user_backup_codes');
      expect(audit.rows[0].after.backupCodesIssued).toBe(10);
    });

    it('rechazo sin step-up válido (403) y no cambia los códigos existentes', async () => {
      const user = await registerAndLogin(app, 'e21-regen-no-stepup@example.com');
      const org = await createOrgFor(app, user, 'E21 Regen Org 2', 'e21-regen-org-2');
      const { backupCodes: originalCodes } = await enrollTwoFactorFull(app, user.accessToken, { orgId: org.id, purpose: 'twofa.backup_codes_regenerate' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/backup-codes/regenerate',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
      });
      expect(res.statusCode).toBe(403);

      // Los códigos ORIGINALES siguen funcionando -- nada se invalidó.
      const stepUp = await app.inject({
        method: 'POST',
        url: '/auth/2fa/step-up',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { code: originalCodes[0], purpose: 'twofa.disable' },
      });
      expect(stepUp.statusCode).toBe(201);
    });

    it('invalidación real: tras regenerar, un código de respaldo ANTERIOR ya no sirve, y uno NUEVO sí', async () => {
      const user = await registerAndLogin(app, 'e21-regen-invalidate@example.com');
      const org = await createOrgFor(app, user, 'E21 Regen Org 3', 'e21-regen-org-3');
      const scope = { orgId: org.id, purpose: 'twofa.backup_codes_regenerate' as const };
      const { backupCodes: originalCodes } = await enrollTwoFactorFull(app, user.accessToken, scope);

      // Pide el stepUpToken de la propia regeneración con OTRO código de
      // respaldo (distinto del que se usará para probar la invalidación
      // después) -- cada sesión de step-up es de un solo uso (R5-09).
      const regenStepUp = await stepUpWithBackupCode(app, user.accessToken, originalCodes[0], scope);

      const regen = await app.inject({
        method: 'POST',
        url: '/auth/2fa/backup-codes/regenerate',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': regenStepUp },
      });
      expect(regen.statusCode).toBe(201);
      const newCodes: string[] = regen.json().backupCodes;

      // Un código ANTERIOR (nunca usado, pero de la tanda ya reemplazada)
      // se rechaza -- invalidación real en DB, no solo "ocultado" al cliente.
      const oldAttempt = await app.inject({
        method: 'POST',
        url: '/auth/2fa/step-up',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { code: originalCodes[1], purpose: 'twofa.disable' },
      });
      expect(oldAttempt.statusCode).toBe(403);

      // Un código NUEVO sí funciona.
      const newAttempt = await app.inject({
        method: 'POST',
        url: '/auth/2fa/step-up',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { code: newCodes[0], purpose: 'twofa.disable' },
      });
      expect(newAttempt.statusCode).toBe(201);

      // 10 códigos nuevos en total; 1 ya se marcó usado por newAttempt arriba
      // (se marca `used_at`, no se borra la fila -- mismo patrón que un
      // código de respaldo consumido en `/2fa/step-up`).
      const totalCodes = await db.query('select count(*)::int as count from user_backup_codes where user_id = $1', [user.id]);
      expect(Number((totalCodes.rows[0] as { count: number }).count)).toBe(10);
      const unusedCodes = await db.query('select count(*)::int as count from user_backup_codes where user_id = $1 and used_at is null', [user.id]);
      expect(Number((unusedCodes.rows[0] as { count: number }).count)).toBe(9);
    });
  });
});
