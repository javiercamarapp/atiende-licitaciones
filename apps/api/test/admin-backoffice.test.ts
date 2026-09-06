import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

describe('back office / superadmin (E10)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un usuario normal recibe 403 en cualquier ruta /admin/*; superadmin ve datos reales', async () => {
    const normalUser = await registerAndLogin(app, 'admin-normal-1@example.com');
    const org = await createOrgFor(app, normalUser, 'Admin Org 1', 'admin-org-1');

    const forbidden = await app.inject({
      method: 'GET',
      url: '/admin/organizations',
      headers: { authorization: `Bearer ${normalUser.accessToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    await makeSuperadmin(db, normalUser.id);
    const allowed = await app.inject({
      method: 'GET',
      url: '/admin/organizations',
      headers: { authorization: `Bearer ${normalUser.accessToken}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().some((o: any) => o.id === org.id)).toBe(true);
  });

  it('GET /admin/connectors/freshness expone el estado explícito de source_runs (nunca lista vacía silenciosa, A4)', async () => {
    const superadminUser = await registerAndLogin(app, 'admin-superadmin-2@example.com');
    await makeSuperadmin(db, superadminUser.id);

    await db.query(
      "insert into source_runs (source_id, status, coverage) values ('compras-mx', 'captcha', '{\"expected\": 50, \"obtained\": 0}'::jsonb)"
    );

    const res = await app.inject({
      method: 'GET',
      url: '/admin/connectors/freshness',
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const entry = res.json().find((r: any) => r.sourceId === 'compras-mx');
    expect(entry.status).toBe('captcha');
    expect(entry.isStale).toBe(true);
    expect(entry.lastSuccessAt).toBeNull();
  });

  it('jobs: listar y reintentar un job fallido lo regresa a queued', async () => {
    const superadminUser = await registerAndLogin(app, 'admin-superadmin-3@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const { rows } = await db.query<{ id: string }>(
      "insert into jobs (kind, status, last_error) values ('ingest', 'dead', 'timeout') returning id"
    );

    const list = await app.inject({
      method: 'GET',
      url: '/admin/jobs?status=dead',
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(list.json().length).toBe(1);

    const retry = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${rows[0].id}/retry`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe('queued');
  });

  it('costos por organización: agregado real desde agent_runs, marcado explícitamente como estimado', async () => {
    const owner = await registerAndLogin(app, 'admin-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Admin Org 4', 'admin-org-4');
    const superadminUser = await registerAndLogin(app, 'admin-superadmin-4@example.com');
    await makeSuperadmin(db, superadminUser.id);

    await db.query(
      "insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, total_steps, estimated_cost_usd) values ($1, 'redactor', $2, 'owner', 'completed', 1, 1.25)",
      [org.id, owner.id]
    );

    const res = await app.inject({
      method: 'GET',
      url: '/admin/costs',
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    const entry = res.json().find((r: any) => r.orgId === org.id);
    expect(entry.totalEstimatedCostUsd).toBe(1.25);
    expect(entry.estimated).toBe(true);
  });

  it('incidentes: crear y resolver; un usuario normal no puede', async () => {
    const normalUser = await registerAndLogin(app, 'admin-normal-5@example.com');
    const superadminUser = await registerAndLogin(app, 'admin-superadmin-5@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/admin/incidents',
      headers: { authorization: `Bearer ${normalUser.accessToken}` },
      payload: { title: 'Intento no autorizado' },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/admin/incidents',
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
      payload: { title: 'Fuente ComprasMX caída', severity: 'high' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('open');

    const resolved = await app.inject({
      method: 'POST',
      url: `/admin/incidents/${created.json().id}/resolve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('resolved');
  });

  it('aprobaciones pendientes: el back office ve tool_calls pendientes de TODAS las organizaciones', async () => {
    const ownerA = await registerAndLogin(app, 'admin-owner-6a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Admin Org 6A', 'admin-org-6a');
    const superadminUser = await registerAndLogin(app, 'admin-superadmin-6@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const { rows: runRows } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, total_steps) values ($1, 'redactor', $2, 'owner', 'needs_approval', 1) returning id",
      [orgA.id, ownerA.id]
    );
    await db.query(
      "insert into tool_calls (org_id, agent_run_id, tool_name, authorization_status, input_hash) values ($1, $2, 'emit_final_package', 'pending', 'x')",
      [orgA.id, runRows[0].id]
    );

    const res = await app.inject({
      method: 'GET',
      url: '/admin/approvals',
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().some((a: any) => a.orgId === orgA.id && a.toolName === 'emit_final_package')).toBe(true);
  });
});
