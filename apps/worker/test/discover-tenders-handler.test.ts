import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DbClient } from '@atiende/db';
import { ConnectorRegistry, HttpClient, type SourceConnector, type SourceId, type TenderRecord } from '@atiende/sources';
import { createDiscoverTendersHandler, buildDefaultConnectorRegistry } from '../src/handlers/discover-tenders.js';
import { TenderIngestClient } from '../src/ingest/ingest-client.js';
import { createMigratedDb, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

function makeJob(payload: { sourceId: SourceId; limit?: number }, attempts = 1): Job<{ sourceId: SourceId; limit?: number }> {
  return {
    id: 'job-1',
    orgId: null,
    kind: 'discover_tenders',
    payload,
    status: 'running',
    attempts,
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
  const controller = new AbortController();
  return { job: makeJob({ sourceId: 'dof' }), logger: silentLogger(), signal: controller.signal };
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

/** Conector fake VERIFICADO (a diferencia de los 5 reales de packages/sources, ninguno tiene liveVerification.verified=true hoy). */
function makeVerifiedFakeConnector(options: { records?: TenderRecord[]; failWith?: Error } = {}): SourceConnector {
  return {
    id: 'dof',
    termsNote: 'fake para pruebas',
    liveVerification: { verified: true, note: 'verificado en la prueba' },
    async *discover() {
      if (options.failWith) throw options.failWith;
      for (const record of options.records ?? []) yield record;
    },
    async fetchDetail() {
      return null;
    },
  };
}

class FakeApiServer {
  server: http.Server;
  baseUrl = '';
  requests: Array<{ body: unknown }> = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        this.requests.push({ body });
        const records = (body as { records: Array<{ source: string; externalId: string }> }).records;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            results: records.map((r) => ({
              source: r.source,
              externalId: r.externalId,
              organizationId: '00000000-0000-0000-0000-000000000000',
              action: 'created',
              tenderId: '00000000-0000-0000-0000-000000000001',
              versionId: '00000000-0000-0000-0000-000000000002',
            })),
            summary: { created: records.length, updated: 0, unchanged: 0, organizationsAffected: 1 },
          }),
        );
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

describe('discover_tenders handler — A4: fuente inaccesible/no verificada nunca es "0 nuevas" silencioso', () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('los 5 conectores reales de packages/sources hoy no tienen liveVerification.verified=true: se reporta not_configured explícito, nunca "ok"', async () => {
    const registry = buildDefaultConnectorRegistry();
    const ingestClient = new TenderIngestClient({ baseUrl: 'http://127.0.0.1:1' }); // nunca debe llamarse
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    const job = makeJob({ sourceId: 'dof' });
    await expect(handler(job, makeCtx())).rejects.toThrow(/fuente_no_verificada/);

    const { rows } = await db.query<{ status: string; evidence: Record<string, unknown> }>(
      `select status, evidence from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).not.toBe('ok');
    expect(rows[0].evidence.fineState).toBe('not_configured');
  });

  it('un conector que lanza error con "captcha" en el mensaje se clasifica como captcha_detected, no "ok"', async () => {
    const registry = new ConnectorRegistry().register(
      makeVerifiedFakeConnector({ failWith: new Error('Se detectó un CAPTCHA en la respuesta') }),
    );
    const ingestClient = new TenderIngestClient({ baseUrl: 'http://127.0.0.1:1' });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    const job = makeJob({ sourceId: 'dof' });
    await expect(handler(job, makeCtx())).rejects.toThrow(/captcha/i);

    const { rows } = await db.query<{ status: string; evidence: Record<string, unknown> }>(
      `select status, evidence from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows[0].status).toBe('captcha');
    expect(rows[0].evidence.fineState).toBe('captcha_detected');
  });

  it('fuente sin conector registrado nunca produce "0 nuevas": falla explícito con not_configured', async () => {
    const registry = new ConnectorRegistry(); // vacío a propósito
    const ingestClient = new TenderIngestClient({ baseUrl: 'http://127.0.0.1:1' });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    const job = makeJob({ sourceId: 'dof' });
    await expect(handler(job, makeCtx())).rejects.toThrow(/fuente_no_configurada/);

    const { rows } = await db.query<{ evidence: Record<string, unknown> }>(`select evidence from source_runs where source_id = 'dof'`);
    expect(rows[0].evidence.fineState).toBe('not_configured');
  });
});

describe('discover_tenders handler — A1/A2: publicación nueva e idempotencia de replay', () => {
  let db: DbClient;
  let apiServer: FakeApiServer;

  beforeEach(async () => {
    db = await createMigratedDb();
    apiServer = new FakeApiServer();
    await apiServer.listen();
  });

  afterEach(async () => {
    await db.close();
    await apiServer.close();
  });

  it('convocatoria nueva de una fuente verificada: se ingiere vía HTTP y source_runs queda "ok"', async () => {
    const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [makeTender('EXP-1')] }));
    const ingestClient = new TenderIngestClient({ baseUrl: apiServer.baseUrl, apiKey: 'k' });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    await handler(makeJob({ sourceId: 'dof' }), makeCtx());

    expect(apiServer.requests).toHaveLength(1);
    expect((apiServer.requests[0].body as { records: unknown[] }).records).toHaveLength(1);

    const { rows } = await db.query<{ status: string; coverage: Record<string, unknown> }>(
      `select status, coverage from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows[0].status).toBe('ok');
    expect(rows[0].coverage.obtained).toBe(1);
  });

  it('replay del mismo lote (misma corrida repetida) envía el mismo payload de ingesta — idempotente (A2)', async () => {
    const tender = makeTender('EXP-REPLAY');
    const registry1 = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [tender] }));
    const ingestClient = new TenderIngestClient({ baseUrl: apiServer.baseUrl });
    const handler1 = createDiscoverTendersHandler({ db, registry: registry1, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });
    await handler1(makeJob({ sourceId: 'dof' }), makeCtx());

    // "Reprocesa" el mismo snapshot con un handler nuevo (misma fuente, mismos datos).
    const registry2 = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [tender] }));
    const handler2 = createDiscoverTendersHandler({ db, registry: registry2, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });
    await handler2(makeJob({ sourceId: 'dof' }), makeCtx());

    expect(apiServer.requests).toHaveLength(2);
    // El cuerpo enviado a apps/api es idéntico en ambas corridas: la idempotencia
    // real (0 efectos duplicados) la garantiza el endpoint de ingesta por
    // `(source, externalId, rawHash)` — fuera del alcance de apps/worker (ver
    // README §Pendientes) — pero este worker nunca varía el payload entre
    // reintentos del mismo snapshot, que es la parte que sí le corresponde.
    expect(apiServer.requests[0].body).toEqual(apiServer.requests[1].body);

    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from source_runs where source_id = 'dof' and status = 'ok'`);
    expect(rows[0].n).toBe(2); // cada corrida se audita, pero sin duplicar el envío de datos distinto
  });

  it('una corrida sin registros nuevos NO llama al endpoint de ingesta pero sí queda "ok" (no confundir con fuente caída)', async () => {
    const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [] }));
    const ingestClient = new TenderIngestClient({ baseUrl: apiServer.baseUrl });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    await handler(makeJob({ sourceId: 'dof' }), makeCtx());
    expect(apiServer.requests).toHaveLength(0);

    const { rows } = await db.query<{ status: string }>(`select status from source_runs where source_id = 'dof'`);
    expect(rows[0].status).toBe('ok');
  });
});
