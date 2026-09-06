import { describe, it, expect } from 'vitest';
import { createTestApp } from './helpers.js';

/**
 * API-03 (docs/auditoria-1/db-api-reverificacion.md, PARCIAL): `/auth/register`
 * ya estaba genuinamente cerrado contra enumeración por timing (auditoría
 * original), pero `/auth/login` seguía siendo un oráculo de timing: scrypt
 * (costoso) solo se ejecutaba si el email existía. La medición original
 * (auditoría ronda 1) estaba contaminada por el rate-limiter de la propia
 * ruta (5/min) al reutilizar una sola app para muchas muestras; la
 * reverificación, con una app AISLADA por muestra, midió una separación
 * total (ratio 24x, 0% overlap en 15/15 muestras). Fijado invocando SIEMPRE
 * `verifyPassword` (scrypt real) con un hash -- el del usuario si existe,
 * uno ficticio con el mismo formato/costo si no -- antes de decidir 401.
 *
 * Metodología (misma que la reverificación, para no repetir la
 * contaminación del rate-limiter de 5/min de /auth/login): varias apps
 * Fastify+PGlite aisladas, cada una con como mucho 5 intentos de login (el
 * límite exacto de la ruta), hasta reunir 50 muestras por lado. El umbral
 * de aceptación (ratio de medianas < 1.5x) es deliberadamente holgado
 * frente al 24x medido antes del fix -- absorbe el ruido normal de CI sin
 * dejar pasar una regresión real del oráculo.
 */
describe('API-03: /auth/login no es un oráculo de timing de existencia de cuenta', () => {
  it(
    'la mediana de latencia de login con email existente (password incorrecta) y con email inexistente difiere menos de 1.5x en 50 muestras por lado',
    async () => {
      const SAMPLES_PER_SIDE = 50;
      const LOGINS_PER_APP = 5; // límite real de la ruta: 5/min por IP

      async function measureLoginLatencyMs(
        app: Awaited<ReturnType<typeof createTestApp>>['app'],
        email: string,
        password: string
      ): Promise<number> {
        const start = process.hrtime.bigint();
        const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
        const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
        // Sanity check: nunca debe ser un 429 (rate-limited) -- eso
        // contaminaría la medición exactamente como en la auditoría
        // original. Si esto falla, hay que bajar LOGINS_PER_APP.
        expect(res.statusCode).toBe(401);
        return elapsedMs;
      }

      const existingLatencies: number[] = [];
      for (let appIndex = 0; existingLatencies.length < SAMPLES_PER_SIDE; appIndex++) {
        const { app, db } = await createTestApp();
        try {
          const email = `api03-existing-${appIndex}@example.com`;
          const reg = await app.inject({
            method: 'POST',
            url: '/auth/register',
            payload: { email, password: 'correct-horse-battery-staple' },
          });
          expect(reg.statusCode).toBe(201);
          for (let j = 0; j < LOGINS_PER_APP && existingLatencies.length < SAMPLES_PER_SIDE; j++) {
            existingLatencies.push(await measureLoginLatencyMs(app, email, `wrong-password-attempt-${j}`));
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
          for (let j = 0; j < LOGINS_PER_APP && nonexistentLatencies.length < SAMPLES_PER_SIDE; j++) {
            nonexistentLatencies.push(
              await measureLoginLatencyMs(app, `api03-nonexistent-${appIndex}-${j}@example.com`, 'whatever-password')
            );
          }
        } finally {
          await app.close();
          await db.close();
        }
      }

      expect(existingLatencies.length).toBe(SAMPLES_PER_SIDE);
      expect(nonexistentLatencies.length).toBe(SAMPLES_PER_SIDE);

      const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      };

      const medExisting = median(existingLatencies);
      const medNonexistent = median(nonexistentLatencies);
      const ratio = Math.max(medExisting, medNonexistent) / Math.min(medExisting, medNonexistent);

      console.log(
        `API-03 login timing: mediana existente=${medExisting.toFixed(2)}ms, ` +
          `mediana inexistente=${medNonexistent.toFixed(2)}ms, ratio=${ratio.toFixed(2)}x`
      );

      expect(ratio).toBeLessThan(1.5);
    },
    120_000
  );
});
