import type { DbClient } from '@atiende/db';
import type { WebhookReplayGuard } from '@atiende/mail';

/**
 * Implementación real de `WebhookReplayGuard` (packages/mail/src/webhooks/replay-guard.ts,
 * ML-05) sobre `mail_webhook_events_seen` (packages/db/migrations/0081...sql).
 * Usada por `POST /webhooks/mail/:provider`
 * (`modules/notifications/webhook.routes.ts`) vía
 * `verifyResendWebhookSignatureWithReplayGuard()`.
 */
export class PgWebhookReplayGuard implements WebhookReplayGuard {
  constructor(private readonly db: DbClient) {}

  async claim(svixId: string, toleranceSeconds: number): Promise<boolean> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ claimed: boolean }>('select app.mail_webhook_claim($1, $2) as claimed', [svixId, Math.round(toleranceSeconds)]);
    });
    return rows[0]?.claimed ?? false;
  }
}
