import { describe, it, expect } from 'vitest';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * Patrón Likida/atiende.ai #6 (auditoría del intento de acceso denegado
 * por rol): el mapa explícito de qué ruta puede ver cada rol YA existe y
 * YA se refuerza en la aplicación además de RLS (`requireOrgRole`/
 * `APPROVER_ROLES`/`MEMBERSHIP_ADMIN_ROLES`, `app.requireSuperadmin`) --
 * pero, antes de este patrón, ningún `ForbiddenError` (403) dejaba rastro
 * en `audit_log`, solo el log efímero de la request. Verifica que
 * `plugins/error-handler.ts` (vía `lib/audit.ts::recordAccessDenied`)
 * cierra esa brecha para los tres puntos de la auditoría original:
 * `approval.routes.ts`, `organizations/routes.ts` y
 * `superadmin.plugin.ts` -- además del caso de `app.requireOrg` negando
 * por falta de membresía, que corre ANTES de que exista contexto de org.
 *
 * Cada `it` abre su PROPIA app (`createTestApp`) en vez de compartir una
 * sola vía `beforeAll` -- mismo criterio que el tercer caso de
 * `audit-api02-role-escalation.test.ts`: `/auth/login` tiene un rate
 * limit de 5/min por IP compartido dentro de una misma app, y este
 * archivo hace varios `registerAndLogin` por caso.
 */

interface AccessDeniedRow {
  org_id: string | null;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  after: { method?: string; statusCode?: number; message?: string } | null;
  request_id: string | null;
}

async function accessDeniedRowsFor(db: DbClient, actorId: string): Promise<AccessDeniedRow[]> {
  const { rows } = await db.query<AccessDeniedRow>(
    "select org_id, actor_id, action, entity, entity_id, after, request_id from audit_log where action = 'access.denied' and actor_id = $1 order by created_at asc",
    [actorId]
  );
  return rows;
}

describe('Patrón #6: auditoría del intento de acceso denegado por rol', () => {
  it('un 403 por rol insuficiente dentro de una organización (MEMBERSHIP_ADMIN_ROLES) queda en audit_log con org_id, actor y la ruta', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'p6-owner@example.com');
      const viewer = await registerAndLogin(app, 'p6-viewer@example.com');
      const org = await createOrgFor(app, owner, 'Patrón 6 Org', 'p6-org-1');
      await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

      const res = await app.inject({
        method: 'POST',
        url: '/organizations/invitations',
        headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
        payload: { email: 'nuevo@example.com', role: 'viewer' },
      });
      expect(res.statusCode).toBe(403);

      const rows = await accessDeniedRowsFor(db, viewer.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].org_id).toBe(org.id);
      expect(rows[0].entity).toBe('/organizations/invitations');
      expect(rows[0].after?.method).toBe('POST');
      expect(rows[0].after?.statusCode).toBe(403);
      expect(rows[0].request_id).toBeTruthy();
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('un 403 de superadmin (app.requireSuperadmin, sin contexto de org) queda en audit_log con org_id = null', async () => {
    const { app, db } = await createTestApp();
    try {
      const plainUser = await registerAndLogin(app, 'p6-not-superadmin@example.com');

      const res = await app.inject({
        method: 'GET',
        url: '/admin/organizations',
        headers: { authorization: `Bearer ${plainUser.accessToken}` },
      });
      expect(res.statusCode).toBe(403);

      const rows = await accessDeniedRowsFor(db, plainUser.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].org_id).toBeNull();
      expect(rows[0].entity).toBe('/admin/organizations');
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('un 403 de app.requireOrg por falta de membresía (ANTES de que exista request.orgId) también queda en audit_log', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'p6-owner2@example.com');
      const outsider = await registerAndLogin(app, 'p6-outsider@example.com');
      const org = await createOrgFor(app, owner, 'Patrón 6 Org 2', 'p6-org-2');

      // `outsider` nunca fue agregado como miembro de `org`.
      const res = await app.inject({
        method: 'GET',
        url: '/company/profile',
        headers: { authorization: `Bearer ${outsider.accessToken}`, 'x-org-id': org.id },
      });
      expect(res.statusCode).toBe(403);

      const rows = await accessDeniedRowsFor(db, outsider.id);
      expect(rows).toHaveLength(1);
      // request.orgId nunca se fija en este camino (requireOrg deniega
      // antes de asignarlo) -- el org_id se recupera del encabezado
      // X-Org-Id como mejor esfuerzo, sin que eso implique que `outsider`
      // SÍ es miembro.
      expect(rows[0].org_id).toBe(org.id);
      expect(rows[0].entity).toBe('/company/profile');
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('un 409 (conflicto, NO un 403 de rol) no genera ninguna fila access.denied: el criterio es el código de estado 403, no "la ruta falló"', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'p6-owner3@example.com');
      const org = await createOrgFor(app, owner, 'Patrón 6 Org 3', 'p6-org-3');

      // El propio (único) owner degradándose a sí mismo: bloqueado por la
      // protección de "último owner" -- 409, no 403 (ver
      // audit-api02-role-escalation.test.ts). Confirma que
      // `recordAccessDenied` solo dispara para `statusCode === 403`.
      const res = await app.inject({
        method: 'PATCH',
        url: `/organizations/memberships/${owner.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
        payload: { role: 'viewer' },
      });
      expect(res.statusCode).toBe(409);

      const rows = await accessDeniedRowsFor(db, owner.id);
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('una request exitosa (200/201) NO genera ninguna fila access.denied para ese actor', async () => {
    const { app, db } = await createTestApp();
    try {
      const owner = await registerAndLogin(app, 'p6-owner4@example.com');
      await createOrgFor(app, owner, 'Patrón 6 Org 4', 'p6-org-4');

      const res = await app.inject({
        method: 'GET',
        url: '/organizations',
        headers: { authorization: `Bearer ${owner.accessToken}` },
      });
      expect(res.statusCode).toBe(200);

      const rows = await accessDeniedRowsFor(db, owner.id);
      expect(rows).toHaveLength(0);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
