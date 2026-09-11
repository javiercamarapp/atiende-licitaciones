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
import type { JobQueue } from '../queue/job-queue.js';
import { enqueueAgentRun } from '../agents/enqueue-agent-run.js';
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_ROLE } from '../agents/system-actor.js';
import { sanitizeCorrelationId } from '../lib/correlation-id.js';

export interface DiscoverTendersPayload {
  sourceId: SourceId;
  /** Límite de registros por corrida (pruebas/lotes acotados). */
  limit?: number;
  since?: string;
  /** Si se omite, se ingiere a TODAS las organizaciones (ver internal-ingest.routes.ts de apps/api: convocatoria pública = visible para todo tenant). */
  organizationIds?: string[];
  /**
   * WK-06 (docs/auditoria-1/worker.md): total esperado de registros para
   * esta corrida, cuando el llamador (scheduler/config de fuente) lo conoce
   * de antemano (p. ej. una cabecera de paginación de una corrida previa).
   * Ningún conector real de `packages/sources` reporta esto hoy; cuando se
   * omite, `coverage.expected` se registra explícitamente como `null` CON
   * un motivo (`coverage.expectedReason`), nunca como un `null` mudo.
   */
  expectedTotal?: number;
  /**
   * Residual de REQ-171 (R5-04 cubrió `tenders`/`tender_versions`, pero dejó
   * `source_runs` -- el eslabón que en realidad DISPARA esa cadena -- sin
   * escribir la columna). Mismo patrón que `RunAgentPayload.correlationId`
   * (`handlers/run-agent.ts`): si el llamador (scheduler/reintento) ya trae
   * un id de negocio, se hereda; si no, nace aquí a partir de `job.id`
   * (UUID real, ver `jobs.id uuid default gen_random_uuid()`) -- UNA sola vez
   * por corrida, y se reutiliza en TODAS las filas de `source_runs` que
   * produzca esta ejecución del handler (varias rutas de error registran más
   * de una) y en la cabecera `X-Correlation-Id` hacia
   * `POST /internal/tenders/ingest`, para que `tenders`/`tender_versions`
   * (que ya persisten la cabecera desde 0060_r504_correlation_id_tenders.sql)
   * terminen con el MISMO id que el `source_run` que los originó.
   */
  correlationId?: string;
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
  /**
   * Ronda 6, tarea 4 ("run_agent encola por evento: ingest, versión,
   * vencimiento"): si se provee, tras una ingesta exitosa se encola
   * `analista_convocatorias` por cada convocatoria NUEVA (`action:
   * 'created'`) y `vigilante_cambios` por cada convocatoria ACTUALIZADA
   * (`action: 'updated'`) — nunca por `'unchanged'`. Opcional (por defecto
   * `undefined`) para no romper el contrato existente de este handler ni
   * los tests que lo construyen sin cola.
   */
  agentEventsQueue?: JobQueue;
}

/**
 * Encola los agentes nombrados correspondientes a los resultados de una
 * ingesta exitosa (Ronda 6, tarea 4). Deduplicado por
 * `(agentName, source:externalId:versionId)` — reintentar/reingestar el
 * MISMO resultado nunca encola una segunda corrida activa. Un fallo al
 * encolar (p. ej. `PROPOSAL-06` aún no aplicada y algún otro error
 * inesperado) se registra pero NO hace fallar la propia ingesta: el evento
 * "convocatoria descubierta" ya se completó con éxito, el análisis
 * automático es una mejora adicional, no una condición de éxito de
 * `discover_tenders`.
 */
