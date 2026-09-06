import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor } from './helpers.js';

async function seedPendingToolCall(db: DbClient, orgId: string): Promise<string> {
  const run = await db.query<{ id: string }>("insert into agent_runs (org_id, agent_name) values ($1, 'test-agent') returning id", [orgId]);
  const tc = await db.query<{ id: string }>(
    "insert into tool_calls (org_id, agent_run_id, tool_name) values ($1, $2, 'search') returning id",
    [orgId, run.rows[0].id]
  );
  return tc.rows[0].id;
}

/**
 * R5-11 (docs/auditoria-2/api-r5-09-10-reverificacion.md, BAJA-MEDIA):
 * `tool_call.approval`/`admin.action` existían en `STEP_UP_PURPOSES` desde
 * R5-09, pero ningún endpoint real los exigía -- aprobar o denegar una
 * `tool_call` (puede autorizar gasto/envío/uso de API en nombre de la
 * organización) no pedía ninguna verificación en dos pasos. Este archivo
 * cubre el caso ORG-SCOPED (`POST /agents/tool-calls/:id/approve|deny`,
 * `purpose: 'tool_call.approval'`); el caso cross-org de superadmin
 * (`purpose: 'admin.action'`) está cubierto en
 * `ronda4-admin-tool-calls.test.ts`.
 */
describe('R5-11 — step-up (purpose tool_call.approval) en POST /agents/tool-calls/:id/approve|deny', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('sin 2FA enrolado, aprobar una tool_call responde 403 con instrucción explícita de enrolar', async () => {
    const owner = await registerAndLogin(app, 'r511-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'R511 Org 1', 'r511-org-1');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const approve = await app.inject({ method: 'POST', url: `/agents/tool-calls/${toolCallId}/approve`, headers });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().title).toContain('POST /auth/2fa/enroll');

    const row = await db.query<{ authorization_status: string }>('select authorization_status from tool_calls where id = $1', [toolCallId]);
    expect(row.rows[0].authorization_status).toBe('pending');
  });

  it('enrolado pero SIN X-Step-Up, denegar una tool_call responde 403 pidiendo el encabezado', async () => {
    const owner = await registerAndLogin(app, 'r511-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'R511 Org 2', 'r511-org-2');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'tool_call.approval' });

    const deny = await app.inject({ method: 'POST', url: `/agents/tool-calls/${toolCallId}/deny`, headers });
    expect(deny.statusCode).toBe(403);
    expect(deny.json().title).toContain('X-Step-Up');
  });

  it('un stepUpToken con purpose incorrecto (p.ej. company.rate_approval en lugar de tool_call.approval) es rechazado con 403', async () => {
    const owner = await registerAndLogin(app, 'r511-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'R511 Org 3', 'r511-org-3');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });

    const approve = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { ...headers, 'x-step-up': stepUpToken },
    });
    expect(approve.statusCode).toBe(403);

    const row = await db.query<{ authorization_status: string }>('select authorization_status from tool_calls where id = $1', [toolCallId]);
    expect(row.rows[0].authorization_status).toBe('pending');
  });

  it('un stepUpToken atado a OTRA organización es rechazado con 403, aunque el purpose coincida', async () => {
    const owner = await registerAndLogin(app, 'r511-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'R511 Org 4', 'r511-org-4');
    const otherOrg = await createOrgFor(app, owner, 'R511 Org 4b', 'r511-org-4b');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: otherOrg.id, purpose: 'tool_call.approval' });

    const approve = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { ...headers, 'x-step-up': stepUpToken },
    });
    expect(approve.statusCode).toBe(403);
  });

  it('con X-Step-Up vigente y purpose correcto, aprobar una tool_call responde 200 y la sesión queda consumida (un solo uso)', async () => {
    const owner = await registerAndLogin(app, 'r511-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'R511 Org 5', 'r511-org-5');
    const toolCallId = await seedPendingToolCall(db, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'tool_call.approval' });

    const approve = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { ...headers, 'x-step-up': stepUpToken },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().authorizationStatus).toBe('approved');

    const session = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [stepUpToken]);
    expect(session.rows[0].consumed_at).not.toBeNull();

    // Reusar el MISMO stepUpToken en una segunda tool_call falla (de un solo uso).
    const secondToolCallId = await seedPendingToolCall(db, org.id);
    const reuse = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${secondToolCallId}/approve`,
      headers: { ...headers, 'x-step-up': stepUpToken },
    });
    expect(reuse.statusCode).toBe(403);
  });
});
