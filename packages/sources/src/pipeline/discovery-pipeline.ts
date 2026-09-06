import type { HttpClient } from "../http/http-client.js";
import type { DroppedRecordInfo, SourceConnector, Logger } from "../connectors/types.js";
import { noopLogger } from "../connectors/types.js";
import type { SourceId, TenderRecord } from "../types/tender-record.js";
import type { CheckpointStore } from "./checkpoint.js";
import { runWithConcurrencyLimit } from "./concurrency.js";
import type { TenderRepository } from "./repository.js";
import {
  classifySourceFailure,
  computeStaleForMs,
  InMemorySourceHealthStore,
  type SourceHealth,
  type SourceHealthStore,
} from "./source-health.js";
import { InMemoryTenderVersionStore, type ChangeDetectedEvent } from "../dedupe/version.js";

export interface DiscoveryError {
  message: string;
  externalId?: string;
}

export interface SourceRunStats {
  source: SourceId;
  nuevos: number;
  actualizados: number;
  sinCambios: number;
  errores: DiscoveryError[];
  /**
   * SR-21 (ronda 3 de corrección): registros crudos descartados por el
   * conector (datos incompletos/inválidos, ver `ConnectorContext.reportDropped`)
   * durante esta corrida. Nunca vacío en silencio: cada entrada trae el
   * motivo exacto. Distinto de `errores` (que incluye también fallos de
   * `TenderRepository.upsert`/versión, no solo descartes de mapeo).
   */
  dropped: DroppedRecordInfo[];
  health: SourceHealth;
}

export interface DiscoveryResult {
  bySource: Record<string, SourceRunStats>;
  totalNuevos: number;
  totalActualizados: number;
  /** SR-21: suma de `SourceRunStats.dropped.length` de todas las fuentes de esta corrida. */
  totalDropped: number;
  startedAt: Date;
  finishedAt: Date;
}

export type DiscoveryEvent =
  | { type: "connector-start"; source: SourceId; at: Date }
  | { type: "record-processed"; source: SourceId; externalId: string; kind: "new" | "updated" | "unchanged"; at: Date }
  | { type: "connector-error"; source: SourceId; message: string; at: Date }
  | { type: "connector-complete"; source: SourceId; stats: SourceRunStats; at: Date }
  | { type: "checkpoint-saved"; source: SourceId; cursor: string | undefined; at: Date }
  | ChangeDetectedEvent;

export interface DiscoveryPipelineOptions {
  connectors: SourceConnector[];
  repository: TenderRepository;
  checkpoints: CheckpointStore;
  http: HttpClient;
  healthStore?: SourceHealthStore;
  versions?: InMemoryTenderVersionStore;
  /** Máximo de conectores corriendo en paralelo (no confundir con la concurrencia HTTP por host, que vive en `HttpClient`). */
  concurrency?: number;
  onEvent?: (event: DiscoveryEvent) => void;
  logger?: Logger;
  now?: () => Date;
  /**
   * SR-21: fracción (0-1) de registros descartados (`dropped.length` /
   * intentados) por encima de la cual una corrida que de otra forma
   * terminaría `"ok"` se reclasifica como `"interface_changed"` -- una tasa
   * de descarte alta es en sí misma evidencia de que el mapeo dejó de
   * coincidir con la forma real de la fuente, no ruido tolerable. Default
   * 0.2 (20%).
   */
  dropRateThreshold?: number;
}

export interface RunParams {
  since?: Date;
  /** Límite de registros por fuente en esta corrida (para pruebas/lotes acotados). */
  limitPerSource?: number;
}

