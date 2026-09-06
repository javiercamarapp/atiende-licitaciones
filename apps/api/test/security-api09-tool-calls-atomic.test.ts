import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * API-09 (docs/auditoria-1/db-api-reverificacion.md) — mitad de tool_calls:
 * `POST /agents/tool-calls/:id/approve|deny` hacía SELECT (verifica
 * `authorization_status='pending'`) y luego UPDATE en pasos separados
 * dentro de la misma transacción, pero el UPDATE no repetía la condición
 * `authorization_status='pending'` en su propio `WHERE` -- el único guard
 * real era el SELECT previo. Bajo un pool de conexiones físicas reales
 * (`pg.Pool({max:10})`, producción) dos peticiones concurrentes podían
 * ambas pasar el SELECT antes de que cualquiera hiciera el UPDATE
 * (TOCTOU). Este archivo prueba la versión atómica: el propio UPDATE trae
 * `AND authorization_status = 'pending'`, así que el resultado es correcto
 * incluso si el SELECT de diagnóstico se ejecutara con información
 * obsoleta.
 */
async function seedPendingToolCall(app: FastifyInstance, db: DbClient, orgId: string, ownerId: string): Promise<string> {
  const { rows: runRows } = await db.query<{ id: string }>(
    "insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, total_steps) values ($1, 'redactor', $2, 'writer', 'needs_approval', 1) returning id",
    [orgId, ownerId]
  );
  const { rows: toolCallRows } = await db.query<{ id: string }>(
    `insert into tool_calls (org_id, agent_run_id, tool_name, authorization_status, input_hash, status)
     values ($1, $2, 'send_proposal_draft', 'pending', 'x', 'pending_approval') returning id`,
    [orgId, runRows[0].id]
  );
  return toolCallRows[0].id;
}

describe('API-09 — aprobación/denegación de tool_calls es atómica (check-then-act sin ventana TOCTOU)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('dos aprobaciones concurrentes de la MISMA tool_call: exactamente una tiene éxito (200), la otra 409 -- nunca las dos 200', async () => {
    const owner = await registerAndLogin(app, 'api09-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'API09 Org 1', 'api09-org-1');
    const toolCallId = await seedPendingToolCall(app, db, org.id, owner.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/agents/tool-calls/${toolCallId}/approve`, headers }),
      app.inject({ method: 'POST', url: `/agents/tool-calls/${toolCallId}/approve`, headers }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // El estado final es consistente (approved), y solo UNA fila de audit_log.
    const row = await db.query<{ authorization_status: string }>('select authorization_status from tool_calls where id = $1', [toolCallId]);
    expect(row.rows[0].authorization_status).toBe('approved');
    const audit = await db.query("select count(*)::int as count from audit_log where entity = 'tool_calls' and action = 'tool_call.approve' and entity_id = $1", [toolCallId]);
    expect(audit.rows[0].count).toBe(1);
  });

  it('approve y deny concurrentes de la MISMA tool_call: exactamente uno tiene éxito, nunca ambos', async () => {
    const owner = await registerAndLogin(app, 'api09-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'API09 Org 2', 'api09-org-2');
    const toolCallId = await seedPendingToolCall(app, db, org.id, owner.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const [approve, deny] = await Promise.all([
      app.inject({ method: 'POST', url: `/agents/tool-calls/${toolCallId}/approve`, headers }),
      app.inject({ method: 'POST', url: `/agents/tool-calls/${toolCallId}/deny`, headers }),
    ]);
    const codes = [approve.statusCode, deny.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const row = await db.query<{ authorization_status: string }>('select authorization_status from tool_calls where id = $1', [toolCallId]);
    expect(['approved', 'denied']).toContain(row.rows[0].authorization_status);
  });
});
