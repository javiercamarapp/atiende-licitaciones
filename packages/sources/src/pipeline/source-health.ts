import { ZodError } from "zod";
import { HostPausedError, HttpError } from "../http/http-client.js";
import { CaptchaDetectedError, InterfaceChangedError } from "../http/response-classifier.js";
import { SourceNotConfiguredError } from "../connectors/types.js";
import type { SourceId } from "../types/tender-record.js";

/**
 * Estados explícitos de salud de una fuente (ampliación docs/AMPLIACION-BACKOFFICE.md
 * §2-3). El pipeline NUNCA debe interpretar el silencio de una fuente caída
 * como "cero oportunidades": cuando `state !== "ok"`, los contadores de la
 * corrida deben leerse como "no evaluado" para esa fuente, no como "no hay
 * nada nuevo".
 *
 * `not_configured` (SR-03): una corrida que NUNCA tocó la red por falta de
 * configuración (p.ej. `createDofConnector()` sin `noteCodes`) debe
 * reportar este estado, distinto de `"ok"` — de lo contrario es
 * indistinguible de una corrida real sin novedades (REQ-148: "nunca se
 * interpreta el silencio como cero oportunidades"). Este valor ya lo
 * consume `apps/worker` (`SourceRunFineState`, ver
 * `apps/worker/src/source-runs/source-run-status.ts`), que hasta ahora lo
 * producía por su cuenta ANTES de llamar a `connector.discover()`
 * (gateando por `liveVerification.verified`); añadirlo aquí es aditivo y no
 * rompe ese consumidor (`SourceRunFineState` ya incluía `"not_configured"`
 * en su unión).
 */
export type SourceHealthState =
  | "ok"
  | "down"
  | "captcha_detected"
  | "interface_changed"
  | "permission_missing"
  | "rate_limited"
  | "not_configured";

export interface SourceHealthEvidence {
  httpStatus?: number;
  /** sha256 del cuerpo de respuesta que disparó la clasificación (si estaba disponible), para comparar entre corridas. */
  responseHash?: string;
  message: string;
}

export interface SourceHealth {
  source: SourceId;
  state: SourceHealthState;
  lastAttemptAt: Date;
  lastSuccessAt?: Date;
  /** Intentos acumulados históricos (no solo de esta corrida). */
  attempts: number;
  consecutiveFailures: number;
  /** Milisegundos desde el último éxito conocido; `undefined` si nunca hubo uno. Es la métrica de "frescura/obsolescencia". */
  staleForMs?: number;
  evidence: SourceHealthEvidence;
}

/** Almacén de salud por fuente, persistente entre corridas del pipeline (en memoria aquí; DB en `apps/api`). */
export interface SourceHealthStore {
  get(source: SourceId): Promise<SourceHealth | undefined>;
  set(source: SourceId, health: SourceHealth): Promise<void>;
}

export class InMemorySourceHealthStore implements SourceHealthStore {
  private readonly byId = new Map<SourceId, SourceHealth>();

  async get(source: SourceId): Promise<SourceHealth | undefined> {
    return this.byId.get(source);
  }

  async set(source: SourceId, health: SourceHealth): Promise<void> {
    this.byId.set(source, health);
  }
}

/**
 * Clasifica un error de conector en un `SourceHealthState` explícito.
 * `CaptchaDetectedError`/`InterfaceChangedError` (SR-14, `http/response-classifier.ts`)
 * son la vía PRECISA de detección: cualquier conector que valide su cuerpo
 * de respuesta con `assertLegitimateResponseBody` antes de interpretarlo
 * clasifica correctamente un 200 con captcha/bot-challenge o con un cambio
 * de formato inesperado, en vez de reportar "ok" o caer en el catch-all
 * "down". La heurística de mensaje (`/captcha/i`) se conserva como red de
 * seguridad adicional para cualquier otro error que mencione "captcha" en
 * su mensaje sin usar esas clases. Complementa la detección de 401/403
 * (`permission_missing`), 429/`HostPausedError` (`rate_limited` /
 * `permission_missing`), 5xx/red (`down`) y errores de esquema `ZodError`
 * (`interface_changed`: el parser no reconoce la estructura recibida).
 */
export function classifySourceFailure(error: unknown): { state: SourceHealthState; message: string; httpStatus?: number } {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof SourceNotConfiguredError) {
    return { state: "not_configured", message };
  }
  if (error instanceof CaptchaDetectedError) {
    return { state: "captcha_detected", message };
  }
  if (error instanceof InterfaceChangedError) {
    return { state: "interface_changed", message };
  }
  if (/captcha/i.test(message)) {
    return { state: "captcha_detected", message };
  }
  if (error instanceof HostPausedError) {
    return { state: "permission_missing", message };
  }
  if (error instanceof HttpError) {
    if (error.status === 429) return { state: "rate_limited", message, httpStatus: error.status };
    if (error.status === 401 || error.status === 403) return { state: "permission_missing", message, httpStatus: error.status };
    return { state: "down", message, httpStatus: error.status };
  }
  if (error instanceof ZodError) {
    return { state: "interface_changed", message: `El parser no reconoce la estructura recibida: ${message}` };
  }
  return { state: "down", message };
}

export function computeStaleForMs(lastSuccessAt: Date | undefined, now: Date): number | undefined {
  if (!lastSuccessAt) return undefined;
  return Math.max(0, now.getTime() - lastSuccessAt.getTime());
}
