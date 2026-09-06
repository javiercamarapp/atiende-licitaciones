import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, enrollTwoFactorFull } from './helpers.js';

/**
 * R6-13 (docs/auditoria-2/api-ronda6-reverificacion.md, MEDIA): la suite
 * completa de `apps/api` es intermitente en HEAD por un flake de reloj en
 * `enrollTwoFactorFull`/`enrollTwoFactor` (`test/helpers.ts`), compartido
 * por TODOS los tests que necesitan step-up. Medido por el reverificador:
 * misma máquina, mismo commit, dos pasadas -- 1ª `342/343` (rojo en
 * `expediente-inconformidad.test.ts`, `enrollTwoFactorFull` lanzó
 * `2fa verify-enrollment failed: 403 {"title":"Código TOTP inválido o ya
 * utilizado (replay rechazado)."}`), 2ª `343/343` verde.
 *
 * El usuario de prueba es SIEMPRE nuevo y verifica una sola vez -- nunca es
 * un replay real: `generateTotpCodeForTesting` calcula el código en el
 * reloj de pared T y el servidor lo verifica en T+Δ; `verifyTotpCode` no da
 * NINGUNA tolerancia de ventana (`otplib.verify` sin `epochTolerance`), así
 * que si Δ cruza el límite de 30s del `timeStep` (plausible bajo la suite
 * completa corriendo en paralelo, 285-388s), el código generado para la
 * ventana T ya no es válido para la ventana T+Δ y el servidor responde 403
 * -- el mensaje único ("inválido O ya utilizado") oculta cuál de los dos
 * casos ocurrió.
 *
 * Esta prueba NO depende de ganar una carrera de reloj real (no
 * reproducible de forma determinista): simula el escenario exacto
 * interceptando la PRIMERA llamada a `/auth/2fa/verify-enrollment` para
 * que responda con el mismo 403 ambiguo que midió el reverificador (sin
 * tocar el backend real -- su estado de replay queda intacto), dejando que
 * cualquier llamada posterior pase de verdad. Antes del fix, un solo 403
 * bastaba para que `enrollTwoFactor`/`enrollTwoFactorFull` lanzaran de
 * inmediato -- exactamente el fallo medido. Después del fix, deben
 * reintentar UNA vez con un código recién generado (en vez de reutilizar
 * el que ya falló) y tener éxito.
 */
const WINDOW_EDGE_403_BODY = { type: 'https://atiende.example/errors/forbidden', title: 'Código TOTP inválido o ya utilizado (replay rechazado).', status: 403 };

function mockOneVerifyEnrollmentFailure(app: FastifyInstance): { restore: () => void; verifyCallCount: () => number } {
  const originalInject = app.inject.bind(app);
  let verifyCalls = 0;
  const spy = (vi.spyOn(app, 'inject') as any).mockImplementation(async (opts: any): Promise<any> => {
    if (opts?.url === '/auth/2fa/verify-enrollment') {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        return {
          statusCode: 403,
          body: JSON.stringify(WINDOW_EDGE_403_BODY),
          json: () => WINDOW_EDGE_403_BODY,
        };
      }
    }
    return originalInject(opts);
  });
  return { restore: () => spy.mockRestore(), verifyCallCount: () => verifyCalls };
}

describe('test/helpers.ts — R6-13: reintento determinista ante el 403 ambiguo de TOTP en el borde de ventana', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('enrollTwoFactor reintenta con un código NUEVO tras un único 403 de "borde de ventana" y tiene éxito, en vez de lanzar de inmediato', async () => {
    const owner = await registerAndLogin(app, 'r613-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'R613 Org 1', 'r613-org-1');
    const mock = mockOneVerifyEnrollmentFailure(app);

    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });

    expect(stepUpToken).toBeTruthy();
    // Dos intentos: el primero (simulado, borde de ventana) y el segundo
    // (real, con un código recién generado) -- nunca reutiliza el código
    // que ya fue rechazado.
    expect(mock.verifyCallCount()).toBe(2);
    mock.restore();
  });

  it('enrollTwoFactorFull reintenta igual y sigue devolviendo backupCodes reales', async () => {
    const owner = await registerAndLogin(app, 'r613-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'R613 Org 2', 'r613-org-2');
    const mock = mockOneVerifyEnrollmentFailure(app);

    const { stepUpToken, backupCodes } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });

    expect(stepUpToken).toBeTruthy();
    expect(backupCodes.length).toBeGreaterThan(0);
    expect(mock.verifyCallCount()).toBe(2);
    mock.restore();
  });

  it('si AMBOS intentos fallan, propaga el error real (nunca lo oculta ni reintenta indefinidamente)', async () => {
    const owner = await registerAndLogin(app, 'r613-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'R613 Org 3', 'r613-org-3');
    const originalInject = app.inject.bind(app);
    let verifyCalls = 0;
    const spy = (vi.spyOn(app, 'inject') as any).mockImplementation(async (opts: any): Promise<any> => {
      if (opts?.url === '/auth/2fa/verify-enrollment') {
        verifyCalls += 1;
        return { statusCode: 403, body: JSON.stringify(WINDOW_EDGE_403_BODY), json: () => WINDOW_EDGE_403_BODY };
      }
      return originalInject(opts);
    });

    await expect(enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' })).rejects.toThrow(/2fa verify-enrollment failed: 403/);
    // A lo sumo 2 intentos -- nunca un reintento sin límite.
    expect(verifyCalls).toBe(2);
    spy.mockRestore();
  });
});
