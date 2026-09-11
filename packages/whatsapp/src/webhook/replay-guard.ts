/**
 * REQ-074: "Webhooks de WhatsApp idempotentes por `wamid`". A diferencia del
 * guardia de replay de `@atiende/mail` (`WebhookReplayGuard`, ventana de
 * tolerancia de unos minutos porque Svix puede reenviar dentro de esa
 * ventana), un `wamid` es un identificador de mensaje GLOBAL Y PERMANENTE
 * de Meta — nunca se reutiliza, así que "ya lo vi" nunca expira: la
 * deduplicación aquí es simplemente "primera vez sí, cualquier repetición
 * después no", sin ventana de tiempo.
 *
 * Interfaz PURA, sin persistencia real — mismo criterio que
 * `WebhookReplayGuard` de `@atiende/mail`: este paquete no depende de
 * ninguna base de datos. `apps/api` la implementa sobre una tabla real
 * (`whatsapp_webhook_events_seen`, `packages/db/migrations/0099...sql`).
 */
export interface WamidReplayGuard {
  /** Compare-and-set atómico: `true` la PRIMERA vez que se ve este `wamid`
   *  (procesar la interacción con normalidad); `false` si ya se había visto
   *  — una entrega duplicada del mismo mensaje (Meta reintenta si el
   *  webhook no responde 200 a tiempo), que se debe tratar como no-op SIN
   *  volver a disparar ningún efecto de negocio. */
  claim(wamid: string): Promise<boolean>;
}

/** Implementación en memoria — SOLO para pruebas (mismo criterio que
 *  `InMemoryWebhookReplayGuard` de `@atiende/mail`). */
export class InMemoryWamidReplayGuard implements WamidReplayGuard {
  private readonly seen = new Set<string>();

  async claim(wamid: string): Promise<boolean> {
    if (this.seen.has(wamid)) return false;
    this.seen.add(wamid);
    return true;
  }

  /** Conveniencia de pruebas: cuántos `wamid` distintos se han visto. */
  size(): number {
    return this.seen.size;
  }
}
