import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

async function seedPendingToolCall(db: DbClient, orgId: string): Promise<string> {
  const run = await db.query<{ id: string }>("insert into agent_runs (org_id, agent_name) values ($1, 'test-agent') returning id", [orgId]);
  const tc = await db.query<{ id: string }>(
    "insert into tool_calls (org_id, agent_run_id, tool_name) values ($1, $2, 'search') returning id",
    [orgId, run.rows[0].id]
  );
  return tc.rows[0].id;
}

/**
 * Ronda 4, item 3 (docs/logs/api-ronda4.log): apps/web (README) señaló que
 * `GET /admin/approvals` lista tool_calls pendientes de TODAS las
 * organizaciones, pero aprobar/denegar de verdad exigía `X-Org-Id` + rol
 * owner/admin DE ESA organización -- un superadmin no necesariamente lo es,
 * dejando la pantalla de solo lectura. `POST /admin/tool-calls/:id/approve|deny`
 * gatea por `app.requireSuperadmin` (platform_admins), cross-org, sin
 * `X-Org-Id`.
 */
describe('POST /admin/tool-calls/:id/approve|deny (ronda 4, superadmin cross-org)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un usuario normal (no superadmin) recibe 403 en approve y en deny', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 1', 'atc-org-1');
    const toolCallId = await seedPendingToolCall(db, org.id);

    const approve = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(approve.statusCode).toBe(403);

    const deny = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/deny`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(deny.statusCode).toBe(403);
  });

  it('un superadmin (sin ser owner/admin de la organización dueña) SÍ puede aprobar cross-org, y queda en audit_log con la org afectada', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 2', 'atc-org-2');
    const toolCallId = await seedPendingToolCall(db, org.id);

    const superadminUser = await registerAndLogin(app, 'atc-superadmin-2@example.com');
    await makeSuperadmin(db, superadminUser.id);
    // Verifica explícitamente que el superadmin NO es miembro de la organización dueña.
    const membership = await db.query('select 1 from memberships where org_id = $1 and user_id = $2', [org.id, superadminUser.id]);
    expect(membership.rows.length).toBe(0);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationStatus).toBe('approved');

    const audit = await db.query(
      "select org_id, actor_id, action from audit_log where entity = 'tool_calls' and entity_id = $1 and action = 'admin.tool_call.approve'",
      [toolCallId]
    );
    expect(audit.rows.length).toBe(1);
    expect((audit.rows[0] as any).org_id).toBe(org.id);
    expect((audit.rows[0] as any).actor_id).toBe(superadminUser.id);
  });

  it('doble aprobación de la MISMA tool_call responde 409 en el segundo intento', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 3', 'atc-org-3');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-3@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const headers = { authorization: `Bearer ${superadminUser.accessToken}` };

    const first = await app.inject({ method: 'POST', url: `/admin/tool-calls/${toolCallId}/approve`, headers });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: `/admin/tool-calls/${toolCallId}/approve`, headers });
    expect(second.statusCode).toBe(409);
  });

  it('deny también funciona cross-org para un superadmin', async () => {
    const owner = await registerAndLogin(app, 'atc-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'ATC Org 4', 'atc-org-4');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-4@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/deny`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationStatus).toBe('denied');
  });

  it('una tool_call inexistente responde 404', async () => {
    const superadminUser = await registerAndLogin(app, 'atc-superadmin-5@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${'00000000-0000-0000-0000-000000000000'}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
