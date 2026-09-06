import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';
import { getRateLimitSettings } from '../src/lib/rate-limit-settings.js';

/**
 * R5-02 (docs/auditoria-2/api-ronda5.md, CRÍTICA): `/auth/2fa/enroll`,
 * `/auth/2fa/verify-enrollment` y `/auth/2fa/step-up` no tenían ningún
 * límite de tasa específico -- solo heredaban el límite `global` (300
 * req/min por IP), verificado con 40 intentos consecutivos de código
 * incorrecto sin un solo 429. Fijado con un tier `twoFactor` (5/5min) por
 * IP (`config.rateLimit`) MÁS un contador de fallos por usuario persistido
 * en DB (`twofa_lockouts`, migración 0058) con bloqueo PROGRESIVO.
 *
 * R5-03 (MEDIA): los fallos de verificación ahora quedan en `audit_log`
 * (`twofa.verification_failed`/`twofa.step_up_denied`), cerrando la
 * asimetría con `auth.login_failed` (API-13).
 */
describe('R5-02/R5-03: límite de tasa + bloqueo progresivo + auditoría de fallos de 2FA', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('6º intento consecutivo de verify-enrollment con código incorrecto responde 429 (no 300/min genérico)', async () => {
    const user = await registerAndLogin(app, 'r502-user-1@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '000000' } }));
    }
    expect(results.slice(0, 5).every((r) => r.statusCode === 403)).toBe(true);
    expect(results[5].statusCode).toBe(429);
    expect(results[5].headers['retry-after']).toBeDefined();
  });

  it('el límite de tasa de 2FA es MENOR que el global (5/5min, no 300/min) y no depende del perfil e2e (mínimo garantizado)', () => {
    const def = getRateLimitSettings('default');
    const e2e = getRateLimitSettings('e2e');
    expect(def.twoFactor.max).toBe(5);
    expect(def.twoFactor.timeWindow).toBe('5 minutes');
    // R5-02: a diferencia de global/auth/sensitiveAction, este tier NO se relaja con RATE_LIMIT_PROFILE=e2e.
    expect(e2e.twoFactor).toEqual(def.twoFactor);
  });

  it('perfil e2e NO anula el límite de 2FA: 6 intentos seguidos también disparan 429 (mínimo garantizado)', async () => {
    await app.close();
    await db.close();
    ({ app, db } = await createTestApp({ rateLimitProfile: 'e2e' }));

    const user = await registerAndLogin(app, 'r502-user-e2e@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '000000' } }));
    }
    expect(results[5].statusCode).toBe(429);
  });

  it('contador de fallos por usuario en DB: falla 5 veces seguidas y confirma bloqueo progresivo persistido (twofa_lockouts)', async () => {
    const user = await registerAndLogin(app, 'r502-user-2@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });

    // Exactamente 5 fallos (el límite de tasa por IP también es 5/5min,
    // así que se usan los 5 disponibles) -- el 5º dispara el primer
    // bloqueo progresivo (FAILURES_PER_LOCKOUT = 5).
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '000000' } });
      expect(res.statusCode).toBe(403);
    }

    const row = await db.query<{ failed_count: number; lock_count: number; locked_until: string | null }>(
      'select failed_count, lock_count, locked_until from twofa_lockouts where user_id = $1',
      [user.id]
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].failed_count).toBe(5);
    expect(row.rows[0].lock_count).toBe(1);
    expect(row.rows[0].locked_until).not.toBeNull();
    expect(new Date(row.rows[0].locked_until!).getTime()).toBeGreaterThan(Date.now());
  });

  it('replay del TOTP en step-up es rechazado (no genera una nueva sesión de step-up)', async () => {
    const user = await registerAndLogin(app, 'r502-user-3@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
    const { secretBase32 } = enroll.json();
    const { generateTotpCodeForTesting } = await import('../src/lib/step-up.js');
    const code = await generateTotpCodeForTesting(secretBase32);

    const first = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code } });
    expect(first.statusCode).toBe(200);

    // El mismo código otra vez (mismo time_step ya aceptado) -- replay rechazado.
    const replay = await app.inject({ method: 'POST', url: '/auth/2fa/step-up', headers, payload: { code } });
    expect(replay.statusCode).toBe(403);
  });

  it('cada fallo de verify-enrollment/step-up queda en audit_log (antes solo se auditaban los éxitos)', async () => {
    const user = await registerAndLogin(app, 'r502-user-4@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });

    const failVerify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '000000' } });
    expect(failVerify.statusCode).toBe(403);

    const auditRows = await db.query<{ action: string }>(
      "select action from audit_log where entity = 'user_totp_secrets' and action = 'twofa.verification_failed' and actor_id = $1",
      [user.id]
    );
    expect(auditRows.rows.length).toBeGreaterThan(0);
  });

  it('estando bloqueado (locked_until en el futuro), un intento adicional responde 429 y también queda auditado', async () => {
    const user = await registerAndLogin(app, 'r502-user-5@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });

    // Fija el bloqueo directamente en DB (equivalente a haber acumulado 5 fallos antes).
    await db.query(
      `insert into twofa_lockouts (user_id, failed_count, lock_count, locked_until) values ($1, 5, 1, now() + interval '5 minutes')`,
      [user.id]
    );

    const res = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '123456' } });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);

    const auditRows = await db.query<{ action: string }>(
      "select action from audit_log where entity = 'user_totp_secrets' and action = 'twofa.verification_failed' and actor_id = $1 and after->>'reason' = 'locked_out'",
      [user.id]
    );
    expect(auditRows.rows.length).toBeGreaterThan(0);
  });

  it('una verificación EXITOSA reinicia el contador de fallos (no se arrastra un bloqueo indefinido)', async () => {
    const user = await registerAndLogin(app, 'r502-user-6@example.com');
    const headers = { authorization: `Bearer ${user.accessToken}` };
    const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
    const { secretBase32 } = enroll.json();

    // Un par de fallos (sin llegar al umbral de bloqueo).
    await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '000000' } });
    await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code: '111111' } });

    const { generateTotpCodeForTesting } = await import('../src/lib/step-up.js');
    const code = await generateTotpCodeForTesting(secretBase32);
    const ok = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code } });
    expect(ok.statusCode).toBe(200);

    const row = await db.query<{ failed_count: number }>('select failed_count from twofa_lockouts where user_id = $1', [user.id]);
    expect(row.rows[0].failed_count).toBe(0);
  });
});
