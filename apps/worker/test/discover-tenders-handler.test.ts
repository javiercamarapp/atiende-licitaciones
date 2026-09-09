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
  requests: Array<{ body: unknown; headers: http.IncomingHttpHeaders }> = [];

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        this.requests.push({ body, headers: req.headers });
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

  /**
   * Residual de REQ-171 (R5-04 cubrió `tenders`/`tender_versions`, pero
   * `source_runs` -- el eslabón que DISPARA esa cadena -- se quedó sin
   * escribir la columna, pese a que ya existe desde
   * `0056_correlation_id_propagation.sql`). Prueba real de extremo a
   * extremo hasta la frontera de `apps/worker`: la corrida escribe un
   * `correlation_id` REAL (no null, un UUID real) en `source_runs`, y ESE
   * MISMO id es el que viaja en la cabecera `X-Correlation-Id` hacia
   * `POST /internal/tenders/ingest` -- la cabecera que
   * `apps/api/.../correlation-id.plugin.ts` hereda tal cual (si es un UUID
   * válido) y que `internal-ingest.routes.ts` ya persiste en
   * `tenders`/`tender_versions` desde R5-04 (ver
   * `apps/api/test/correlation-id-e2e.test.ts`, sin tocar en esta ronda).
   * Con ambos hechos juntos, el `source_run` y los `tenders`/`tender_versions`
   * que produjo esa corrida terminan con el MISMO `correlation_id` real.
   */
  it('REQ-171: source_runs.correlation_id es un id real (no null) y es EL MISMO que viaja como X-Correlation-Id hacia el ingest', async () => {
    const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [makeTender('EXP-CORR')] }));
    const ingestClient = new TenderIngestClient({ baseUrl: apiServer.baseUrl, apiKey: 'k' });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    const job = makeJob({ sourceId: 'dof' });
    await handler(job, makeCtx());

    const { rows } = await db.query<{ correlation_id: string | null }>(
      `select correlation_id from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows[0].correlation_id).toBeTruthy();
    expect(rows[0].correlation_id).toBe(job.id);

    expect(apiServer.requests).toHaveLength(1);
    expect(apiServer.requests[0].headers['x-correlation-id']).toBe(job.id);
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

  it('WK-06: coverage.expected viene de payload.expectedTotal si se da; source_runs "ok" lo persiste', async () => {
    const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [makeTender('EXP-EXPECTED')] }));
    const ingestClient = new TenderIngestClient({ baseUrl: apiServer.baseUrl });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    const jobWithExpected = makeJob({ sourceId: 'dof' });
    // `makeJob` no modela `expectedTotal`: se asigna directamente al payload para esta prueba.
    (jobWithExpected as any).payload = { sourceId: 'dof', expectedTotal: 5 };
    await handler(jobWithExpected, makeCtx());

    const { rows } = await db.query<{ coverage: Record<string, unknown> }>(
      `select coverage from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows[0].coverage.expected).toBe(5);
    expect(rows[0].coverage.expectedReason).toBeUndefined();
  });
});

