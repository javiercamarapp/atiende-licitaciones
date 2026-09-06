import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';
import { lastMailTo, signedParamsFrom } from './helpers/mail.js';

describe('flujo: registro -> login -> crear org -> invitar -> cambiar rol', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('registra un usuario nuevo (201) y responde el mismo 201 genérico para un email duplicado (anti-enumeración, API-03)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'flow@example.com', password: 'password123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'flow@example.com' });

    // Ver docs/auditoria-1/db-api.md API-03: un 409 explícito permitía
    // enumerar cuentas registradas. Ahora responde el mismo 201 genérico,
    // sin crear una fila duplicada ni exponer el id real de la cuenta
    // existente (ver apps/api/test/audit-api03-register-enumeration.test.ts
    // para la cobertura completa de este comportamiento).
    const dup = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'flow@example.com', password: 'otra-password' },
    });
    expect(dup.statusCode).toBe(201);

    const rows = await db.query<{ id: string }>('select id from users where lower(email) = lower($1)', ['flow@example.com']);
    expect(rows.rows.length).toBe(1);

    // REQ-181..195: el login por email+contraseña ahora exige el correo
    // confirmado. Se confirma con el enlace REAL del correo de verificación
    // (capturado por el CaptureProvider), no tocando la base a mano: este
    // archivo es justamente el que documenta el flujo de producto completo.
    // El registro DUPLICADO de arriba no manda ningún correo (corta antes,
    // ver la rama anti-enumeración de `modules/auth/routes.ts`), así que
    // solo hay un enlace de verificación en juego.
    const verificacion = await lastMailTo(app, 'flow@example.com');
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: signedParamsFrom(verificacion, '/verificar-correo'),
    });
    expect(verify.statusCode).toBe(200);
  });

  it('login con credenciales correctas devuelve tokens; con incorrectas da 401', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'flow@example.com', password: 'password123' },
    });
    expect(ok.statusCode).toBe(200);
    const { accessToken, refreshToken } = ok.json();
    expect(typeof accessToken).toBe('string');
    expect(typeof refreshToken).toBe('string');

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'flow@example.com', password: 'incorrecta' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('refresh token emite un nuevo access token', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'flow@example.com', password: 'password123' },
    });
    const { refreshToken } = login.json();

    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refreshed.statusCode).toBe(200);
    expect(typeof refreshed.json().accessToken).toBe('string');
  });

  it('flujo completo: crear org, /me, invitar, cambiar rol', async () => {
    const owner = await registerAndLogin(app, 'owner-flow@example.com');

    // /me sin token -> 401
    const meNoAuth = await app.inject({ method: 'GET', url: '/me' });
    expect(meNoAuth.statusCode).toBe(401);

    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'owner-flow@example.com' });

    const org = await createOrgFor(app, owner, 'Mi Empresa', 'mi-empresa-flow');
    expect(org).toMatchObject({ name: 'Mi Empresa', slug: 'mi-empresa-flow' });

    // Listar mis organizaciones
    const listed = await app.inject({
      method: 'GET',
      url: '/organizations',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: org.id, role: 'owner' })])
    );

    // Sin X-Org-Id -> 403 al invitar
    const inviteNoOrg = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: 'invitee@example.com', role: 'viewer' },
    });
    expect(inviteNoOrg.statusCode).toBe(403);

    // Invitar correctamente
    const invite = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { email: 'invitee@example.com', role: 'viewer' },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()).toMatchObject({ email: 'invitee@example.com', role: 'viewer', status: 'pending' });

    // El invitado se registra y un tercero intenta cambiarle el rol sin ser owner/admin -> 403
    const memberUser = await registerAndLogin(app, 'invitee@example.com');
    // simular que ya es miembro (ronda 1 no tiene "aceptar invitación" aún): lo insertamos directamente.
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [
      org.id,
      memberUser.id,
    ]);

    const changeRoleForbidden = await app.inject({
      method: 'PATCH',
      url: `/organizations/memberships/${owner.id}`,
      headers: { authorization: `Bearer ${memberUser.accessToken}`, 'x-org-id': org.id },
      payload: { role: 'admin' },
    });
    expect(changeRoleForbidden.statusCode).toBe(403);

    // El owner sí puede cambiar el rol del invitado
    const changeRole = await app.inject({
      method: 'PATCH',
      url: `/organizations/memberships/${memberUser.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { role: 'writer' },
    });
    expect(changeRole.statusCode).toBe(200);
    expect(changeRole.json()).toMatchObject({ userId: memberUser.id, role: 'writer' });

    // Se registró auditoría de las mutaciones.
    const audit = await db.query('select action from audit_log where org_id = $1 order by created_at', [org.id]);
    const actions = audit.rows.map((r: any) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['organization.create', 'invitation.create', 'membership.change_role'])
    );
  });
});
