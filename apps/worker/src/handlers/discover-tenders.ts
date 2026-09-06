import type { DbClient } from '@atiende/db';
import {
  ConnectorRegistry,
  HttpClient,
  classifySourceFailure,
  createComprasMxConnector,
  createDofConnector,
  createOcdsShcpConnector,
  createPdnS6Connector,
  createStatePortalConnector,
  hashRawPayload,
  type Logger as SourcesLogger,
  type SourceId,
  type TenderRecord,
} from '@atiende/sources';
import type { Logger } from '../logger.js';
import { TenderIngestClient, type IngestTenderResponse } from '../ingest/ingest-client.js';
import { mapTenderRecordToIngestRecord } from '../ingest/ingest-mapper.js';
import { recordSourceRun } from '../source-runs/source-runs-repository.js';
import type { JobHandler, JobHandlerContext } from '../queue/types.js';
import type { Job } from '../queue/types.js';

export interface DiscoverTendersPayload {
  sourceId: SourceId;
  /** Límite de registros por corrida (pruebas/lotes acotados). */
  limit?: number;
  since?: string;
  /** Si se omite, se ingiere a TODAS las organizaciones (ver internal-ingest.routes.ts de apps/api: convocatoria pública = visible para todo tenant). */
  organizationIds?: string[];
}

/**
 * Contrato esperado del handler de descubrimiento (pedido explícitamente en
 * esta ronda). `packages/sources` YA estaba presente en el filesystem al
 * empezar esta ronda (no commiteado en git todavía: `git log -- packages/sources`
 * no devuelve nada; ver README §Dependencias), así que esta interfaz se
 * define en función de su `SourceConnector`/`ConnectorRegistry` reales en
 * vez de inventar un contrato paralelo. Un handler que implemente esta
 * interfaz DEBE:
 *  1. Nunca reportar éxito ("ok"/"0 nuevas") para una fuente sin
 *     `liveVerification.verified === true` con evidencia real (REQ-150):
 *     debe fallar EXPLÍCITAMENTE con `not_configured`.
 *  2. Registrar siempre una fila en `source_runs` con un estado explícito
 *     (REQ-147/REQ-148), incluso cuando el job termina en error.
 *  3. Enviar los `TenderRecord` descubiertos al endpoint interno de
 *     `apps/api` (`TenderIngestClient` + `mapTenderRecordToIngestRecord`),
 *     nunca escribir `tenders` directamente en la base de datos.
 *
 * NOTA (actualizada durante esta ronda): `apps/api` SÍ implementó
 * `POST /internal/tenders/ingest` mientras se construía este worker (ver
 * `apps/api/src/modules/tenders/internal-ingest.routes.ts` y `schemas.ts`,
 * también sin commitear todavía). `TenderIngestClient`/`ingest-mapper.ts`
 * se alinearon a ESE contrato real (campo `records`, `sourceVersion`
 * obligatorio = `snapshot.rawHash`, respuesta `{results, summary}`,
 * cabecera `X-Platform-Api-Key`) en vez de a la propuesta especulativa
 * original.
 */
export type DiscoveryJobHandler = JobHandler<DiscoverTendersPayload>;

export interface DiscoverTendersHandlerDeps {
  db: DbClient;
  registry: ConnectorRegistry;
  ingestClient: TenderIngestClient;
  httpClient: HttpClient;
  now?: () => Date;
}

/** Adapta el logger pino (job) a la interfaz `Logger` de `@atiende/sources` (`info(msg, meta)`). */
function toSourcesLogger(logger: Logger): SourcesLogger {
  return {
    info: (msg, meta) => logger.info(meta ?? {}, msg),
    warn: (msg, meta) => logger.warn(meta ?? {}, msg),
    error: (msg, meta) => logger.error(meta ?? {}, msg),
  };
}

