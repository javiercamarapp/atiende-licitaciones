import type { HttpClient } from "../http/http-client.js";
import type { SourceId, TenderRecord } from "../types/tender-record.js";

export interface DiscoverParams {
  /** Solo descubrir convocatorias publicadas/modificadas desde esta fecha (si la fuente lo soporta). */
  since?: Date;
  /** Cursor opaco de la fuente para reanudar (viene de `Checkpoint.cursor`). */
  cursor?: string;
  /** Límite de registros a producir en esta corrida (para pruebas/paginación acotada). */
  limit?: number;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Descarte explícito de UN registro crudo dentro de un lote (SR-21, ronda 3
 * de corrección): antes de esta ronda, `mapComprasMxApiRecordToTenderRecord`
 * descartaba en silencio (`return null`, sin ningún error ni entrada en
 * `errors[]`) un registro con datos incompletos/inválidos (p.ej.
 * `titulo_expediente: null`) -- `DiscoveryPipeline` reportaba
 * `health.state = "ok"` sin ningún rastro del descartado. Un conector que
 * descarte un registro (a diferencia de filtrarlo por una regla de negocio
 * legítima, p.ej. un release OCDS sin bloque `tender`) debe reportarlo vía
 * `ConnectorContext.reportDropped()` con el índice/motivo/campos relevantes.
 */
export interface DroppedRecordInfo {
  /** Índice (0-based) del registro dentro del lote/página donde se descartó, si el conector lo puede determinar. */
  index?: number;
  /** `externalId` del registro si se pudo determinar antes de descartarlo. */
  externalId?: string;
  /** Motivo legible del descarte (nunca solo "inválido"; debe explicar el campo/condición que falló). */
  reason: string;
  /** Campos crudos relevantes para depurar (nunca el payload crudo completo -- solo lo necesario para diagnosticar). */
  fields?: Record<string, unknown>;
}

export interface ConnectorContext {
  http: HttpClient;
  logger?: Logger;
  /** Reloj inyectable para pruebas deterministas; por defecto `() => new Date()`. */
  now?: () => Date;
  /**
   * SR-21: canal explícito para que un conector reporte un registro
   * descartado por datos incompletos/inválidos SIN abortar el resto del
   * lote y SIN que quede en silencio. `DiscoveryPipeline` lo conecta a
   * `SourceRunStats.dropped`/`errores` y lo usa para el umbral de tasa de
   * descarte (`dropRateThreshold`). Opcional: un conector invocado fuera del
   * pipeline (p.ej. `apps/worker`, que llama `connector.discover()`
   * directamente) no lo provee, así que cada conector DEBE invocarlo como
   * `ctx.reportDropped?.(...)` -- nunca asumir que está presente.
   */
  reportDropped?: (info: DroppedRecordInfo) => void;
}

/**
 * Contrato único que debe implementar cualquier fuente de descubrimiento
 * (REQ-004). El `DiscoveryPipeline` y cualquier otro consumidor SOLO deben
 * interactuar con fuentes a través de esta interfaz y del registro
 * (`connectors/registry.ts`); está prohibido ramificar con
 * `if (connector.id === "...")` fuera del registro.
 */
export interface LiveVerification {
  /** true solo si esta fuente fue probada con una petición real de solo lectura contra el servicio en producción. */
  verified: boolean;
  /** Evidencia de lo intentado (fecha, resultado, motivo si no se pudo verificar). Ver README para el detalle completo. */
  note: string;
}

export interface SourceConnector {
  readonly id: SourceId;
  /** Documentación corta de robots.txt/ToS observados para esta fuente (ver README). */
  readonly termsNote: string;
  /** Estado de verificación contra el servicio real (REQ-132/133/134/135). Nunca declarar `verified: true` sin evidencia real. */
  readonly liveVerification: LiveVerification;
  discover(params: DiscoverParams, ctx: ConnectorContext): AsyncIterable<TenderRecord>;
  fetchDetail(externalId: string, ctx: ConnectorContext): Promise<TenderRecord | null>;
}

/**
 * Error que un `SourceConnector.discover()` DEBE lanzar cuando no puede
 * realizar ninguna petición real por falta de configuración explícita
 * (p.ej. `createDofConnector()` sin `noteCodes`) — a diferencia de una falla
 * real de red/permisos/formato (SR-03: `DiscoveryPipeline` no debe registrar
 * `health.state = "ok"` para una fuente que nunca fue consultada; sería
 * indistinguible de una corrida real "sin novedades", justo el antipatrón
 * que REQ-148 prohíbe). `classifySourceFailure`
 * (`src/pipeline/source-health.ts`) lo mapea a `"not_configured"`.
 */
export class SourceNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceNotConfiguredError";
  }
}
