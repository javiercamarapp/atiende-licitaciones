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
  behavior: 'ok' | 'fail-then-ok' | 'always-500' | 'always-401' | 'always-status' = 'ok';
  /** Solo usado con `behavior = 'always-status'` (tabla de verdad WK-17). */
  status = 500;
  private failuresLeft = 1;

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        this.received.push({ headers: req.headers, body });

        if (this.behavior === 'always-status') {
          res.writeHead(this.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `status-${this.status}` }));
          return;
        }
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

  it('REQ-171: cuando se pasa correlationId en options, viaja como cabecera X-Correlation-Id; si se omite, no se manda la cabecera', async () => {
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl });

    await client.ingest({ records: [makeRecord('EXP-CORR')] }, { correlationId: '11111111-2222-4333-8444-555555555555' });
    expect(fakeServer.received[0].headers['x-correlation-id']).toBe('11111111-2222-4333-8444-555555555555');

    await client.ingest({ records: [makeRecord('EXP-SIN-CORR')] });
    expect(fakeServer.received[1].headers['x-correlation-id']).toBeUndefined();
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

  /**
   * WK-17 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-10
   * PARCIAL): tabla de verdad completa de clasificación transitorio vs.
   * permanente contra un servidor HTTP real (nunca un mock de `fetch`).
   * Antes de esta ronda, 408 caía FUERA de `RETRYABLE_STATUS` y por tanto
   * `IngestApiError.permanent` lo marcaba permanente — `Worker.process()`
   * lo dead-letraba en el primer intento en vez de darle el ciclo normal de
   * backoff. 425 (Too Early) tenía el mismo problema y nunca se había
   * verificado explícitamente. Esta tabla fija, de una vez, el contrato
   * completo para los códigos relevantes: transitorio (`retryable=true`,
   * `permanent=false`, el cliente SÍ reintenta hasta `maxRetries`) vs.
   * permanente (`retryable=false`, `permanent=true`, CERO reintentos —
   * `received.length === 1`).
   */
  describe('WK-17: tabla de verdad — transitorio vs. permanente por código HTTP', () => {
    const maxRetries = 2;

    it.each([
      // [status, ¿transitorio?, motivo]
      [408, true, 'Request Timeout — semánticamente transitorio (fix WK-17, antes permanente)'],
      [425, true, 'Too Early — semánticamente transitorio (fix WK-17, nunca antes verificado)'],
      [429, true, 'Too Many Requests — ya era transitorio antes de esta ronda'],
      [500, true, 'Internal Server Error — ya era transitorio'],
      [502, true, 'Bad Gateway — ya era transitorio'],
      [503, true, 'Service Unavailable — ya era transitorio'],
      [504, true, 'Gateway Timeout — ya era transitorio'],
      [400, false, 'Bad Request — dato mal formado, reintentar no cambia el resultado'],
      [401, false, 'Unauthorized — credenciales inválidas, reintentar no cambia el resultado'],
      [403, false, 'Forbidden — permiso denegado, reintentar no cambia el resultado'],
      [404, false, 'Not Found — recurso inexistente, reintentar no cambia el resultado'],
      [422, false, 'Unprocessable Entity — validación de esquema, reintentar no cambia el resultado'],
      // WK-20 (docs/auditoria-1/worker-cierre.md, MEDIA): antes de esta ronda
      // esta "zona gris" (501, 505-599) no estaba clasificada ni como
      // transitorio ni como permanente explícito.
      [501, false, 'Not Implemented — falla ESTRUCTURAL declarada por el servidor (WK-20): reintentar el mismo request nunca cambia el resultado, permanente explícito'],
      [505, false, 'HTTP Version Not Supported — falla ESTRUCTURAL de protocolo (WK-20), permanente explícito igual que 501'],
      [506, true, 'Variant Also Negotiates — "zona gris" 506-599 (WK-20): transitorio, mismo trato que cualquier otro 5xx no estructural'],
      [599, true, 'código 5xx no estandarizado en el límite superior del rango — "zona gris" (WK-20): transitorio'],
    ] as const)('status %i -> transitorio=%s (%s)', async (status, transitorio, _motivo) => {
      fakeServer.behavior = 'always-status';
      fakeServer.status = status;
      const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 5, maxRetries });

      let caught: IngestApiError | undefined;
      try {
        await client.ingest({ records: [makeRecord(`EXP-${status}`)] });
      } catch (error) {
        caught = error as IngestApiError;
      }

      expect(caught).toBeInstanceOf(IngestApiError);
      expect(caught!.status).toBe(status);
      expect(caught!.retryable).toBe(transitorio);
      expect(caught!.permanent).toBe(!transitorio);

      if (transitorio) {
        // Reintenta hasta agotar maxRetries: intento inicial + maxRetries.
        expect(fakeServer.received.length).toBe(maxRetries + 1);
      } else {
        // CERO reintentos: el primer 4xx permanente termina la operación de inmediato.
        expect(fakeServer.received.length).toBe(1);
      }
    });

    it('error de red sin status HTTP (servidor caído) es transitorio (retryable=true, permanent=false)', async () => {
      await fakeServer.close();
      const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 5, maxRetries: 1, timeoutMs: 500 });

      let caught: IngestApiError | undefined;
      try {
        await client.ingest({ records: [makeRecord('EXP-NETWORK')] });
      } catch (error) {
        caught = error as IngestApiError;
      }

      expect(caught).toBeInstanceOf(IngestApiError);
      expect(caught!.status).toBeUndefined();
      expect(caught!.retryable).toBe(true);
      expect(caught!.permanent).toBe(false);
    });
  });

  /**
   * WK-20 (docs/auditoria-1/worker-cierre.md, MEDIA): "tabla de verdad
   * exhaustiva" pedida explícitamente — TODOS los 200 códigos 400-599 (no
   * solo una muestra), verificando que la clasificación es completa
   * (`retryable`/`permanent` nunca ambos `true`, nunca ambos `false` para
   * un `status` HTTP real) — antes de esta ronda, 96 de estos 200 códigos
   * (501, 505-599) caían en el hueco "ninguno de los dos". `maxRetries: 0`
   * mantiene la corrida rápida (una sola llamada HTTP real por código, sin
   * esperar ningún backoff) sin afectar la clasificación en sí (`.status`/
   * `.retryable`/`.permanent` se calculan antes de decidir si reintentar).
   */
  describe('WK-20: tabla de verdad exhaustiva — los 200 códigos 400-599, ninguno sin clasificar', () => {
    const allStatuses = Array.from({ length: 200 }, (_, i) => 400 + i);

    it.each(allStatuses)('status %i: exactamente uno de retryable/permanent es true (clasificación completa)', async (status) => {
      fakeServer.behavior = 'always-status';
      fakeServer.status = status;
      const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 1, maxRetries: 0 });

      let caught: IngestApiError | undefined;
      try {
        await client.ingest({ records: [makeRecord(`EXP-${status}`)] });
      } catch (error) {
        caught = error as IngestApiError;
      }

      expect(caught).toBeInstanceOf(IngestApiError);
      if (status === 407) {
        // WK-21: caso especial DENTRO del propio barrido 400-599 — undici
        // nunca entrega un Response real para 407 (ver test WK-21 dedicado
        // abajo), así que `.status` queda undefined en vez de 407. La
        // clasificación sigue siendo completa (permanente explícito de
        // configuración de proxy), solo por una vía distinta a `.status`.
        expect(caught!.status).toBeUndefined();
      } else {
        expect(caught!.status).toBe(status);
      }
      // Invariante WK-17 (nunca ambos true) + cierre WK-20 (nunca ambos
      // false): con un fallo real de este endpoint, exactamente uno de los
      // dos es true.
      expect(caught!.retryable).not.toBe(caught!.permanent);
    });
  });

  /**
   * WK-21 (docs/auditoria-1/worker-cierre.md, BAJA): contra un servidor
   * HTTP real (nunca un mock de `fetch`) que responde 407 directamente.
   * Node/undici SIEMPRE convierte esa respuesta en un `TypeError: fetch
   * failed` genérico (WHATWG fetch spec, paso de status 407 con
   * window='no-window') — el cliente nunca ve un `Response` con
   * `status===407`. Antes de esta ronda, ese error caía en la rama
   * genérica de "fallo de red" (retryable=true, permanent=false,
   * indistinguible de un DNS/ECONNRESET real). Ahora se clasifica
   * explícitamente como error PERMANENTE de configuración de proxy.
   */
  it('WK-21: HTTP 407 devuelto directamente por el servidor se clasifica como error PERMANENTE de configuración de proxy (mensaje explícito)', async () => {
    fakeServer.behavior = 'always-status';
    fakeServer.status = 407;
    const client = new TenderIngestClient({ baseUrl: fakeServer.baseUrl, retryBaseDelayMs: 5, maxRetries: 2 });

    let caught: IngestApiError | undefined;
    try {
      await client.ingest({ records: [makeRecord('EXP-407')] });
    } catch (error) {
      caught = error as IngestApiError;
    }

    expect(caught).toBeInstanceOf(IngestApiError);
    // undici nunca entrega un Response real para 407: no hay `.status`.
    expect(caught!.status).toBeUndefined();
    expect(caught!.retryable).toBe(false);
    expect(caught!.permanent).toBe(true);
    expect(caught!.message).toMatch(/proxy/i);
    // Permanente: CERO reintentos, aunque maxRetries lo permitiera.
    expect(fakeServer.received).toHaveLength(1);
  });
});
