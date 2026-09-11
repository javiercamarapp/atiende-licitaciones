import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DbClient } from '@atiende/db';
import { ConnectorRegistry, createFixtureOfflineConnector, HttpClient } from '@atiende/sources';
import { createDiscoverTendersHandler } from '../src/handlers/discover-tenders.js';
import { TenderIngestClient } from '../src/ingest/ingest-client.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

/**
 * REQ-070 (nodo "Radar" del orquestador Radar→Analista→Redactor→Auditor→
 * Mensajero): B-02 sigue ABIERTO (docs/BLOQUEOS.md) — ninguno de los 5
 * conectores reales de `buildDefaultConnectorRegistry()` tiene
 * `liveVerification.verified === true`, así que este test usa el ÚNICO
 * conector permitido a saltarse ese gate: `createFixtureOfflineConnector`
 * (`@atiende/sources`, `synthetic: true` explícito, nunca `verified: true`).
 * Prueba, contra el `discover_tenders` handler REAL (sin ningún atajo
 * adicional), que el Radar sintético SÍ completa el primer tramo del grafo
 * (ingesta -> `analista_convocatorias` auto-encolado, mecanismo YA existente
 * de `enqueueAgentEventsForIngestResults`) — la pieza que faltaba para
 * poder decir que el grafo completo se prueba de punta a punta mientras
 * B-02 sigue bloqueando el Radar real.
 */
function makeJob(): Job<{ sourceId: 'fixture-offline'; limit?: number }> {
  return {
    id: 'job-req070-radar-1',
    orgId: null,
    kind: 'discover_tenders',
    payload: { sourceId: 'fixture-offline' },
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

/** Servidor HTTP fake que simula `POST /internal/tenders/ingest` de apps/api, apuntando a un tender REAL ya sembrado (mismo patrón que discover-tenders-agent-events.test.ts). */
class FakeApiServer {
  server: http.Server;
  baseUrl = '';

  constructor(private readonly organizationId: string, private readonly tenderId: string) {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as { records: Array<{ source: string; externalId: string }> };
        const results = body.records.map((r) => ({
          source: r.source,
          externalId: r.externalId,
          organizationId: this.organizationId,
          action: 'created' as const,
          tenderId: this.tenderId,
          versionId: '00000000-0000-0000-0000-000000000002',
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results, summary: { created: results.length, updated: 0, unchanged: 0, organizationsAffected: 1 } }));
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

// Mismo patrón que `mail-retry-handler.test.ts`/`send-expediente-notification.test.ts`
// (WK6-03): cada `it` crea su propia PGlite dentro del cuerpo del test, así
// que compite contra `testTimeout` por defecto (5000ms) bajo una corrida
// completa de la suite (muchos archivos PGlite en paralelo) — se sube a
// 20000ms para todo el archivo.
describe('discover_tenders + fixture-offline (REQ-070, Radar sintético/offline): completa el primer tramo real del grafo', { timeout: 20_000 }, () => {
  let db: DbClient | undefined;
  let api: FakeApiServer | undefined;

  afterEach(async () => {
    if (api) await api.close();
    if (db) await db.close();
    db = undefined;
    api = undefined;
  });

  it('ingesta exitosa del conector sintético -> encola analista_convocatorias (mismo mecanismo real que un conector de producción verificado)', async () => {
    db = await createMigratedDb();
    const { orgId } = await seedOrgAndUser(db, 'req070-radar-fixture');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'fixture-offline', 'FIXTURE-0001', '[SINTÉTICO] Rehabilitación de pavimento') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;

    api = new FakeApiServer(orgId, tenderId);
    await api.listen();

    const registry = new ConnectorRegistry().register(createFixtureOfflineConnector({ tenders: [{ externalId: 'FIXTURE-0001', title: 'x', contractingEntity: 'y' }] }));
    const ingestClient = new TenderIngestClient({ baseUrl: api.baseUrl });
    const agentEventsQueue = new JobQueue({ db });
    const handler = createDiscoverTendersHandler({
      db,
      registry,
      ingestClient,
      httpClient: new HttpClient({ userAgent: 'test' }),
      agentEventsQueue,
    });

    await handler(makeJob(), makeCtx());

    // El source_run queda "ok" y marcado explícitamente `synthetic: true`
    // (nunca se confunde con una ingesta real mientras B-02 siga abierto).
    const { rows: sourceRuns } = await db.query<{ status: string; evidence: Record<string, unknown> }>(
      `select status, evidence from source_runs where source_id = 'fixture-offline' order by started_at desc limit 1`,
    );
    expect(sourceRuns[0].status).toBe('ok');
    expect(sourceRuns[0].evidence.synthetic).toBe(true);

    // Radar -> Analista, encadenado por código (ya existente, ver
    // discover-tenders.ts `enqueueAgentEventsForIngestResults`): un job
    // `run_agent` para `analista_convocatorias` quedó en cola para ESTE
    // tenderId sintético, exactamente igual que si viniera de una fuente
    // real ya verificada.
    const queuedJob = await agentEventsQueue.claim('test-worker-req070-radar', { kinds: ['run_agent'] });
    expect(queuedJob?.payload).toMatchObject({ agentName: 'analista_convocatorias', organizationId: orgId, context: { tenderId } });
  });

  it('las 5 fuentes reales de producción NUNCA obtienen este atajo: buildDefaultConnectorRegistry() no incluye fixture-offline', async () => {
    const { buildDefaultConnectorRegistry } = await import('../src/handlers/discover-tenders.js');
    const registry = buildDefaultConnectorRegistry();
    expect(() => registry.requireById('fixture-offline' as never)).toThrow();
  });
});
