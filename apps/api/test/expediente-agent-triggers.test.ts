import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';
import { triggerNamedAgentRun } from '../src/lib/agent-triggers.js';

/**
 * Ronda 6 (completar ciclo redactor_borrador): verifica que
 *  1. subir un documento de "bases" con texto extraído dispara
 *     `analista_bases` (agent_runs + job `run_agent`) dentro de la MISMA
 *     transacción de subida (ver documents.routes.ts).
 *  2. construir la matriz de requisitos (`/matrix/build`) dispara
 *     `redactor_borrador` con `sectionKeys` derivadas de
 *     `deriveSectionKeysFromRequirementMatrix` (@atiende/expediente).
 *  3. `triggerNamedAgentRun` (lib/agent-triggers.ts) deduplica por
 *     eventKey igual que `JobQueue.enqueue` del worker.
 */

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function createTender(app: FastifyInstance, orgId: string, externalId = 'agt-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Servicio de mantenimiento', sourceVersion: 'v1' }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('ciclo analista_bases -> redactor_borrador (Ronda 6)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('subir un documento de bases con texto extraído dispara analista_bases (agent_runs + jobs run_agent, misma transacción)', async () => {
    const owner = await registerAndLogin(app, 'agt-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Agent Trigger Org 1', 'agt-org-1');
    const tenderId = await createTender(app, org.id, 'agt-001');

    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: {
        documentKind: 'bases',
        filename: 'bases.txt',
        mimeType: 'text/plain',
        contentBase64: toBase64('Es obligatorio presentar el Anexo 1 firmado a mas tardar el 01 de enero de 2027.'),
      },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');
    const documentId = upload.json().id;

    const runs = await db.query<{ id: string; agent_name: string; status: string; org_id: string; correlation_id: string | null; actor_id: string }>(
      `select id, agent_name, status, org_id, correlation_id, actor_id from agent_runs where org_id = $1`,
      [org.id]
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].agent_name).toBe('analista_bases');
    expect(runs.rows[0].status).toBe('running');
    expect(runs.rows[0].correlation_id).toBe(tenderId);
    expect(runs.rows[0].actor_id).toBe(owner.id);

    const jobs = await db.query<{ payload: { agentName: string; agentRunId: string; context: { tenderId: string }; jobKey: string } }>(
      `select payload from jobs where kind = 'run_agent' and org_id = $1`,
      [org.id]
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].payload.agentName).toBe('analista_bases');
    expect(jobs.rows[0].payload.agentRunId).toBe(runs.rows[0].id);
    expect(jobs.rows[0].payload.context.tenderId).toBe(tenderId);
    expect(jobs.rows[0].payload.jobKey).toBe(`run_agent:analista_bases:document:${documentId}`);
  });

  it('un documento de bases sin texto extraíble (queda "failed") NUNCA dispara analista_bases', async () => {
    const owner = await registerAndLogin(app, 'agt-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Agent Trigger Org 2', 'agt-org-2');
    const tenderId = await createTender(app, org.id, 'agt-002');

    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'vacio.txt', mimeType: 'text/plain', contentBase64: toBase64('   ') },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('failed');

    const runs = await db.query(`select 1 from agent_runs where org_id = $1 and agent_name = 'analista_bases'`, [org.id]);
    expect(runs.rows).toHaveLength(0);
    const jobs = await db.query(`select 1 from jobs where kind = 'run_agent' and org_id = $1`, [org.id]);
    expect(jobs.rows).toHaveLength(0);
  });

  it('un documento que NO es de "bases" (p. ej. "anexo") nunca dispara analista_bases', async () => {
    const owner = await registerAndLogin(app, 'agt-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Agent Trigger Org 3', 'agt-org-3');
    const tenderId = await createTender(app, org.id, 'agt-003');

    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: {
        documentKind: 'anexo',
        filename: 'anexo.txt',
        mimeType: 'text/plain',
        contentBase64: toBase64('Es obligatorio presentar el Anexo 1 firmado.'),
      },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');

    const runs = await db.query(`select 1 from agent_runs where org_id = $1 and agent_name = 'analista_bases'`, [org.id]);
    expect(runs.rows).toHaveLength(0);
  });

  it('construir la matriz de requisitos con ítems reales dispara redactor_borrador con sectionKeys derivadas', async () => {
    const owner = await registerAndLogin(app, 'agt-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Agent Trigger Org 4', 'agt-org-4');
    const tenderId = await createTender(app, org.id, 'agt-004');

    await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: {
        documentKind: 'bases',
        filename: 'bases.txt',
        mimeType: 'text/plain',
        contentBase64: toBase64('Es obligatorio presentar el Anexo 1 firmado a mas tardar el 01 de enero de 2027.'),
      },
    });

    const build = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/matrix/build`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(build.statusCode).toBe(200);
    expect(build.json().itemsCreated).toBeGreaterThan(0);

    const runs = await db.query<{ agent_name: string; input: { tenderId: string; sectionKeys: string[] } }>(
      `select agent_name, input from agent_runs where org_id = $1 and agent_name = 'redactor_borrador'`,
      [org.id]
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].input.tenderId).toBe(tenderId);
    expect(runs.rows[0].input.sectionKeys).toEqual(['anexos']);

    const jobs = await db.query<{ payload: { agentName: string; context: { sectionKeys: string[] }; jobKey: string } }>(
      `select payload from jobs where kind = 'run_agent' and org_id = $1 and payload ->> 'agentName' = 'redactor_borrador'`,
      [org.id]
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].payload.context.sectionKeys).toEqual(['anexos']);
    expect(jobs.rows[0].payload.jobKey).toBe(`run_agent:redactor_borrador:matrix:${tenderId}`);
  });

  it('una matriz sin ítems (documentsUsed: 0) nunca dispara redactor_borrador (sectionKeys vacío)', async () => {
    const owner = await registerAndLogin(app, 'agt-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Agent Trigger Org 5', 'agt-org-5');
    const tenderId = await createTender(app, org.id, 'agt-005');

    const build = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/matrix/build`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(build.statusCode).toBe(200);
    expect(build.json().itemsCreated).toBe(0);

    const runs = await db.query(`select 1 from agent_runs where org_id = $1 and agent_name = 'redactor_borrador'`, [org.id]);
    expect(runs.rows).toHaveLength(0);
  });

  it('reconstruir la matriz DOS VECES (misma convocatoria) dedupica: mientras la corrida anterior sigue activa no abre una segunda', async () => {
    const owner = await registerAndLogin(app, 'agt-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'Agent Trigger Org 6', 'agt-org-6');
    const tenderId = await createTender(app, org.id, 'agt-006');

    await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: {
        documentKind: 'bases',
        filename: 'bases.txt',
        mimeType: 'text/plain',
        contentBase64: toBase64('Es obligatorio presentar el Anexo 1 firmado a mas tardar el 01 de enero de 2027.'),
      },
    });

    const firstBuild = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/matrix/build`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(firstBuild.statusCode).toBe(200);

    // La corrida anterior sigue "running" (nadie procesó el job todavía en
    // esta prueba, sin worker real levantado) -- una segunda reconstrucción
    // con el MISMO evento (`matrix:<tenderId>`) reutiliza el job existente
    // en vez de abrir una segunda corrida activa.
    const secondBuild = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/matrix/build`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(secondBuild.statusCode).toBe(200);

    const runs = await db.query(`select 1 from agent_runs where org_id = $1 and agent_name = 'redactor_borrador'`, [org.id]);
    expect(runs.rows).toHaveLength(1);
    const jobs = await db.query(`select 1 from jobs where org_id = $1 and kind = 'run_agent' and payload ->> 'agentName' = 'redactor_borrador'`, [org.id]);
    expect(jobs.rows).toHaveLength(1);
  });
});

