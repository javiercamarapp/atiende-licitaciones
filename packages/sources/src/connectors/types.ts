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

export interface ConnectorContext {
  http: HttpClient;
  logger?: Logger;
  /** Reloj inyectable para pruebas deterministas; por defecto `() => new Date()`. */
  now?: () => Date;
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
