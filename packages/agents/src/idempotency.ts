import { IdempotencyInProgressError } from "./errors.js";
import type { OrganizationId } from "./types.js";

/**
 * Idempotencia en memoria por `[organizationId, idempotencyKey]` (REQ-073).
 * `apps/api` deberá respaldar esto en Postgres con
 * `unique(tenant_id, idempotency_key)` + lease/fencing (ver patrón
 * `agente_mutacion_idempotencia` en docs/investigacion/likida-arquitectura.md)
 * para sobrevivir a reinicios del proceso; esta implementación solo cubre la
 * vida de un proceso, que es lo pedido para packages/agents.
 */
export type IdempotencyStatus = "in_progress" | "completed" | "failed";

export interface IdempotencyRecord<T = unknown> {
  key: string;
  status: IdempotencyStatus;
  result?: T;
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  private fullKey(organizationId: OrganizationId, key: string): string {
    return `${organizationId ?? "platform"}::${key}`;
  }

  /** Retorna el registro existente, si lo hay, sin efectos secundarios. */
  peek<T = unknown>(organizationId: OrganizationId, key: string): IdempotencyRecord<T> | undefined {
    return this.records.get(this.fullKey(organizationId, key)) as IdempotencyRecord<T> | undefined;
  }

  /**
   * Ejecuta `fn` exactamente una vez por clave: si ya se completó, retorna el
   * mismo resultado cacheado sin volver a ejecutar `fn`. Si hay una
   * ejecución en curso concurrente, lanza `IdempotencyInProgressError`
   * (reintentable) en vez de ejecutar dos veces.
   */
  async withIdempotency<T>(organizationId: OrganizationId, key: string, fn: () => Promise<T>): Promise<T> {
    const fullKey = this.fullKey(organizationId, key);
    const existing = this.records.get(fullKey);

    if (existing?.status === "completed") {
      return existing.result as T;
    }
    if (existing?.status === "in_progress") {
      throw new IdempotencyInProgressError(fullKey);
    }

    this.records.set(fullKey, { key: fullKey, status: "in_progress", createdAt: Date.now() });
    try {
      const result = await fn();
      this.records.set(fullKey, {
        key: fullKey,
        status: "completed",
        result,
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
      return result;
    } catch (error) {
      // Una ejecución fallida libera la clave: un reintento posterior con la
      // misma clave debe poder volver a intentarlo, no quedar atascado.
      this.records.delete(fullKey);
      throw error;
    }
  }

  clear(): void {
    this.records.clear();
  }
}
