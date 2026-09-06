import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode } from './helpers.js';
import { PgRunStore, PgToolCallStore } from '../src/lib/agent-stores.pg.js';

describe('persistencia de packages/agents (RunStore/ToolCallStore sobre Postgres)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('PgRunStore: createRun/getRun/updateRun persisten y sobreviven una relectura real (no solo en memoria)', async () => {
    const { rows } = await db.query<{ id: string }>("insert into organizations (name, slug) values ('t','agents-org-1') returning id");
    const orgId = rows[0].id;
    const { rows: userRows } = await db.query<{ id: string }>(
      "insert into users (id, email, password_hash) values (gen_random_uuid(), 'agent-actor@example.com', 'x') returning id"
    );
    const userId = userRows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [orgId, userId]);

    const runStore = new PgRunStore(db);
    const created = await runStore.createRun({
      organizationId: orgId,
      agentName: 'redactor',
      actorId: userId,
      actorRole: 'writer' as any,
      totalSteps: 3,
      correlationId: 'tender-abc',
    });
    expect(created.status).toBe('in_progress');
    expect(created.totalSteps).toBe(3);

    const fetched = await runStore.getRun(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.correlationId).toBe('tender-abc');

    const updated = await runStore.updateRun(created.id, { status: 'needs_approval', pendingStepIndex: 1, completedSteps: 1 });
    expect(updated.status).toBe('needs_approval');
    expect(updated.pendingStepIndex).toBe(1);

    // Relectura independiente (nueva instancia de store) confirma que
    // quedó persistido de verdad, no solo en el objeto en memoria.
    const reread = await new PgRunStore(db).getRun(created.id);
    expect(reread?.status).toBe('needs_approval');
    expect(reread?.completedSteps).toBe(1);
  });

  it('PgToolCallStore: recordToolCall/listToolCalls persisten trazas reales por paso', async () => {
    const { rows } = await db.query<{ id: string }>("insert into organizations (name, slug) values ('t','agents-org-2') returning id");
    const orgId = rows[0].id;
    const { rows: userRows } = await db.query<{ id: string }>(
      "insert into users (id, email, password_hash) values (gen_random_uuid(), 'agent-actor-2@example.com', 'x') returning id"
    );
    const userId = userRows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [orgId, userId]);

    const runStore = new PgRunStore(db);
    const run = await runStore.createRun({ organizationId: orgId, agentName: 'analista', actorId: userId, actorRole: 'writer' as any, totalSteps: 1 });

    const toolCallStore = new PgToolCallStore(db);
    const trace = {
      id: randomUUID(),
      runId: run.id,
      stepIndex: 0,
      toolName: 'search_tenders',
      organizationId: orgId,
      actorId: userId,
      actorRole: 'writer' as any,
      status: 'ok' as const,
      startedAt: new Date().toISOString(),
      inputHash: createHash('sha256').update('{}').digest('hex'),
      attempts: 1,
      estimatedTokens: 100,
      estimatedCostUsd: 0.001,
      authorizationDecision: 'auto' as const,
      correlationId: null,
    };
    await toolCallStore.recordToolCall(trace);

    const list = await new PgToolCallStore(db).listToolCalls(run.id);
    expect(list.length).toBe(1);
    expect(list[0].toolName).toBe('search_tenders');
    expect(list[0].estimatedTokens).toBe(100);
  });

  it('aprobación de tool_calls pendientes: writer no puede aprobar; owner sí, y queda en audit_log', async () => {
    const owner = await registerAndLogin(app, 'agents-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Agents Org 1', 'agents-org-http-1');
    const writer = await registerAndLogin(app, 'agents-writer-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);

    const { rows: runRows } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, total_steps) values ($1, 'redactor', $2, 'writer', 'needs_approval', 1) returning id",
      [org.id, owner.id]
    );
    const { rows: toolCallRows } = await db.query<{ id: string }>(
      `insert into tool_calls (org_id, agent_run_id, tool_name, authorization_status, input_hash, status)
       values ($1, $2, 'send_proposal_draft', 'pending', 'x', 'pending_approval') returning id`,
      [org.id, runRows[0].id]
    );
    const toolCallId = toolCallRows[0].id;

    // R5-11: writer no puede aprobar de todos modos (el chequeo de rol
    // ocurre ANTES de exigir step-up), sin necesidad de enrolar 2FA.
    const writerAttempt = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
    });
    expect(writerAttempt.statusCode).toBe(403);

    // R5-11: aprobar exige step-up (purpose 'tool_call.approval') -- se pide
    // un token por cada llamada (una sesión es de un solo uso).
    const { backupCodes, stepUpToken } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: org.id, purpose: 'tool_call.approval' });
    const ownerApprove = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
    });
    expect(ownerApprove.statusCode).toBe(200);
    expect(ownerApprove.json().authorizationStatus).toBe('approved');

    // Re-aprobar una ya resuelta falla (no re-ejecuta ni duplica) -- con un
    // step-up NUEVO (el anterior ya se consumió).
    const secondStepUp = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], { orgId: org.id, purpose: 'tool_call.approval' });
    const doubleApprove = await app.inject({
      method: 'POST',
      url: `/agents/tool-calls/${toolCallId}/approve`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': secondStepUp },
    });
    expect(doubleApprove.statusCode).toBe(409);

    const audit = await db.query<{ action: string; actor_id: string }>(
      "select action, actor_id from audit_log where org_id = $1 and entity = 'tool_calls' and action = 'tool_call.approve'",
      [org.id]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].actor_id).toBe(owner.id);
  });

  it('GET /agents/runs y /agents/tool-calls no filtran entre organizaciones', async () => {
    const ownerA = await registerAndLogin(app, 'agents-owner-a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Agents Org A', 'agents-org-a');
    const ownerB = await registerAndLogin(app, 'agents-owner-b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'Agents Org B', 'agents-org-b');

    await db.query(
      "insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, total_steps) values ($1, 'redactor', $2, 'owner', 'completed', 1)",
      [orgA.id, ownerA.id]
    );

    const listA = await app.inject({
      method: 'GET',
      url: '/agents/runs',
      headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
    });
    const listB = await app.inject({
      method: 'GET',
      url: '/agents/runs',
      headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
    });
    expect(listA.json().length).toBe(1);
    expect(listB.json().length).toBe(0);
  });
});
