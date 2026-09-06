import type { DbClient } from '@atiende/db';
import type { SuppressionEntry, SuppressionReason, SuppressionStore } from '@atiende/mail';

/**
 * Implementación real de `SuppressionStore` (packages/mail/src/suppression/types.ts)
 * sobre `mail_suppressions` (packages/db/migrations/0081...sql). DENY-ALL:
 * una dirección aquí no vuelve a recibir correo hasta `unsuppress()`
 * manual. `MailService` ya trata cualquier error de esta clase como
 * "suprimido" (fail-closed, ver su propio código) -- esta clase no
 * necesita implementar esa parte, solo dejar que la excepción se
 * propague.
 */
export class PgSuppressionStore implements SuppressionStore {
  constructor(private readonly db: DbClient) {}

  async isSuppressed(email: string): Promise<boolean> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ suppressed: boolean }>('select app.mail_suppression_check($1) as suppressed', [email]);
    });
    return rows[0]?.suppressed ?? false;
  }

  async suppress(email: string, reason: SuppressionReason, source: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_suppression_add($1, $2, $3)', [email, reason, source]);
    });
  }

  async unsuppress(email: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_suppression_remove($1)', [email]);
    });
  }

  async get(email: string): Promise<SuppressionEntry | undefined> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ email: string; reason: SuppressionReason; source: string; created_at: string }>(
        'select * from app.mail_suppression_get($1)',
        [email],
      );
    });
    const row = rows[0];
    if (!row) return undefined;
    return { email: row.email, reason: row.reason, source: row.source, createdAt: row.created_at };
  }
}
