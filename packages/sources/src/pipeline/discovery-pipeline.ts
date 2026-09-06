import type { HttpClient } from "../http/http-client.js";
import type { SourceConnector, Logger } from "../connectors/types.js";
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
  health: SourceHealth;
}

export interface DiscoveryResult {
  bySource: Record<string, SourceRunStats>;
  totalNuevos: number;
  totalActualizados: number;
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
  }

  async run(params: RunParams = {}): Promise<DiscoveryResult> {
    const startedAt = this.now();
    const entries = await runWithConcurrencyLimit(this.connectors, this.concurrency, async (connector) => this.runConnector(connector, params));

    const bySource: Record<string, SourceRunStats> = {};
    let totalNuevos = 0;
    let totalActualizados = 0;
    for (const stats of entries) {
      bySource[stats.source] = stats;
      totalNuevos += stats.nuevos;
      totalActualizados += stats.actualizados;
    }

    return { bySource, totalNuevos, totalActualizados, startedAt, finishedAt: this.now() };
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

    try {
      const iterable = connector.discover(
        { since: params.since, cursor: checkpoint?.cursor, limit: params.limitPerSource },
        { http: this.http, logger: this.logger, now: this.now },
      );

      for await (const record of iterable) {
        processedAny = true;
        await this.processRecord(connector.id, record, stats);
        lastExternalId = record.externalId;
        if (record.sourceCursor !== undefined) {
          lastCursor = record.sourceCursor;
          await this.checkpoints.set(connector.id, { cursor: lastCursor, lastRunAt: now.toISOString(), lastExternalId });
          this.onEvent({ type: "checkpoint-saved", source: connector.id, cursor: lastCursor, at: this.now() });
        }
      }

      stats.health.state = "ok";
      stats.health.lastSuccessAt = now;
      stats.health.consecutiveFailures = 0;
      stats.health.evidence = { message: processedAny ? "Corrida exitosa con registros procesados." : "Corrida exitosa sin registros nuevos de la fuente." };
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