/**
 * Orquesta el descubrimiento de convocatorias sobre todos los conectores
 * registrados: los ejecuta en paralelo con límite, normaliza (ya lo hace
 * cada conector vía `TenderRecordSchema`), deduplica (por `(source,
 * externalId)` en `TenderRepository.upsert`), versiona (detecta cambios de
 * bases/aclaraciones/anexos/plazos vía `InMemoryTenderVersionStore`) y
 * produce un `DiscoveryResult` idempotente: correr el pipeline dos veces
 * sobre la misma fuente sin cambios produce el mismo estado final del
 * repositorio (segunda corrida: 0 nuevos, 0 actualizados).
 *
 * Salud explícita (ampliación §2): cada entrada de `bySource` siempre trae
 * `health` con un estado explícito (`ok|down|captcha_detected|
 * interface_changed|permission_missing|rate_limited`). Cuando
 * `health.state !== "ok"`, los contadores de esa fuente deben leerse como
 * "no evaluado completamente", nunca como "no había nada nuevo".
 */
export class DiscoveryPipeline {
  private readonly connectors: SourceConnector[];
  private readonly repository: TenderRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly http: HttpClient;
  private readonly healthStore: SourceHealthStore;
  private readonly versions: InMemoryTenderVersionStore;
  private readonly concurrency: number;
  private readonly onEvent: (event: DiscoveryEvent) => void;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly dropRateThreshold: number;

  constructor(options: DiscoveryPipelineOptions) {
    this.connectors = options.connectors;
    this.repository = options.repository;
    this.checkpoints = options.checkpoints;
    this.http = options.http;
    this.healthStore = options.healthStore ?? new InMemorySourceHealthStore();
    this.versions = options.versions ?? new InMemoryTenderVersionStore();
    this.concurrency = options.concurrency ?? 3;
    this.onEvent = options.onEvent ?? (() => {});
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
    this.dropRateThreshold = options.dropRateThreshold ?? 0.2;
  }

  async run(params: RunParams = {}): Promise<DiscoveryResult> {
    const startedAt = this.now();
    const entries = await runWithConcurrencyLimit(this.connectors, this.concurrency, async (connector) => this.runConnector(connector, params));

    const bySource: Record<string, SourceRunStats> = {};
    let totalNuevos = 0;
    let totalActualizados = 0;
    let totalDropped = 0;
    for (const stats of entries) {
      bySource[stats.source] = stats;
      totalNuevos += stats.nuevos;
      totalActualizados += stats.actualizados;
      totalDropped += stats.dropped.length;
    }

    return { bySource, totalNuevos, totalActualizados, totalDropped, startedAt, finishedAt: this.now() };
  }