describe('discover_tenders handler — WK-03/WK-05/WK-06: honestidad de coverage y registro SIEMPRE de source_runs', () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.close();
  });

  /**
   * WK-03 (docs/auditoria-1/worker.md): antes de esta ronda, si
   * `ingestClient.ingest()` lanzaba DESPUÉS de un `discover()` exitoso, la
   * excepción se propagaba sin registrar NINGUNA fila en `source_runs` —
   * confirmado empíricamente por la auditoría (`0` filas tras una ingesta
   * fallida con datos ya descubiertos), violando el contrato explícito del
   * handler ("Registra SIEMPRE... incluso si el job termina en error").
   */
  it('si discover() tiene éxito pero el POST de ingesta falla, source_runs SIEMPRE se registra (ingest_failed)', async () => {
    const registry = new ConnectorRegistry().register(makeVerifiedFakeConnector({ records: [makeTender('EXP-INGEST-FAIL')] }));
    // Puerto cerrado a propósito: ingest() agota reintentos y lanza IngestApiError de red.
    const ingestClient = new TenderIngestClient({ baseUrl: 'http://127.0.0.1:1', maxRetries: 0, timeoutMs: 300 });
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    await expect(handler(makeJob({ sourceId: 'dof' }), makeCtx())).rejects.toThrow();

    const { rows } = await db.query<{ status: string; evidence: Record<string, unknown>; coverage: Record<string, unknown> }>(
      `select status, evidence, coverage from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows).toHaveLength(1); // antes de la corrección: 0 filas
    expect(rows[0].status).not.toBe('ok');
    expect(rows[0].evidence.fineState).toBe('ingest_failed');
    expect(rows[0].coverage.discoveredButNotIngested).toBe(1);
    expect(rows[0].coverage.obtained).toBe(0); // WK-05: nunca "obtenido" > 0 si no se persistió
  });

  /**
   * WK-05 (docs/auditoria-1/worker.md): cuando `discover()` falla a mitad de
   * iteración, los registros ya extraídos ANTES del error nunca llegaron a
   * `ingestClient.ingest()` ni a ningún otro lugar del sistema. Antes de
   * esta ronda, `coverage.obtained` reportaba ese conteo parcial como si
   * fuera "obtenido" real — engañoso para cualquier consumidor de
   * `source_runs.coverage`.
   */
  it('si discover() falla a mitad de iteración, coverage.obtained es 0 (nunca cuenta lo descartado)', async () => {
    async function* partial() {
      yield makeTender('EXP-PARTIAL-1');
      throw new Error('conector se cayó a mitad de iteración');
    }
    const registry = new ConnectorRegistry().register({
      id: 'dof',
      termsNote: 'fake',
      liveVerification: { verified: true, note: 'test' },
      discover: partial,
      async fetchDetail() {
        return null;
      },
    });
    const ingestClient = new TenderIngestClient({ baseUrl: 'http://127.0.0.1:1' }); // nunca debe llamarse
    const handler = createDiscoverTendersHandler({ db, registry, ingestClient, httpClient: new HttpClient({ userAgent: 'test' }) });

    await expect(handler(makeJob({ sourceId: 'dof' }), makeCtx())).rejects.toThrow(/conector se cayó/);

    const { rows } = await db.query<{ coverage: Record<string, unknown> }>(
      `select coverage from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows[0].coverage.obtained).toBe(0);
    expect(rows[0].coverage.discardedAfterDiscoverFailure).toBe(1);
  });

  /**
   * WK-06 (docs/auditoria-1/worker.md): `coverage.expected` era SIEMPRE
   * `null` sin ninguna explicación en las 4 rutas de `recordSourceRun`. Sin
   * un `expectedTotal` explícito en el payload, ahora se registra un motivo
   * legible junto al `null` (nunca un `null` mudo).
   */
  it('sin payload.expectedTotal, coverage.expected es null CON un motivo explícito, en las 4 rutas', async () => {
    const registryEmpty = new ConnectorRegistry();
    const ingestClient = new TenderIngestClient({ baseUrl: 'http://127.0.0.1:1' });
    const handlerNotConfigured = createDiscoverTendersHandler({
      db,
      registry: registryEmpty,
      ingestClient,
      httpClient: new HttpClient({ userAgent: 'test' }),
    });
    await expect(handlerNotConfigured(makeJob({ sourceId: 'dof' }), makeCtx())).rejects.toThrow();

    const { rows } = await db.query<{ coverage: Record<string, unknown> }>(
      `select coverage from source_runs where source_id = 'dof' order by started_at desc limit 1`,
    );
    expect(rows[0].coverage.expected).toBeNull();
    expect(typeof rows[0].coverage.expectedReason).toBe('string');
    expect((rows[0].coverage.expectedReason as string).length).toBeGreaterThan(0);
  });
});