async function enqueueAgentEventsForIngestResults(
  db: DbClient,
  queue: JobQueue,
  results: IngestTenderResponse['results'],
  logger: Logger,
): Promise<void> {
  for (const result of results) {
    if (result.action === 'unchanged') continue;
    const eventKey = `${result.source}:${result.externalId}:${result.versionId ?? 'sin-version'}`;
    const agentName = result.action === 'created' ? ('analista_convocatorias' as const) : ('vigilante_cambios' as const);
    try {
      await enqueueAgentRun(db, queue, {
        agentName,
        organizationId: result.organizationId,
        actorId: SYSTEM_ACTOR_ID,
        actorRole: SYSTEM_ACTOR_ROLE,
        context: { tenderId: result.tenderId },
        correlationId: result.tenderId,
        eventKey: `ingest:${result.action}:${eventKey}`,
      });
    } catch (error) {
      logger.warn(
        { tender_id: result.tenderId, agent_name: agentName, err: error instanceof Error ? error.message : String(error) },
        'run_agent: no se pudo encolar la corrida automática disparada por ingesta (la ingesta en sí ya se completó con éxito)',
      );
    }
  }
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

function describeIngestError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

class NotConfiguredError extends Error {
  /**
   * WK-10 (docs/auditoria-1/worker.md): fuente sin conector o sin
   * `liveVerification.verified` es un error PERMANENTE — no cambia hasta
   * que alguien registre el conector o lo verifique explícitamente; nunca
   * "se arregla solo" con un reintento. `isPermanentJobError`
   * (`queue/errors.ts`) usa esta propiedad para dead-letrar de inmediato en
   * vez de gastar el ciclo completo de backoff hasta `max_attempts`.
   */
  readonly permanent = true as const;

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
    // Un solo id para TODA esta ejecución del handler (ver JSDoc de
    // `DiscoverTendersPayload.correlationId`): todas las filas de
    // `source_runs` de esta corrida y la ingesta HTTP que dispare comparten
    // este mismo valor.
    //
    // WK6-04 (docs/auditoria-2/worker-agentes-reverificacion.md, MEDIA;
    // "audit gap" en la ruta de encolado): `payload.correlationId` es el
    // MISMO tipo de dato de negocio de confianza limitada que
    // `RunAgentPayload.correlationId` (ver `../lib/correlation-id.ts`), pero
    // este handler lo usaba tal cual -- sin pasar por
    // `sanitizeCorrelationId` -- en DOS fronteras que ese saneamiento
    // todavía no cubría: el INSERT de `source_runs.correlation_id` (un byte
    // NUL rompe el INSERT igual que rompía `agent_runs`/jobs) y la cabecera
    // `X-Correlation-Id` que `TenderIngestClient.ingest()` manda tal cual a
    // `fetch()` (un salto de línea/CR ahí es inyección de cabecera HTTP; 10
    // KB es una cabecera abusiva). Hoy solo el scheduler encola
    // `discover_tenders` (siempre sin `correlationId`, cae a `job.id`, un
    // UUID real -- no explotable en la práctica), pero el payload es JSONB
    // sin esquema forzado igual que el de `run_agent`, así que este límite
    // se cierra aquí por el mismo motivo que en las otras tres fronteras.
    const correlationId = sanitizeCorrelationId(job.payload.correlationId)?.value ?? job.id;

    // WK-06 (docs/auditoria-1/worker.md): `coverage.expected` viene de la
    // config de la fuente (`payload.expectedTotal`, si el scheduler/config
    // lo conoce) o, si no hay ninguna forma de saberlo hoy (ningún conector
    // real reporta un total esperado vía cabecera de paginación u otro
    // medio), queda explícitamente `null` CON un motivo legible en
    // `coverage.expectedReason` — nunca un `null` mudo indistinguible de "no
    // se pensó en ello".
    const expectedTotal = job.payload.expectedTotal ?? null;
    const expectedReason =
      expectedTotal === null
        ? 'El conector de esta fuente no reporta hoy un total esperado (paginación/cabecera); pendiente hasta que un conector real lo exponga.'
        : undefined;

    const connector = deps.registry.get(sourceId);
    if (!connector) {
      await recordSourceRun(deps.db, {
        sourceId,
        correlationId,
        fineState: 'not_configured',
        startedAt,
        finishedAt: now(),
        attempts: job.attempts,
        evidence: { message: `No hay conector registrado para la fuente "${sourceId}" (ver ConnectorRegistry).` },
        coverage: { expected: expectedTotal, expectedReason, obtained: 0 },
      });
      throw new NotConfiguredError(`fuente_no_configurada:${sourceId}`);
    }

    // REQ-070 (orquestador Radar→Analista→Redactor→Auditor→Mensajero):
    // `liveVerification.synthetic` (packages/sources/src/connectors/types.ts)
    // es el ÚNICO caso en el que este gate se omite con `verified: false` --
    // reservado exclusivamente al conector sintético/offline de pruebas
    // (`fixture-connector.ts`, id `fixture-offline`), que NUNCA se registra
    // en `buildDefaultConnectorRegistry()` (abajo). Ninguna de las 5 fuentes
    // reales (bloqueadas por B-02, docs/BLOQUEOS.md) obtiene este bypass: su
    // `liveVerification.synthetic` siempre es `undefined`, así que siguen
    // reportando `not_configured` exactamente igual que antes. Esto permite
    // probar el grafo COMPLETO de orquestación de punta a punta sin fingir
    // jamás que una fuente real está verificada cuando no lo está.
    if (!connector.liveVerification.verified && !connector.liveVerification.synthetic) {
      await recordSourceRun(deps.db, {
        sourceId,
        correlationId,
        fineState: 'not_configured',
        startedAt,
        finishedAt: now(),
        attempts: job.attempts,
        evidence: {
          message:
            `Conector "${sourceId}" sin verificación puntual en vivo (REQ-150: liveVerification.verified=false). ` +
            connector.liveVerification.note,
        },
        coverage: { expected: expectedTotal, expectedReason, obtained: 0 },
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
        correlationId,
        fineState: classification.state,
        startedAt,
        finishedAt: now(),
        attempts: job.attempts,
        evidence: { message: classification.message, httpStatus: classification.httpStatus },
        // WK-05 (docs/auditoria-1/worker.md): `discover()` falló a mitad de
        // iteración. Los `tenders.length` registros ya extraídos NUNCA
        // llegaron a `ingestClient.ingest()` (esa llamada solo ocurre si el
        // `try` de arriba completó sin excepción) ni a ningún otro lugar del
        // sistema: reportarlos como "obtenido" sería engañoso (un consumidor
        // de `source_runs.coverage` vería "obtenido: N>0" en una corrida
        // marcada como fallida, sin que esos N registros existan en ningún
        // lado). `obtained` se reporta en 0 (nada se persistió de verdad);
        // el conteo de "extraído pero descartado por el fallo" se guarda
        // aparte, en un campo con nombre explícito.
        coverage: { expected: expectedTotal, expectedReason, obtained: 0, discardedAfterDiscoverFailure: tenders.length },
      });
      throw error;
    }

    // WK-03 (docs/auditoria-1/worker.md): el `try/catch` original solo
    // envolvía la iteración del conector; si `ingestClient.ingest()` lanzaba
    // (5xx agotado, 401/403, timeout) DESPUÉS de un `discover()` exitoso, la
    // excepción se propagaba sin registrar NINGUNA fila en `source_runs`
    // para esa corrida — violaba el contrato explícito del propio handler
    // ("Registra SIEMPRE... incluso si el job termina en error", REQ-147/
    // 148/149). Ahora el envío también está cubierto: si falla, se registra
    // un estado fino explícito `ingest_failed` (distinto de un fallo de la
    // FUENTE: aquí la fuente sí respondió, lo que falló fue la entrega hacia
    // apps/api) con el conteo de registros descubiertos pero no ingeridos,
    // antes de volver a lanzar el error (para que `Worker`/reintentos sigan
    // aplicando igual que antes).
    let ingestResponse: IngestTenderResponse | undefined;
    if (tenders.length > 0) {
      try {
        ingestResponse = await deps.ingestClient.ingest(
          {
            records: tenders.map(mapTenderRecordToIngestRecord),
            organizationIds: job.payload.organizationIds,
          },
          { signal: ctx.signal, correlationId },
        );
      } catch (error) {
        const message = describeIngestError(error);
        await recordSourceRun(deps.db, {
          sourceId,
          correlationId,
          fineState: 'ingest_failed',
          startedAt,
          finishedAt: now(),
          attempts: job.attempts,
          evidence: {
            message: `discover() tuvo éxito (${tenders.length} registros) pero el envío a apps/api falló: ${message}`,
          },
          coverage: { expected: expectedTotal, expectedReason, obtained: 0, discoveredButNotIngested: tenders.length },
        });
        throw error;
      }
    }

    await recordSourceRun(deps.db, {
      sourceId,
      correlationId,
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
        // REQ-070: marca explícita cuando esta corrida vino del conector
        // sintético/offline de pruebas, para que ninguna lectura posterior
        // de `source_runs` confunda un fixture con una ingesta real.
        synthetic: connector.liveVerification.synthetic ?? false,
      },
      // WK-05: `obtained` solo refleja éxito (registros efectivamente
      // enviados/persistidos), nunca extracción parcial sin persistir.
      coverage: { expected: expectedTotal, expectedReason, obtained: tenders.length, ...(ingestResponse?.summary ?? {}) },
    });

    // Ronda 6, tarea 4: run_agent por evento de ingesta (analista_convocatorias
    // para convocatorias nuevas, vigilante_cambios para actualizadas).
    if (deps.agentEventsQueue && ingestResponse && ingestResponse.results.length > 0) {
      await enqueueAgentEventsForIngestResults(deps.db, deps.agentEventsQueue, ingestResponse.results, ctx.logger);
    }
  };
}