describe('triggerNamedAgentRun (lib/agent-triggers.ts) — dedupe por eventKey', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function seedWriter(slug: string): Promise<{ orgId: string; userId: string }> {
    const { rows } = await db.query<{ id: string }>("insert into organizations (name, slug) values ('t', $1) returning id", [slug]);
    const orgId = rows[0].id;
    const { rows: userRows } = await db.query<{ id: string }>(
      "insert into users (id, email, password_hash) values (gen_random_uuid(), $1, 'x') returning id",
      [`${slug}@example.com`]
    );
    const userId = userRows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [orgId, userId]);
    return { orgId, userId };
  }

  async function withAppRoleTx<T>(orgId: string, userId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
      return fn(tx as unknown as DbClient);
    });
  }

  it('inserta agent_runs (status running) + jobs (kind run_agent) atados por agentRunId', async () => {
    const { orgId, userId } = await seedWriter('trig-org-1');

    const result = await withAppRoleTx(orgId, userId, (tx) =>
      triggerNamedAgentRun(tx, {
        orgId,
        actorId: userId,
        actorRole: 'writer',
        agentName: 'analista_bases',
        context: { tenderId: 'tender-x' },
        correlationId: 'corr-1',
        eventKey: 'document:doc-1',
      })
    );
    expect(result.deduped).toBe(false);
    expect(result.agentRunId).toBeTruthy();

    const run = await db.query('select * from agent_runs where id = $1', [result.agentRunId]);
    expect(run.rows[0].status).toBe('running');
    expect(run.rows[0].agent_name).toBe('analista_bases');
    expect(run.rows[0].actor_id).toBe(userId);
    expect(run.rows[0].correlation_id).toBe('corr-1');

    const job = await db.query<{ kind: string; payload: { agentRunId: string; agentName: string } }>('select kind, payload from jobs where id = $1', [result.jobId]);
    expect(job.rows[0].kind).toBe('run_agent');
    expect(job.rows[0].payload.agentName).toBe('analista_bases');
    expect(job.rows[0].payload.agentRunId).toBe(result.agentRunId);
  });

  it('dos llamadas con el MISMO eventKey mientras el job anterior sigue queued/running: la segunda deduplica (no abre una segunda corrida)', async () => {
    const { orgId, userId } = await seedWriter('trig-org-2');
    const params = {
      orgId,
      actorId: userId,
      actorRole: 'writer' as const,
      agentName: 'redactor_borrador' as const,
      context: { tenderId: 'tender-y', sectionKeys: ['tecnica'] },
      correlationId: 'tender-y',
      eventKey: 'matrix:tender-y',
    };
    const first = await withAppRoleTx(orgId, userId, (tx) => triggerNamedAgentRun(tx, params));
    const second = await withAppRoleTx(orgId, userId, (tx) => triggerNamedAgentRun(tx, params));

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(second.agentRunId).toBe(first.agentRunId);

    const runs = await db.query('select count(*)::int as c from agent_runs where org_id = $1', [orgId]);
    expect(runs.rows[0].c).toBe(1);
  });

  it('si el job anterior YA terminó (succeeded), la MISMA eventKey sí dispara una corrida nueva', async () => {
    const { orgId, userId } = await seedWriter('trig-org-3');
    const params = {
      orgId,
      actorId: userId,
      actorRole: 'writer' as const,
      agentName: 'analista_bases' as const,
      context: { tenderId: 'tender-z' },
      correlationId: 'tender-z',
      eventKey: 'document:doc-z',
    };
    const first = await withAppRoleTx(orgId, userId, (tx) => triggerNamedAgentRun(tx, params));
    await db.query("update jobs set status = 'succeeded' where id = $1", [first.jobId]);
    await db.query("update agent_runs set status = 'succeeded' where id = $1", [first.agentRunId]);

    const second = await withAppRoleTx(orgId, userId, (tx) => triggerNamedAgentRun(tx, params));
    expect(second.deduped).toBe(false);
    expect(second.jobId).not.toBe(first.jobId);
    expect(second.agentRunId).not.toBe(first.agentRunId);

    const runs = await db.query('select count(*)::int as c from agent_runs where org_id = $1', [orgId]);
    expect(runs.rows[0].c).toBe(2);
  });
});