  private async runConnector(connector: SourceConnector, params: RunParams): Promise<SourceRunStats> {
    const now = this.now();
    const previousHealth = await this.healthStore.get(connector.id);
    const checkpoint = await this.checkpoints.get(connector.id);

    const stats: SourceRunStats = {
      source: connector.id,
      nuevos: 0,
      actualizados: 0,
      sinCambios: 0,
      errores: [],
      dropped: [],
      health: {
        source: connector.id,
        state: "ok",
        lastAttemptAt: now,
        lastSuccessAt: previousHealth?.lastSuccessAt,
        attempts: (previousHealth?.attempts ?? 0) + 1,
        consecutiveFailures: previousHealth?.consecutiveFailures ?? 0,
        evidence: { message: "" },
      },
    };

    this.onEvent({ type: "connector-start", source: connector.id, at: now });

    let lastCursor = checkpoint?.cursor;
    let lastExternalId = checkpoint?.lastExternalId;
    let processedAny = false;
    let recordCount = 0;

    try {
      const iterable = connector.discover(
        { since: params.since, cursor: checkpoint?.cursor, limit: params.limitPerSource },
        {
          http: this.http,
          logger: this.logger,
          now: this.now,
          // SR-21: cualquier registro descartado por el conector (datos incompletos/inválidos) se acumula en
          // `stats.dropped` Y en `stats.errores` -- nunca desaparece en silencio.
          reportDropped: (info) => {
            stats.dropped.push(info);
            stats.errores.push({ message: `Registro descartado (${info.reason})`, externalId: info.externalId });
          },
        },
      );

      for await (const record of iterable) {
        processedAny = true;
        recordCount += 1;
        await this.processRecord(connector.id, record, stats);
        lastExternalId = record.externalId;
        if (record.sourceCursor !== undefined) {
          lastCursor = record.sourceCursor;
          await this.checkpoints.set(connector.id, { cursor: lastCursor, lastRunAt: now.toISOString(), lastExternalId });
          this.onEvent({ type: "checkpoint-saved", source: connector.id, cursor: lastCursor, at: this.now() });
        }
      }

      // SR-21: una tasa de descarte alta es en sí misma evidencia de que el mapeo dejó de coincidir con la forma
      // real de la fuente -- se reclasifica como `interface_changed` EN VEZ de "ok", nunca se agrega en silencio
      // a `errores` sin cambiar el estado visible de la fuente.
      const totalAttempted = recordCount + stats.dropped.length;
      const dropRate = totalAttempted > 0 ? stats.dropped.length / totalAttempted : 0;
      if (stats.dropped.length > 0 && dropRate > this.dropRateThreshold) {
        stats.health.state = "interface_changed";
        stats.health.lastSuccessAt = previousHealth?.lastSuccessAt;
        stats.health.consecutiveFailures += 1;
        stats.health.evidence = {
          message:
            `Tasa de descarte de registros (${(dropRate * 100).toFixed(1)}%, ${stats.dropped.length}/${totalAttempted}) ` +
            `supera el umbral configurado (${(this.dropRateThreshold * 100).toFixed(0)}%): probable cambio de forma de ` +
            "la fuente en vez de datos incompletos aislados. Ver errors[]/dropped para el detalle por registro.",
        };
      } else {
        stats.health.state = "ok";
        stats.health.lastSuccessAt = now;
        stats.health.consecutiveFailures = 0;
        stats.health.evidence = {
          message: processedAny ? "Corrida exitosa con registros procesados." : "Corrida exitosa sin registros nuevos de la fuente.",
          // SR-19: "ok" con 0 registros procesados se marca explícitamente como resultado vacío -- nunca un "0"
          // mudo indistinguible de "nadie revisó si la fuente cambió de forma" (la forma ya fue validada por el
          // conector antes de llegar aquí: `assertLegitimateResponseBody`/esquemas sin `.default([])`).
          coverage: { emptyResult: !processedAny },
        };
      }
      await this.checkpoints.set(connector.id, { cursor: lastCursor, lastRunAt: now.toISOString(), lastExternalId });
    } catch (error) {
      const classification = classifySourceFailure(error);
      stats.health.state = classification.state;
      stats.health.consecutiveFailures += 1;
      stats.health.evidence = { message: classification.message, httpStatus: classification.httpStatus };
      stats.errores.push({ message: classification.message });
      this.onEvent({ type: "connector-error", source: connector.id, message: classification.message, at: this.now() });
      this.logger.error(`Fuente ${connector.id} falló: ${classification.message}`, { state: classification.state });
    }

    stats.health.staleForMs = computeStaleForMs(stats.health.lastSuccessAt, this.now());
    await this.healthStore.set(connector.id, stats.health);
    this.onEvent({ type: "connector-complete", source: connector.id, stats, at: this.now() });
    return stats;
  }

  private async processRecord(source: SourceId, record: TenderRecord, stats: SourceRunStats): Promise<void> {
    try {
      const { wasNew, wasUpdated } = await this.repository.upsert(record);
      const now = this.now();
      const { event } = this.versions.record(record, now);
      if (event) this.onEvent(event);

      if (wasNew) stats.nuevos += 1;
      else if (wasUpdated) stats.actualizados += 1;
      else stats.sinCambios += 1;

      this.onEvent({
        type: "record-processed",
        source,
        externalId: record.externalId,
        kind: wasNew ? "new" : wasUpdated ? "updated" : "unchanged",
        at: now,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errores.push({ message, externalId: record.externalId });
      this.logger.error(`Error procesando registro ${record.externalId} de ${source}: ${message}`);
    }
  }
}
