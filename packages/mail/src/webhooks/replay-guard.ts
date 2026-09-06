/**
 * Anti-replay de webhooks (ML-05). `verifyResendWebhookSignature` por sí
 * sola solo rechaza por firma inválida o por `svix-timestamp` fuera de la
 * ventana de tolerancia (`toleranceSeconds`, default 300s) — DENTRO de esa
 * ventana, repetir exactamente la misma petición capturada (mismo
 * `svix-id`, cuerpo y firma) se vuelve a verificar como válida cuantas veces
 * se quiera. Este módulo es el contrato de deduplicación por `svix-id` que
 * cierra esa ventana: una interfaz, SIN persistencia real, con el mismo
 * criterio que `SendRecordStore` (`service/send-store.ts`) — este paquete no
 * depende de ninguna base de datos ni de Redis.
 *
 * `apps/api` (quien expone `POST /api/correo/eventos`, ver README) la
 * implementa contra una tabla/caché real de vida corta, p. ej.
 * `webhook_events_vistos (svix_id PRIMARY KEY, expira_en)` en Postgres o una
 * llave en Redis con `EXPIRE toleranceSeconds` — basta con que el TTL cubra
 * al menos la ventana de tolerancia de la firma para que un reenvío tardío
 * (dentro de esa ventana) siga detectándose como replay.
 */
export interface WebhookReplayGuard {
  /**
   * Compare-and-set atómico: `true` la PRIMERA vez que se ve este `svixId`
   * (procesar el webhook con normalidad); `false` si ya se había visto
   * antes — un replay, que quien exponga el endpoint HTTP debe responder
   * como `409 Conflict` (o simplemente ignorar) sin volver a aplicar el
   * efecto de negocio (`applyMailWebhookEvent`).
   */
  claim(svixId: string, toleranceSeconds: number, now: number): Promise<boolean>;
}

interface SeenEntry {
  /** Milisegundos Unix en los que se vio por primera vez este `svixId`. */
  seenAtMs: number;
}

/**
 * Implementación en memoria — SOLO para pruebas y para un handler sin
 * persistencia configurada (el mismo criterio que `InMemorySendRecordStore`
 * y `InMemorySuppressionStore`). Purga entradas más viejas que el doble de
 * la ventana de tolerancia en cada `claim()` para no crecer sin límite en un
 * proceso de larga vida.
 */
export class InMemoryWebhookReplayGuard implements WebhookReplayGuard {
  private readonly seen = new Map<string, SeenEntry>();

  async claim(svixId: string, toleranceSeconds: number, now: number): Promise<boolean> {
    this.purgeExpired(toleranceSeconds, now);
    if (this.seen.has(svixId)) return false;
    this.seen.set(svixId, { seenAtMs: now });
    return true;
  }

  private purgeExpired(toleranceSeconds: number, now: number): void {
    const maxAgeMs = Math.max(toleranceSeconds, 0) * 1000 * 2;
    for (const [id, entry] of this.seen) {
      if (now - entry.seenAtMs > maxAgeMs) this.seen.delete(id);
    }
  }

  /** Conveniencia de pruebas: cuántos `svixId` distintos se han visto. */
  size(): number {
    return this.seen.size;
  }
}
