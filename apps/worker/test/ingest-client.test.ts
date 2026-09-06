import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { TenderIngestClient, IngestApiError, type TenderIngestRecord } from '../src/ingest/ingest-client.js';

function makeRecord(externalId: string): TenderIngestRecord {
  return {
    source: 'dof',
    externalId,
    title: `Convocatoria ${externalId}`,
    contractingEntity: 'Dependencia de prueba',
    currency: 'MXN',
    sourceVersion: 'a'.repeat(64),
  };
}

/**
 * Servidor HTTP real (no mock de fetch) que implementa el mismo contrato
 * REAL de `POST /internal/tenders/ingest` que ya construyó `apps/api`
 * (`apps/api/src/modules/tenders/internal-ingest.routes.ts`/`schemas.ts`,
 * también sin commitear todavía en esta ronda): cuerpo `{records,
 * organizationIds?}`, respuesta `{results, summary}`, cabecera
 * `X-Platform-Api-Key`. Sirve como "servidor falso" contra el que se prueba
 * el cliente de extremo a extremo por HTTP real, sin acoplar el test al
 * proceso real de `apps/api`.
 */
class FakeIngestServer {
  server: http.Server;
  baseUrl = '';
  received: Array<{ headers: http.IncomingHttpHeaders; body: unknown }> = [];
  behavior: 'ok' | 'fail-then-ok' | 'always-500' | 'always-401' = 'ok';
  private failuresLeft = 1;

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        this.received.push({ headers: req.headers, body });

        if (this.behavior === 'always-401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (this.behavior === 'always-500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'boom' }));
          return;
        }
        if (this.behavior === 'fail-then-ok' && this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unavailable' }));
          return;
        }

        const records = (body as { records: TenderIngestRecord[] }).records;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            results: records.map((r) => ({
              source: r.source,
              externalId: r.externalId,
              organizationId: randomUUID(),
              action: 'created',
              tenderId: randomUUID(),
              versionId: randomUUID(),
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

describe('TenderIngestClient contra un servidor HTTP real', () => {
  let fakeServer: FakeIngestServer;

  beforeEach(async () => {
    fakeServer = new FakeIngestServer();
    await fakeServer.listen();
  });

  afterEach(async () => {
    await fakeServer.close();
  });

  it('envía la cabecera de API key de plataforma y el payload correcto', async () => {
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, apiKey: 'plataforma-secreta' });
    const records = [makeRecord('EXP-1'), makeRecord('EXP-2')];
    const response = await client.ingest({ records });

    expect(response.summary.created).toBe(2);
    expect(response.results).toHaveLength(2);
    expect(fakeServer.received).toHaveLength(1);
    expect(fakeServer.received[0].headers['x-platform-api-key']).toBe('plataforma-secreta');
    expect((fakeServer.received[0].body as { records: TenderIngestRecord[] }).records[0].source).toBe('dof');
  });

  it('reintenta ante 503 y termina en éxito (backoff transparente para el llamador)', async () => {
    fakeServer.behavior = 'fail-then-ok';
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 10, maxRetries: 2 });
    const response = await client.ingest({ records: [makeRecord('EXP-1')] });
    expect(response.summary.created).toBe(1);
    expect(fakeServer.received.length).toBeGreaterThanOrEqual(2);
  });

  it('un 401 no se reintenta y se propaga como IngestApiError explícito', async () => {
    fakeServer.behavior = 'always-401';
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 5, maxRetries: 2 });
    await expect(client.ingest({ records: [makeRecord('EXP-1')] })).rejects.toThrow(IngestApiError);
    expect(fakeServer.received).toHaveLength(1); // sin reintentos para 401
  });

  it('un 500 persistente agota reintentos y falla explícitamente (nunca silencioso)', async () => {
    fakeServer.behavior = 'always-500';
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 5, maxRetries: 2 });
    await expect(client.ingest({ records: [makeRecord('EXP-1')] })).rejects.toThrow(IngestApiError);
    expect(fakeServer.received.length).toBe(3); // intento inicial + 2 reintentos
  });

  it('servidor caído (conexión rechazada) falla explícitamente tras agotar reintentos', async () => {
    await fakeServer.close();
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 5, maxRetries: 1, timeoutMs: 500 });
    await expect(client.ingest({ records: [makeRecord('EXP-1')] })).rejects.toThrow(IngestApiError);
  });

  it('organizationIds se propaga tal cual cuando se especifica (re-ingesta dirigida a orgs concretas)', async () => {
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl });
    const orgId = randomUUID();
    await client.ingest({ records: [makeRecord('EXP-1')], organizationIds: [orgId] });
    expect((fakeServer.received[0].body as { organizationIds: string[] }).organizationIds).toEqual([orgId]);
  });

  /**
   * WK-09 (docs/auditoria-1/worker.md): antes de esta ronda, la única
   * cabecera enviada era `x-platform-api-key`; la idempotencia de
   * transporte dependía ENTERAMENTE de que apps/api deduplicara por
   * contenido, sin ninguna capa de defensa adicional si ese contrato
   * cambiara. Ahora se envía `idempotency-key`, derivada
   * determinísticamente del CONTENIDO exacto del lote (mismo payload =>
   * misma clave, siempre).
   */
  it('WK-09: envía una cabecera Idempotency-Key determinística, estable entre reintentos del mismo lote', async () => {
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl });
    await client.ingest({ records: [makeRecord('EXP-IDEMP')] });
    const key1 = fakeServer.received[0].headers['idempotency-key'];
    expect(typeof key1).toBe('string');
    expect((key1 as string).length).toBeGreaterThan(0);

    // Mismo payload exacto en una segunda llamada -> misma clave.
    await client.ingest({ records: [makeRecord('EXP-IDEMP')] });
    const key2 = fakeServer.received[1].headers['idempotency-key'];
    expect(key2).toBe(key1);

    // Payload distinto -> clave distinta.
    await client.ingest({ records: [makeRecord('EXP-OTRO')] });
    const key3 = fakeServer.received[2].headers['idempotency-key'];
    expect(key3).not.toBe(key1);
  });
});
