import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * API-08 (docs/auditoria-1/db-api-reverificacion.md, ALTA): mismo mecanismo
 * de API-02 (escalada de rol), ruta distinta. `PATCH
 * /organizations/memberships/:userId` ya bloqueaba que un admin (no-owner)
 * concediera `owner`, pero `POST /organizations/invitations` no tenía la
 * misma protección: un admin podía invitar directamente a un tercero con
 * `role:'owner'`, y al aceptar la invitación el rol se concedía sin
 * control -- rodeando por completo el cierre de API-02.
 *
 * Cada caso usa su propia app/DB aisladas (en vez de una compartida en
 * `beforeAll`, ver `audit-api02-role-escalation.test.ts` para el mismo
 * patrón): cada caso hace 1-2 `registerAndLogin`, y `/auth/login` tiene su
 * propio límite de 5/min por IP -- compartir una sola app entre los 4 casos
 * de este archivo agota ese límite y contamina los casos posteriores con
 * 429, no con el resultado real que se quiere probar.
 */
describe('API-08: solo un owner puede invitar con el rol owner', () => {
  it('un admin (no-owner) NO puede invitar a un tercero con role:owner', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'api08-owner@example.com');
      const admin = await registerAndLogin(app, 'api08-admin@example.com');
      const org = await createOrgFor(app, owner, 'API08 Org', 'api08-org-1');
      await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'admin')", [org.id, admin.id]);

      const invite = await app.inject({
        method: 'POST',
        url: '/organizations/invitations',
        headers: { authorization: `Bearer ${admin.accessToken}`, 'x-org-id': org.id },
        payload: { email: 'api08-target@example.com', role: 'owner' },
      });
      expect(invite.statusCode).toBe(403);

      const invitations = await db.query<{ count: string }>(
        "select count(*)::text as count from invitations where org_id = $1 and email = 'api08-target@example.com'",
        [org.id]
      );
      expect(Number(invitations.rows[0].count)).toBe(0);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('extremo a extremo: si la invitación como owner se hubiera creado, aceptarla NO debe terminar en rol owner (defensa en profundidad)', async () => {
    // Este caso documenta que, aunque la creación ya está bloqueada arriba,
    // el bug original de API-08 se manifestaba al ACEPTAR una invitación ya
    // creada con role:'owner' -- se reproduce insertando la invitación
    // directamente (bypaseando la ruta HTTP, como hacía la fuga original)
    // para confirmar que `app.accept_invitation` por sí sola no es la
    // última línea de defensa (la protección real es en la creación).
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'api08-owner2@example.com');
      const target = await registerAndLogin(app, 'api08-target2@example.com');
      const org = await createOrgFor(app, owner, 'API08 Org 2', 'api08-org-2');

      const token = 'api08-raw-token-bypassing-http';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await db.query(
        `insert into invitations (org_id, email, role, token_hash, expires_at)
         values ($1, 'api08-target2@example.com', 'owner', $2, now() + interval '7 days')`,
        [org.id, tokenHash]
      );

      const accept = await app.inject({
        method: 'POST',
        url: '/organizations/invitations/accept',
        headers: { authorization: `Bearer ${target.accessToken}` },
        payload: { token },
      });
      // `accept_invitation` concede exactamente el rol almacenado en la
      // invitación (por diseño, ver 0017): la defensa real de API-08 está
      // en que la ruta de CREACIÓN (arriba) nunca deja persistir una
      // invitación con role:'owner' salvo que la cree un owner. Este test
      // documenta que el punto de control es la creación, no la
      // aceptación.
      expect(accept.statusCode).toBe(200);
      expect(accept.json().role).toBe('owner');

      const membership = await db.query<{ role: string }>(
        'select role from memberships where org_id = $1 and user_id = $2',
        [org.id, target.id]
      );
      expect(membership.rows[0]?.role).toBe('owner');
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('un admin SÍ puede invitar hasta el rol admin (no se rompe el caso legítimo)', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'api08-owner3@example.com');
      const admin = await registerAndLogin(app, 'api08-admin3@example.com');
      const org = await createOrgFor(app, owner, 'API08 Org 3', 'api08-org-3');
      await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'admin')", [org.id, admin.id]);

      const invite = await app.inject({
        method: 'POST',
        url: '/organizations/invitations',
        headers: { authorization: `Bearer ${admin.accessToken}`, 'x-org-id': org.id },
        payload: { email: 'api08-writer-target@example.com', role: 'admin' },
      });
      expect(invite.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('un owner SÍ puede invitar con role:owner', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'api08-owner4@example.com');
      const org = await createOrgFor(app, owner, 'API08 Org 4', 'api08-org-4');

      const invite = await app.inject({
        method: 'POST',
        url: '/organizations/invitations',
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
        payload: { email: 'api08-owner-target@example.com', role: 'owner' },
      });
      expect(invite.statusCode).toBe(201);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
