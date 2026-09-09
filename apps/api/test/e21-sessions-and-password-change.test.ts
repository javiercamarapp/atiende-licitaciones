import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, enrollTwoFactorFull, stepUpWithBackupCode } from './helpers.js';

/**
 * E21 (docs/BACKLOG.md), segunda mitad: `GET /auth/sessions` (listar
 * sesiones activas), `DELETE /auth/sessions/:id` (cerrar una sesión
 * concreta), `POST /auth/sessions/revoke-others` (cerrar todas menos la
 * actual) y `POST /auth/password/change` (cambiar contraseña, con
 * step-up) -- mismo patrón de step-up/audit que la primera mitad
 * (commit 777044d, `modules/twofa/routes.ts`).
 */
describe('E21: GET/DELETE /auth/sessions, POST /auth/sessions/revoke-others, POST /auth/password/change', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  describe('GET /auth/sessions', () => {
    it('refleja sesiones REALES: una por cada login vigente, con ip/user-agent, ninguna de otro usuario', async () => {
      const user = await registerAndLogin(app, 'e21-sessions-list@example.com');
      // Un segundo login real (mismo usuario, "otro dispositivo") crea una
      // SEGUNDA fila viva de refresh_tokens -- no reemplaza la primera
      // (solo /auth/refresh rota/reemplaza; un login nuevo siempre suma).
      const login2 = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'user-agent': 'otro-dispositivo/1.0' },
        payload: { email: user.email, password: user.password },
      });
      expect(login2.statusCode).toBe(200);

      // Sesión de OTRO usuario -- nunca debe aparecer en la lista de arriba.
      await registerAndLogin(app, 'e21-sessions-other-user@example.com');

      const res = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(res.statusCode).toBe(200);
      const { sessions } = res.json();
      expect(sessions).toHaveLength(2);
      for (const s of sessions) {
        expect(typeof s.id).toBe('string');
        expect(typeof s.createdAt).toBe('string');
        expect(typeof s.expiresAt).toBe('string');
      }
      // Al menos una fila refleja el user-agent real que se mandó arriba.
      expect(sessions.some((s: { userAgent: string | null }) => s.userAgent === 'otro-dispositivo/1.0')).toBe(true);
    });

    it('tras /auth/refresh, la sesión rotada sigue contando como UNA sola (reemplazo, no suma)', async () => {
      const user = await registerAndLogin(app, 'e21-sessions-refresh-rotate@example.com');
      const before = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(before.json().sessions).toHaveLength(1);

      const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } });
      expect(refresh.statusCode).toBe(200);

      const after = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(after.json().sessions).toHaveLength(1);
      expect(after.json().sessions[0].id).not.toBe(before.json().sessions[0].id);
    });

    it('sin autenticación, responde 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/sessions' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('cierra la sesión indicada y NO afecta a las demás: el refresh token cerrado deja de servir, el otro sigue vigente', async () => {
      const user = await registerAndLogin(app, 'e21-sessions-revoke-one@example.com');
      const login2 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });
      const refreshToken2: string = login2.json().refreshToken;

      const list = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      const sessions = list.json().sessions as { id: string; createdAt: string }[];
      expect(sessions).toHaveLength(2);
      // GET /auth/sessions ordena por created_at DESC -- la más reciente
      // (login2, dueña de `refreshToken2`) va primero; identificarla así en
      // vez de asumir un orden fijo hace el test robusto a cambios de
      // ordenamiento futuros.
      const sortedByCreatedAtDesc = [...sessions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const sessionToClose = sortedByCreatedAtDesc[sortedByCreatedAtDesc.length - 1]; // la más VIEJA: la del `user.refreshToken` original.
      const sessionToKeep = sortedByCreatedAtDesc[0]; // la más nueva: la de `refreshToken2`.

      const del = await app.inject({
        method: 'DELETE',
        url: `/auth/sessions/${sessionToClose.id}`,
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ revoked: true });

      // Queda solo UNA sesión activa: la que NO se cerró.
      const listAfter = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(listAfter.json().sessions).toHaveLength(1);
      expect(listAfter.json().sessions[0].id).toBe(sessionToKeep.id);

      // La fila de la sesión CERRADA quedó revocada en DB (verificado
      // directo en la tabla, NUNCA vía POST /auth/refresh con ese token:
      // `app.rotate_refresh_token`, 0043, trata presentar un token YA
      // revocado como REUSO y, como defensa preexistente anti-robo de
      // sesión, revoca preventivamente TODAS las demás sesiones activas del
      // usuario -- probar aquí con el token cerrado invalidaría a propósito
      // la propia sesión que este test quiere demostrar que sigue intacta,
      // confundiendo ese efecto de seguridad ya existente con un fallo de
      // los endpoints nuevos de E21).
      const closedRow = await db.query<{ revoked_at: string | null }>('select revoked_at from refresh_tokens where id = $1', [sessionToClose.id]);
      expect(closedRow.rows.length).toBe(1);
      expect(closedRow.rows[0].revoked_at).not.toBeNull();

      // El de la sesión NO tocada sigue sirviendo -- prueba directa de que
      // cerrar una no afecta a la otra.
      const refreshOpen = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: refreshToken2 } });
      expect(refreshOpen.statusCode).toBe(200);

      const audit = await db.query<{ action: string; after: { sessionId: string } }>(
        "select action, after from audit_log where action = 'auth.session_revoked' and actor_id = $1",
        [user.id]
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].after.sessionId).toBe(sessionToClose.id);
    });

    it('un id inexistente responde 404', async () => {
      const user = await registerAndLogin(app, 'e21-sessions-revoke-missing@example.com');
      const res = await app.inject({
        method: 'DELETE',
        url: '/auth/sessions/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${user.accessToken}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('el id de la sesión de OTRO usuario responde 404 (nunca se revoca, nunca se confirma que existe)', async () => {
      const owner = await registerAndLogin(app, 'e21-sessions-revoke-owner@example.com');
      const attacker = await registerAndLogin(app, 'e21-sessions-revoke-attacker@example.com');

      const ownerSessions = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${owner.accessToken}` } });
      const [ownerSession] = ownerSessions.json().sessions as { id: string }[];

      const res = await app.inject({
        method: 'DELETE',
        url: `/auth/sessions/${ownerSession.id}`,
        headers: { authorization: `Bearer ${attacker.accessToken}` },
      });
      expect(res.statusCode).toBe(404);

      // La sesión del dueño real sigue intacta -- el intento del atacante no la tocó.
      const refreshOwner = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: owner.refreshToken } });
      expect(refreshOwner.statusCode).toBe(200);
    });
  });

  describe('POST /auth/sessions/revoke-others', () => {
    it('cierra TODAS las sesiones menos la actual, y preserva EXACTAMENTE esa -- las otras 2 dejan de servir, la actual sigue viva', async () => {
      const user = await registerAndLogin(app, 'e21-sessions-revoke-others@example.com');
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });
      const login3 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });
      const refreshToken3: string = login3.json().refreshToken;

      const before = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      expect(before.json().sessions).toHaveLength(3);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sessions/revoke-others',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { refreshToken: refreshToken3 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revokedCount: 2 });

      const after = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${user.accessToken}` } });
      const afterSessions = after.json().sessions as { id: string }[];
      expect(afterSessions).toHaveLength(1);

      // La preservada, EXACTAMENTE la que se pidió mantener (refreshToken3),
      // sigue viva -- se prueba PRIMERO y es la ÚNICA sesión que se prueba
      // vía POST /auth/refresh en este test: presentar cualquiera de los
      // otros dos tokens (ya revocados) dispararía la protección
      // preexistente anti-reuso de `app.rotate_refresh_token` (0043), que
      // revocaría en cascada TODAS las sesiones activas restantes --
      // incluida esta misma, confundiendo esa defensa ya existente con un
      // fallo de los endpoints nuevos de E21. Las otras dos se verifican
      // directo contra `refresh_tokens` (revoked_at), no vía /auth/refresh.
      const r3 = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: refreshToken3 } });
      expect(r3.statusCode).toBe(200);

      // Las DOS sesiones distintas de la preservada quedaron revocadas en DB.
      const beforeSessions = before.json().sessions as { id: string }[];
      const revokedIds = beforeSessions.map((s) => s.id).filter((id) => id !== afterSessions[0].id);
      expect(revokedIds).toHaveLength(2);
      const revokedRows = await db.query<{ id: string; revoked_at: string | null }>(
        'select id, revoked_at from refresh_tokens where id = any($1::uuid[])',
        [revokedIds]
      );
      expect(revokedRows.rows).toHaveLength(2);
      for (const row of revokedRows.rows) {
        expect(row.revoked_at).not.toBeNull();
      }

      const audit = await db.query<{ action: string; after: { revokedCount: number } }>(
        "select action, after from audit_log where action = 'auth.sessions_revoked_others' and actor_id = $1",
        [user.id]
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0].after.revokedCount).toBe(2);
    });

    it('con un refreshToken que NO corresponde a una sesión vigente propia, responde 401 y NO revoca nada', async () => {
      const user = await registerAndLogin(app, 'e21-sessions-revoke-others-bad-token@example.com');
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sessions/revoke-others',
        headers: { authorization: `Bearer ${user.accessToken}` },
        payload: { refreshToken: 'un-token-inventado-que-no-existe' },
      });
      expect(res.statusCode).toBe(401);

      // Ninguna sesión real se tocó -- el refresh original sigue sirviendo.
      const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } });
      expect(refresh.statusCode).toBe(200);
    });

    it('el refreshToken de OTRO usuario (aunque válido para su dueño) no cuenta como "sesión propia vigente": 401, y ninguna sesión del llamante se revoca', async () => {
      const caller = await registerAndLogin(app, 'e21-sessions-revoke-others-cross-user@example.com');
      const other = await registerAndLogin(app, 'e21-sessions-revoke-others-victim@example.com');

      const res = await app.inject({
        method: 'POST',
        url: '/auth/sessions/revoke-others',
        headers: { authorization: `Bearer ${caller.accessToken}` },
        payload: { refreshToken: other.refreshToken },
      });
      expect(res.statusCode).toBe(401);

      const callerRefresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: caller.refreshToken } });
      expect(callerRefresh.statusCode).toBe(200);
      const otherRefresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: other.refreshToken } });
      expect(otherRefresh.statusCode).toBe(200);
    });
  });

  describe('POST /auth/password/change', () => {
    it('éxito: con step-up y la contraseña actual correcta, cambia la contraseña, invalida la vieja y revoca TODAS las sesiones', async () => {
      const user = await registerAndLogin(app, 'e21-password-change-ok@example.com');
      const org = await createOrgFor(app, user, 'E21 Password Org', 'e21-password-org');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.password_change' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
        payload: { currentPassword: user.password, newPassword: 'una-contrasena-nueva-larga' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ changed: true });

      // La contraseña VIEJA ya no sirve para iniciar sesión.
      const loginOld = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });
      expect(loginOld.statusCode).toBe(401);

      // La NUEVA sí funciona.
      const loginNew = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: 'una-contrasena-nueva-larga' } });
      expect(loginNew.statusCode).toBe(200);

      // Todas las sesiones anteriores (incluida la de este mismo dispositivo) quedaron revocadas.
      const refreshOld = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } });
      expect(refreshOld.statusCode).toBe(401);

      const audit = await db.query<{ action: string }>("select action from audit_log where action = 'auth.password_changed' and actor_id = $1", [
        user.id,
      ]);
      expect(audit.rows.length).toBe(1);
    });

    it('rechazo sin step-up válido (403), y la contraseña sigue siendo la vieja', async () => {
      const user = await registerAndLogin(app, 'e21-password-change-no-stepup@example.com');
      const org = await createOrgFor(app, user, 'E21 Password Org 2', 'e21-password-org-2');
      await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.password_change' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
        payload: { currentPassword: user.password, newPassword: 'una-contrasena-nueva-larga' },
      });
      expect(res.statusCode).toBe(403);

      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });
      expect(login.statusCode).toBe(200);
    });

    it('un stepUpToken de OTRO propósito (p.ej. twofa.disable) es rechazado con 403', async () => {
      const user = await registerAndLogin(app, 'e21-password-change-wrong-purpose@example.com');
      const org = await createOrgFor(app, user, 'E21 Password Org 3', 'e21-password-org-3');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'twofa.disable' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
        payload: { currentPassword: user.password, newPassword: 'una-contrasena-nueva-larga' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rechazo (401) si currentPassword es incorrecta -- la contraseña NO cambia, pero el stepUpToken se consume igual', async () => {
      const user = await registerAndLogin(app, 'e21-password-change-wrong-current@example.com');
      const org = await createOrgFor(app, user, 'E21 Password Org 4', 'e21-password-org-4');
      const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.password_change' });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
        payload: { currentPassword: 'esta-no-es-la-contrasena-actual', newPassword: 'una-contrasena-nueva-larga' },
      });
      expect(res.statusCode).toBe(401);

      // La vieja sigue sirviendo -- nada cambió.
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: user.password } });
      expect(login.statusCode).toBe(200);

      // El stepUpToken ya se consumió (mismo patrón que /2fa/disable): reusarlo falla.
      const session = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [stepUpToken]);
      expect(session.rows.length).toBe(1);
      expect(session.rows[0].consumed_at).not.toBeNull();
    });

    it('rechazo (409) en una cuenta solo-Google (sin contraseña propia) -- no hay contraseña que cambiar', async () => {
      const user = await registerAndLogin(app, 'e21-password-change-google-only@example.com');
      const org = await createOrgFor(app, user, 'E21 Password Org 5', 'e21-password-org-5');
      const scope = { orgId: org.id, purpose: 'auth.password_change' as const };
      const { backupCodes } = await enrollTwoFactorFull(app, user.accessToken, scope);
      const stepUpToken = await stepUpWithBackupCode(app, user.accessToken, backupCodes[0], scope);

      await db.query('update users set password_hash = null where id = $1', [user.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
        payload: { currentPassword: 'lo-que-sea', newPassword: 'una-contrasena-nueva-larga' },
      });
      expect(res.statusCode).toBe(409);
    });

    it('sin autenticación, responde 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/password/change',
        payload: { currentPassword: 'a', newPassword: 'bbbbbbbb' },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
