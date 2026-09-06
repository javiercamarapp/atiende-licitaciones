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
 * Ronda 4, item 5 (docs/logs/api-ronda4.log): un POST sin cuerpo con
 * `Content-Type: application/json` sigue respondiendo 400 en general
 * (comportamiento correcto -- se mantiene), pero las rutas de ACCIÓN que
 * NUNCA esperan cuerpo (approve/deny/retry/resolve) ahora lo toleran
 * explícitamente (ver `lib/optional-empty-body.ts`).
 */
describe('POST sin cuerpo con Content-Type: application/json (ronda 4)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('POST /organizations (SÍ exige cuerpo real) sigue respondiendo 400 con Content-Type: application/json y cuerpo vacío', async () => {
    const owner = await registerAndLogin(app, 'eb-owner-1@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/organizations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /agents/tool-calls/:id/approve acepta Content-Type: application/json con cuerpo vacío (200, no 400)', async () => {
    const owner = await registerAndLogin(app, 'eb-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'EB Org 2', 'eb-org-2');
    const toolCallId = await seedPendingToolCall(db, org.id);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorizationStatus).toBe('approved');
  });

  it('POST /agents/tool-calls/:id/deny acepta cuerpo vacío con Content-Type: application/json', async () => {
    const owner = await registerAndLogin(app, 'eb-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'EB Org 3', 'eb-org-3');
    const toolCallId = await seedPendingToolCall(db, org.id);

    const res = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/deny`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /admin/jobs/:id/retry acepta cuerpo vacío con Content-Type: application/json', async () => {
    const superadminUser = await registerAndLogin(app, 'eb-superadmin-4@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const job = await db.query<{ id: string }>("insert into jobs (kind, status) values ('test-job', 'failed') returning id");

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.rows[0].id}/retry`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('queued');
  });

  it('POST /admin/incidents/:id/resolve acepta cuerpo vacío con Content-Type: application/json', async () => {
    const superadminUser = await registerAndLogin(app, 'eb-superadmin-5@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const incident = await db.query<{ id: string }>("insert into incidents (title) values ('Incidente EB') returning id");

    const res = await app.inject({
      method: 'POST',
      url: `/admin/incidents/${incident.rows[0].id}/resolve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('resolved');
  });

  it('POST /admin/incidents (SÍ exige cuerpo real, en el MISMO archivo que /resolve) sigue rechazando cuerpo vacío', async () => {
    const superadminUser = await registerAndLogin(app, 'eb-superadmin-6@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const res = await app.inject({
      method: 'POST',
      url: '/admin/incidents',
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /admin/tool-calls/:id/approve|deny (cross-org) también aceptan cuerpo vacío con Content-Type: application/json', async () => {
    const owner = await registerAndLogin(app, 'eb-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'EB Org 7', 'eb-org-7');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const superadminUser = await registerAndLogin(app, 'eb-superadmin-7@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}`, 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
  });
});
