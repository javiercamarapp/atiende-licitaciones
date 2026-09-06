import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * API-10 (docs/auditoria-1/db-api-reverificacion.md, MEDIA) —
 * `POST /admin/jobs/:id/retry` (y el mismo patrón en
 * `POST /admin/incidents`/`.../resolve`) omitía por completo el registro en
 * `audit_log` cuando la fila afectada no tenía `org_id` (jobs de
 * plataforma/discovery, incidentes sin organización): el comentario del
 * código mencionaba una "organización de sistema" que no existía en la
 * implementación real. Ahora `audit_log.org_id` acepta NULL (migración
 * 0035) y las tres rutas auditan siempre.
 */
async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

describe('API-10 — audit_log registra eventos de plataforma sin organización (org_id NULL)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('reintentar un job SIN org_id (discovery/plataforma) queda auditado con org_id = null', async () => {
    const superadminUser = await registerAndLogin(app, 'api10-superadmin-1@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const { rows } = await db.query<{ id: string }>(
      "insert into jobs (org_id, kind, status, payload) values (null, 'discovery_scan', 'failed', '{}'::jsonb) returning id"
    );
    const jobId = rows[0].id;

    const retry = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${jobId}/retry`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe('queued');

    const audit = await db.query("select org_id, actor_id, action from audit_log where entity = 'jobs' and entity_id = $1 and action = 'admin.job.retry'", [jobId]);
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].org_id).toBeNull();
    expect(audit.rows[0].actor_id).toBe(superadminUser.id);
  });

  it('crear y resolver un incidente SIN organización queda auditado con org_id = null', async () => {
    const superadminUser = await registerAndLogin(app, 'api10-superadmin-2@example.com');
    await makeSuperadmin(db, superadminUser.id);

    const create = await app.inject({
      method: 'POST',
      url: '/admin/incidents',
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
      payload: { title: 'Incidente de plataforma sin organización', severity: 'high' },
    });
    expect(create.statusCode).toBe(201);
    const incidentId = create.json().id;

    const createAudit = await db.query("select org_id from audit_log where entity = 'incidents' and entity_id = $1 and action = 'admin.incident.create'", [incidentId]);
    expect(createAudit.rows.length).toBe(1);
    expect(createAudit.rows[0].org_id).toBeNull();

    const resolve = await app.inject({
      method: 'POST',
      url: `/admin/incidents/${incidentId}/resolve`,
      headers: { authorization: `Bearer ${superadminUser.accessToken}` },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().status).toBe('resolved');

    const resolveAudit = await db.query("select org_id from audit_log where entity = 'incidents' and entity_id = $1 and action = 'admin.incident.resolve'", [incidentId]);
    expect(resolveAudit.rows.length).toBe(1);
    expect(resolveAudit.rows[0].org_id).toBeNull();
  });
});
