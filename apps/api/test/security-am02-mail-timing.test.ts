import { describe, it, expect } from 'vitest';
import { createTestApp } from './helpers.js';

/**
 * AM-02 (docs/auditoria-2/api-mail.md, ALTA): `/auth/password/forgot` y
 * `/auth/email/resend-verification` respondían el mismo cuerpo (202) exista
 * o no la cuenta, pero el trabajo real (`fireAndForgetMail`) solo se
 * disparaba cuando la cuenta era elegible -- aunque ese trabajo no se
 * espera, competía por CPU con la propia respuesta HTTP antes de que
 * terminara de enviarse (misma mecánica que el oráculo de `/auth/login` que
 * API-03 cerró). La auditoría midió en vivo 8.34x (forgot) y 5.83x (resend)
 * de diferencia de mediana de latencia entre cuenta existente/inexistente.
 *
 * Reparado disparando SIEMPRE `fireAndForgetMail` (real o DECOY vía
 * `lib/mail/decoy.ts`, nunca omitido) -- ver el docstring de
 * `modules/auth/mail.routes.ts` y `lib/mail/decoy.ts`.
 *
 * Metodología IDÉNTICA a `security-api03-login-timing.test.ts` (mismo
 * umbral 1.5x, mismo criterio de app aislada por lote de 5 peticiones -- el
 * límite real del tier `auth` -- para no contaminar la medición con el
 * rate-limiter).
 */
describe('AM-02: /auth/password/forgot y /auth/email/resend-verification no son un oráculo de timing', () => {
  const SAMPLES_PER_SIDE = 25;
  const REQUESTS_PER_APP = 5; // límite real del tier `auth`: 5/min por IP

  async function measureLatencyMs(
    app: Awaited<ReturnType<typeof createTestApp>>['app'],
    url: string,
    email: string
  ): Promise<number> {
    const start = process.hrtime.bigint();
    const res = await app.inject({ method: 'POST', url, payload: { email } });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    // Sanity check: nunca debe ser un 429 (rate-limited) -- contaminaría la
    // medición igual que en la auditoría original de /auth/login.
    expect(res.statusCode).toBe(202);
    return elapsedMs;
  }

  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  async function runTimingCheck(url: string, existingPrefix: string, nonexistentPrefix: string): Promise<void> {
    const existingLatencies: number[] = [];
    for (let appIndex = 0; existingLatencies.length < SAMPLES_PER_SIDE; appIndex++) {
      const { app, db } = await createTestApp();
      try {
        const email = `${existingPrefix}-${appIndex}@example.com`;
        const reg = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: { email, password: 'correct-horse-battery-staple' },
        });
        expect(reg.statusCode).toBe(201);
        // Deja terminar el correo de verificación del registro (fireAndForgetMail)
        // ANTES de medir -- el mismo criterio que security-api03-login-timing.test.ts:
        // ese trabajo de fondo no debe contaminar las primeras muestras de esta app.
        await app.waitForPendingMail();
        for (let j = 0; j < REQUESTS_PER_APP && existingLatencies.length < SAMPLES_PER_SIDE; j++) {
          existingLatencies.push(await measureLatencyMs(app, url, email));
        }
      } finally {
        await app.close();
        await db.close();
      }
    }

    const nonexistentLatencies: number[] = [];
    for (let appIndex = 0; nonexistentLatencies.length < SAMPLES_PER_SIDE; appIndex++) {
      const { app, db } = await createTestApp();
      try {
        for (let j = 0; j < REQUESTS_PER_APP && nonexistentLatencies.length < SAMPLES_PER_SIDE; j++) {
          nonexistentLatencies.push(
            await measureLatencyMs(app, url, `${nonexistentPrefix}-${appIndex}-${j}@example.com`)
          );
        }
      } finally {
        await app.close();
        await db.close();
      }
    }

    expect(existingLatencies.length).toBe(SAMPLES_PER_SIDE);
    expect(nonexistentLatencies.length).toBe(SAMPLES_PER_SIDE);

    const medExisting = median(existingLatencies);
    const medNonexistent = median(nonexistentLatencies);
    const ratio = Math.max(medExisting, medNonexistent) / Math.min(medExisting, medNonexistent);

    console.log(
      `AM-02 ${url} timing: mediana existente=${medExisting.toFixed(2)}ms, ` +
        `mediana inexistente=${medNonexistent.toFixed(2)}ms, ratio=${ratio.toFixed(2)}x`
    );

    expect(ratio).toBeLessThan(1.5);
  }

  it(
    'la mediana de latencia de /auth/password/forgot con cuenta existente y con cuenta inexistente difiere menos de 1.5x',
    async () => {
      await runTimingCheck('/auth/password/forgot', 'am02-forgot-existing', 'am02-forgot-nonexistent');
    },
    120_000
  );

  it(
    'la mediana de latencia de /auth/email/resend-verification con cuenta existente y con cuenta inexistente difiere menos de 1.5x',
    async () => {
      await runTimingCheck('/auth/email/resend-verification', 'am02-resend-existing', 'am02-resend-nonexistent');
    },
    120_000
  );
});