/**
 * Registro de conectores por defecto: los 5 adaptadores reales de
 * `packages/sources` (REQ-004/REQ-132-135). NINGUNO tiene hoy
 * `liveVerification.verified === true` (ver README de ese paquete): todos
 * documentan evidencia real de por qué no se pudo verificar en vivo
 * (reCAPTCHA, DNS que no resuelve, etc.). Esto es intencional y correcto,
 * no un bug de este worker: mientras eso no cambie, CADA corrida de
 * `discover_tenders` contra estos 5 conectores reporta `not_configured`
 * explícito en `source_runs`, nunca "ok" con "0 nuevas" (REQ-150/REQ-148).
 */
export function buildDefaultConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry()
    .register(createComprasMxConnector())
    .register(createOcdsShcpConnector())
    .register(createDofConnector())
    .register(createPdnS6Connector())
    .register(createStatePortalConnector());
}

export function buildDefaultHttpClient(): HttpClient {
  return new HttpClient({ userAgent: 'AtiendeLicitacionesBot/1.0 (+https://atiende.mx/bot)' });
}

class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export function createDiscoverTendersHandler(deps: DiscoverTendersHandlerDeps): DiscoveryJobHandler {
  return async (job: Job<DiscoverTendersPayload>, ctx: JobHandlerContext) => {
    const now = deps.now ?? (() => new Date());
    const startedAt = now();
    const sourceId = job.payload.sourceId;
    if (!sourceId) throw new Error('discover_tenders: payload.sourceId es requerido');

    const connector = deps.registry.get(sourceId);
    if (!connector) {
      await recordSourceRun(deps.db, {
        sourceId,
        fineState: 'not_configured',
        startedAt,
        finishedAt: now(),
        attempts: job.attempts,
        evidence: { message: `No hay conector registrado para la fuente "${sourceId}" (ver ConnectorRegistry).` },
        coverage: { expected: null, obtained: 0 },
      });
      throw new NotConfiguredError(`fuente_no_configurada:${sourceId}`);
    }

    if (!connector.liveVerification.verified) {
      await recordSourceRun(deps.db, {
        sourceId,
        fineState: 'not_configured',
        startedAt,
        finishedAt: now(),
        attempts: job.attempts,
        evidence: {
          message:
            `Conector "${sourceId}" sin verificación puntual en vivo (REQ-150: liveVerification.verified=false). ` +
            connector.liveVerification.note,
        },
        coverage: { expected: null, obtained: 0 },
      });
      throw new NotConfiguredError(`fuente_no_verificada:${sourceId}`);
    }

    const tenders: TenderRecord[] = [];
    try {
      const iterable = connector.discover(
        { since: job.payload.since ? new Date(job.payload.since) : undefined, limit: job.payload.limit },
        { http: deps.httpClient, logger: toSourcesLogger(ctx.logger), now },
      );
      for await (const record of iterable) {
        if (ctx.signal.aborted) break;
        tenders.push(record);
      }
    } catch (error) {
      const classification = classifySourceFailure(error);
      await recordSourceRun(deps.db, {
        sourceId,
        fineState: classification.state,
        startedAt,
        finishedAt: now(),
        attempts: job.attempts,
        evidence: { message: classification.message, httpStatus: classification.httpStatus },
        coverage: { expected: null, obtained: tenders.length },
      });
      throw error;
    }

    let ingestResponse: IngestTenderResponse | undefined;
    if (tenders.length > 0) {
      ingestResponse = await deps.ingestClient.ingest(
        {
          records: tenders.map(mapTenderRecordToIngestRecord),
          organizationIds: job.payload.organizationIds,
        },
        ctx.signal,
      );
    }

    await recordSourceRun(deps.db, {
      sourceId,
      fineState: 'ok',
      startedAt,
      finishedAt: now(),
      attempts: job.attempts,
      lastSuccessAt: now(),
      evidence: {
        message:
          tenders.length > 0
            ? `Corrida exitosa: ${tenders.length} registros procesados. apps/api: ${JSON.stringify(ingestResponse?.summary ?? {})}.`
            : 'Corrida exitosa sin registros nuevos de la fuente.',
        responseHash: tenders.length > 0 ? hashRawPayload(tenders) : undefined,
      },
      coverage: { expected: null, obtained: tenders.length, ...(ingestResponse?.summary ?? {}) },
    });
  };
}
