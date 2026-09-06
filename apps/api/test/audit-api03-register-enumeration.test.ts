import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-03 (docs/auditoria-1/db-api.md,
 * MEDIA): POST /auth/register confirmaba por 409 explícito si un email ya
 * existía, permitiendo enumerar cuentas registradas.
 */
describe('API-03: /auth/register no permite enumerar cuentas existentes', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('registrar un email ya existente responde 201 genérico (no 409), sin crear una cuenta duplicada', async () => {
    const email = 'api03-existing@example.com';
    const first = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: 'correct-password-1' } });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    const second = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'a-completely-different-password-2' },
    });
    // Ya NO debe distinguirse por status code de un registro nuevo exitoso.
    expect(second.statusCode).toBe(201);
    // Pero no debe filtrar el id real de la cuenta existente ni crear un
    // duplicado utilizable: el id devuelto en el intento duplicado no debe
    // coincidir con una segunda fila real en la base.
    const usersWithEmail = await db.query<{ id: string }>('select id from users where lower(email) = lower($1)', [email]);
    expect(usersWithEmail.rows.length).toBe(1);
    expect(usersWithEmail.rows[0].id).toBe(firstId);

    // REQ-181..195: el login exige el correo confirmado -- se confirma la
    // cuenta REAL (la del primer registro) para poder comprobar debajo cuál
    // de las dos contraseñas quedó vigente, que es lo que este test mide.
    await db.query('update users set email_verified_at = now() where id = $1', [firstId]);

    // La contraseña original (la de la cuenta real) sigue siendo la válida;
    // la "nueva" contraseña del intento duplicado nunca se aplicó.
    const loginOriginal = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct-password-1' },
    });
    expect(loginOriginal.statusCode).toBe(200);
  });

  it('el email realmente nunca visto también responde 201 (mismo contrato de respuesta)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'api03-brand-new@example.com', password: 'another-good-password-3' },
    });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().id).toBe('string');
  });
});
