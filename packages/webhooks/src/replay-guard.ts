/**
 * Anti-replay genérico para webhooks entrantes (REQ-096; generaliza el
 * `WebhookReplayGuard` que antes vivía solo en `@atiende/mail` bajo el
 * nombre de parámetro `svixId`, atado a ese proveedor). Una firma HMAC
 * válida (ver `hmac.ts`/`verify.ts`) solo prueba que el cuerpo lo mandó
 * quien conoce el secreto compartido — NO impide que la MISMA petición
 * capturada (mismo `eventId`, cuerpo y firma) se reenvíe cuantas veces se
 * quiera dentro de la ventana de tolerancia del timestamp, porque volvería
 * a verificar como válida. Este módulo es el contrato de deduplicación por
 * `event_id` que cierra esa ventana — una interfaz, SIN persistencia real,
 * el mismo criterio que `SendRecordStore` de `@atiende/mail`.
 *
 * Cada proveedor nuevo de webhooks implementa esto contra una tabla/caché
 * real de vida corta con un TTL de al menos `toleranceSeconds` (p. ej. una
 * fila en Postgres con `expires_at`, o una llave de Redis con
 * `EXPIRE toleranceSeconds`) — `apps/api` ya tiene un ejemplo real contra
 * Postgres para el webhook de correo (`PgWebhookReplayGuard`).
 */
export interface WebhookReplayGuard {
  /**
   * Compare-and-set atómico: `true` la PRIMERA vez que se ve este
   * `eventId` (procesar el webhook con normalidad); `false` si ya se había
   * visto antes — un replay, que quien exponga el endpoint HTTP debe
   * responder como `409 Conflict` (o simplemente ignorar) sin volver a
   * aplicar el efecto de negocio del webhook.
   *
   * `eventId` debe ser único por PROVEEDOR — dos proveedores distintos
   * pueden coincidir en el mismo valor de id de evento sin que eso cuente
   * como replay entre ellos; namespacear (`"resend:msg_123"`,
   * `"whatsapp:wamid.abc"`, etc.) es responsabilidad de quien implemente o
   * instancie el guardia, no de este contrato.
   */
  claim(eventId: string, toleranceSeconds: number, now: number): Promise<boolean>;
}

interface SeenEntry {
  /** Milisegundos Unix en los que se vio por primera vez este `eventId`. */
  seenAtMs: number;
}

/**
 * Implementación en memoria — SOLO para pruebas y para un handler sin
 * persistencia configurada (el mismo criterio que `InMemorySendRecordStore`
 * de `@atiende/mail`). Purga entradas más viejas que el doble de la ventana
 * de tolerancia en cada `claim()` para no crecer sin límite en un proceso
 * de larga vida.
 */
export class InMemoryWebhookReplayGuard implements WebhookReplayGuard {
  private readonly seen = new Map<string, SeenEntry>();

  async claim(eventId: string, toleranceSeconds: number, now: number): Promise<boolean> {
    this.purgeExpired(toleranceSeconds, now);
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, { seenAtMs: now });
    return true;
  }

  private purgeExpired(toleranceSeconds: number, now: number): void {
    const maxAgeMs = Math.max(toleranceSeconds, 0) * 1000 * 2;
    for (const [id, entry] of this.seen) {
      if (now - entry.seenAtMs > maxAgeMs) this.seen.delete(id);
    }
  }

  /** Conveniencia de pruebas: cuántos `eventId` distintos se han visto. */
  size(): number {
    return this.seen.size;
  }
}
