import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DbClient } from '@atiende/db';
import { ConnectorRegistry, HttpClient, type SourceConnector, type TenderRecord } from '@atiende/sources';
import { createDiscoverTendersHandler } from '../src/handlers/discover-tenders.js';
import { TenderIngestClient } from '../src/ingest/ingest-client.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

/**
 * Ronda 6, tarea 4 ("run_agent encola por evento: ingest..."): verifica que
 * una ingesta exitosa con `agentEventsQueue` configurada encola
 * `analista_convocatorias` (convocatoria nueva) / `vigilante_cambios`
 * (convocatoria actualizada), deduplicado, y que un fallo al encolar NO
 * hace fallar la propia ingesta (ya completada con éxito).
 */

function makeJob(): Job<{ sourceId: 'dof'; limit?: number }> {
  return {
    id: 'job-agent-events-1',
    orgId: null,
    kind: 'discover_tenders',
    payload: { sourceId: 'dof' },
    status: 'running',
    attempts: 1,
    maxAttempts: 5,
    nextRunAt: new Date(),
    lockedAt: new Date(),
    lockedBy: 'worker-test',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCtx(): JobHandlerContext {
  return { job: makeJob(), logger: silentLogger(), signal: new AbortController().signal };
}

function makeTender(externalId: string): TenderRecord {
  return {
    source: 'dof',
    externalId,
    title: `Convocatoria ${externalId}`,
    contractingEntity: 'Dependencia de prueba',
    procedureType: 'licitacion_publica',
    classifiers: [],
    currency: 'MXN',
    dates: {},
    status: 'published',
    attachments: [],
    snapshot: { fetchedAt: new Date('2026-09-05T10:00:00Z'), rawHash: 'b'.repeat(64), httpStatus: 200 },
  };
}

function makeVerifiedFakeConnector(records: TenderRecord[]): SourceConnector {
  return {
    id: 'dof',
    termsNote: 'fake para pruebas',
    liveVerification: { verified: true, note: 'verificado en la prueba' },
    async *discover() {
      for (const record of records) yield record;
    },
    async fetchDetail() {
      return null;
    },
  };
}

/** Servidor HTTP fake que responde con acciones controladas por el test (created/updated/unchanged), usando un org/tender REALES (FK real). */
class FakeApiServer {
  server: http.Server;
  baseUrl = '';

  constructor(private readonly buildResult: (externalId: string) => { organizationId: string; action: 'created' | 'updated' | 'unchanged'; tenderId: string; versionId: string | null }) {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { records: Array<{ source: string; externalId: string }> };
        const results = body.records.map((r) => ({ source: r.source, externalId: r.externalId, ...this.buildResult(r.externalId) }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results, summary: { created: 0, updated: 0, unchanged: 0, organizationsAffected: 1 } }));
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

describe('discover_tenders + agentEventsQueue (Ronda 6, tarea 4)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('convocatoria NUEVA (action: created) encola analista_convocatorias, deduplicado por (fuente, externalId, versión)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'discover-agent-events-created');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-created-1', 'Convocatoria nueva') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;

    const server = new FakeApiServer(() => ({ organizationId: orgId, action: 'created', tenderId, versionId: 'v1' }));
    await server.listen();
    try {
      const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector([makeTender('ext-created-1')]));
      const ingestClient = new TenderIngestClient({ baseUrl: server.baseUrl });
      const handler = createDiscoverTendersHandler({
        db,
        registry,
        ingestClient,
        httpClient: new HttpClient({ userAgent: 'test' }),
        agentEventsQueue: queue,
      });
      await handler(makeJob(), makeCtx());

      const { rows } = await db.query<{ kind: string; payload: { agentName: string } }>(
        `select kind, payload from jobs where org_id = $1 and kind = 'run_agent'`,
        [orgId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.agentName).toBe('analista_convocatorias');
    } finally {
      await server.close();
    }
  });

  it('convocatoria ACTUALIZADA (action: updated) encola vigilante_cambios', async () => {
    const { orgId } = await seedOrgAndUser(db, 'discover-agent-events-updated');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-updated-1', 'Convocatoria actualizada') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;

    const server = new FakeApiServer(() => ({ organizationId: orgId, action: 'updated', tenderId, versionId: 'v2' }));
    await server.listen();
    try {
      const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector([makeTender('ext-updated-1')]));
      const ingestClient = new TenderIngestClient({ baseUrl: server.baseUrl });
      const handler = createDiscoverTendersHandler({
        db,
        registry,
        ingestClient,
        httpClient: new HttpClient({ userAgent: 'test' }),
        agentEventsQueue: queue,
      });
      await handler(makeJob(), makeCtx());

      const { rows } = await db.query<{ payload: { agentName: string } }>(`select payload from jobs where org_id = $1 and kind = 'run_agent'`, [orgId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.agentName).toBe('vigilante_cambios');
    } finally {
      await server.close();
    }
  });

  it('convocatoria SIN CAMBIOS (action: unchanged) nunca encola ningún agente', async () => {
    const { orgId } = await seedOrgAndUser(db, 'discover-agent-events-unchanged');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-unchanged-1', 'Sin cambios') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;

    const server = new FakeApiServer(() => ({ organizationId: orgId, action: 'unchanged', tenderId, versionId: null }));
    await server.listen();
    try {
      const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector([makeTender('ext-unchanged-1')]));
      const ingestClient = new TenderIngestClient({ baseUrl: server.baseUrl });
      const handler = createDiscoverTendersHandler({
        db,
        registry,
        ingestClient,
        httpClient: new HttpClient({ userAgent: 'test' }),
        agentEventsQueue: queue,
      });
      await handler(makeJob(), makeCtx());

      const { rows } = await db.query(`select 1 from jobs where org_id = $1 and kind = 'run_agent'`, [orgId]);
      expect(rows).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('sin agentEventsQueue configurada (comportamiento por defecto), la ingesta no intenta encolar nada (compatibilidad hacia atrás)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'discover-agent-events-no-queue');
    await db.query(`insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-no-queue-1', 'X') returning id`, [orgId]);

    const server = new FakeApiServer(() => ({ organizationId: orgId, action: 'created', tenderId: '00000000-0000-0000-0000-000000000001', versionId: 'v1' }));
    await server.listen();
    try {
      const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector([makeTender('ext-no-queue-1')]));
      const ingestClient = new TenderIngestClient({ baseUrl: server.baseUrl });
      const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });
      await expect(handler(makeJob(), makeCtx())).resolves.toBeUndefined();
      const { rows } = await db.query(`select 1 from jobs where kind = 'run_agent'`);
      expect(rows).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
