import type { DbClient } from '@atiende/db';
import type { WebhookReplayGuard } from '@atiende/webhooks';

/**
 * REQ-096: implementación real de `WebhookReplayGuard` (`@atiende/webhooks`)
 * sobre la tabla GENÉRICA `webhook_events_seen`
 * (`packages/db/migrations/0106_req096_generic_webhook_replay_guard.sql`),
 * lista para que CUALQUIER webhook entrante nuevo la instancie sin tener
 * que crear su propia tabla/función SQL desde cero — a diferencia de
 * `apps/api/src/lib/mail/pg-webhook-replay-guard.ts` (que sigue existiendo
 * tal cual, sobre `mail_webhook_events_seen`, específica del webhook de
 * correo ya en producción).
 *
 * `provider` namespacea el `event_id` (columna compuesta `(provider,
 * event_id)` en la tabla) para que dos proveedores de webhooks distintos
 * nunca colisionen entre sí si por coincidencia usaran el mismo id de
 * evento — p. ej. `new PgWebhookReplayGuard(app.db, 'whatsapp:meta')`.
 */
export class PgWebhookReplayGuard implements WebhookReplayGuard {
  constructor(
    private readonly db: DbClient,
    private readonly provider: string
  ) {}

  async claim(eventId: string, toleranceSeconds: number): Promise<boolean> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ claimed: boolean }>('select app.webhook_claim($1, $2, $3) as claimed', [
        this.provider,
        eventId,
        Math.round(toleranceSeconds),
      ]);
    });
    return rows[0]?.claimed ?? false;
  }
}
