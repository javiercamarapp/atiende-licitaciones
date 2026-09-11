import type { DbClient } from '@atiende/db';
import type { WamidReplayGuard } from '@atiende/whatsapp';

/**
 * Implementación real de `WamidReplayGuard` (`@atiende/whatsapp`, REQ-074)
 * sobre `whatsapp_webhook_events_seen` (packages/db/migrations/
 * 0105_req090_whatsapp_interactive_webhook.sql). Usada por
 * `POST /webhooks/whatsapp` (`modules/whatsapp/webhook.routes.ts`).
 *
 * Mismo patrón que `PgWebhookReplayGuard` (`lib/mail/pg-webhook-replay-guard.ts`),
 * pero SIN ventana de tolerancia: un `wamid` nunca expira (ver el docstring
 * de `WamidReplayGuard` en el paquete para el porqué).
 */
export class PgWamidReplayGuard implements WamidReplayGuard {
  constructor(private readonly db: DbClient) {}

  async claim(wamid: string): Promise<boolean> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ claimed: boolean }>('select app.whatsapp_webhook_claim($1) as claimed', [wamid]);
    });
    return rows[0]?.claimed ?? false;
  }
}
