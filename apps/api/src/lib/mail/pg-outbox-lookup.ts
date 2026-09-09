import type { DbClient } from '@atiende/db';

export interface OutboxEntry {
  toEmail: string | null;
  status: string;
}

/**
 * AM-03 (docs/auditoria-2/api-mail.md, ALTA): antes de que un webhook de
 * correo (firma Svix ya verificada, `modules/mail/webhook.routes.ts`)
 * pueda suprimir una dirección por rebote/queja, hay que comprobar que el
 * `provider_message_id` (`email_id` de Resend) referenciado corresponde a
 * un envío REAL de este entorno -- y no solo a un payload con firma válida
 * pero con un `email_id`/destinatario inventados (el vector exacto que
 * demostró la auditoría: firma real + `email_id` que nunca existió en
 * `mail_outbox` -> supresión de una dirección que nunca recibió nada
 * nuestro, incluido correo de SEGURIDAD de una cuenta real).
 *
 * `mail_outbox` (packages/db/migrations/0080_req181_mail_outbox.sql) es
 * una tabla de sistema con RLS habilitada SIN políticas -- por diseño,
 * "todo acceso pasa por las funciones SECURITY DEFINER" que expone esa
 * migración (`app.mail_outbox_reserve/get/save/release/peek`), NINGUNA de
 * las cuales busca por `provider_message_id` (todas indexan por
 * `dedupe_key`, que el webhook no conoce -- solo tiene `email_id`/
 * destinatario). Añadir esa función es un cambio de `packages/db`, fuera
 * del ámbito asignado a esta ronda de correcciones (ver
 * docs/logs/fix-api-mail.log); mientras esa función no exista, esta clase
 * hace la MISMA consulta de solo lectura que haría esa función, con la
 * MISMA forma acotada y parametrizada (una columna, un `where` por clave
 * exacta, `limit 1`) -- usando `db.query` DIRECTO, sin `set local role
 * app_role`, exactamente el mismo patrón (y la misma razón: "como
 * propietario de las migraciones, sin pasar por RLS") que
 * `apps/api/test/helpers.ts#registerAndLogin` ya usa para escribir en
 * `users` fuera de cualquier sesión. Es una excepción DELIBERADA y
 * acotada al patrón "todo va por `app_role`" del resto de `apps/api` --
 * queda documentada aquí para que una ronda futura con `packages/db` en su
 * ámbito la reemplace por `app.mail_outbox_find_by_provider_message_id`
 * (SECURITY DEFINER) sin cambiar el contrato de esta clase.
 *
 * `to_email`: hasta este fix, `PgSendRecordStore.reserve()`/`save()`
 * (mismo directorio) nunca la escribían -- `SendRecordStore`
 * (packages/mail) es agnóstico del destinatario, así que la columna
 * quedaba SIEMPRE NULL para cualquier envío real. `send-transactional.ts`
 * (único punto de `apps/api` que arma un `messageKey`, ver su propio
 * docstring) ahora la respalda justo después de `app.mail.send()` --
 * ver ese archivo para el porqué de ese punto concreto.
 */
export class PgOutboxLookup {
  constructor(private readonly db: DbClient) {}

  async findByProviderMessageId(providerMessageId: string): Promise<OutboxEntry | undefined> {
    const { rows } = await this.db.query<{ to_email: string | null; status: string }>(
      'select to_email, status from mail_outbox where provider_message_id = $1 order by updated_at desc limit 1',
      [providerMessageId]
    );
    const row = rows[0];
    if (!row) return undefined;
    return { toEmail: row.to_email, status: row.status };
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * AM-03: ¿este evento de webhook corresponde a un envío real de este
 * entorno? Exige `providerMessageId` presente (un payload sin `email_id`
 * no es rastreable a NINGÚN envío nuestro -- ver
 * `parse-resend-payload.ts`, que solo lo hace opcional para no lanzar ante
 * un payload incompleto, nunca para autorizar suprimir sin él) y que el
 * `to_email` de esa fila coincida con el `email` del evento -- una firma
 * Svix válida prueba que el payload lo mandó Resend, NUNCA que el
 * `email_id` que trae dentro sea el correcto (Resend no vincula eso por
 * nosotros).
 */
export async function isCoherentOutboxEvent(
  lookup: PgOutboxLookup,
  event: { providerMessageId?: string; email: string }
): Promise<{ coherent: true } | { coherent: false; reason: 'sin_provider_message_id' | 'sin_envio_correspondiente' }> {
  if (!event.providerMessageId) {
    return { coherent: false, reason: 'sin_provider_message_id' };
  }
  const entry = await lookup.findByProviderMessageId(event.providerMessageId);
  if (!entry || !entry.toEmail || normalizeEmail(entry.toEmail) !== normalizeEmail(event.email)) {
    return { coherent: false, reason: 'sin_envio_correspondiente' };
  }
  return { coherent: true };
}
