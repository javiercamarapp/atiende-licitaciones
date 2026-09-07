-- 0090_req_whatsapp_user_phone.sql
-- Número de teléfono para el canal ADICIONAL de WhatsApp (@atiende/whatsapp,
-- Meta Business Cloud API) de los avisos de "tender_matches" y "submission".
--
-- Por USUARIO (no por organización), igual que `notification_preferences`
-- (0082) y el propio destinatario de correo (`users.email` vía
-- `RegisteredRecipient`, `apps/api/src/lib/mail/recipients.ts`): la
-- notificación -- de correo o de WhatsApp -- es para una PERSONA con sus
-- propias preferencias, no para la organización como tal (que puede tener
-- varios miembros, cada uno con su propio número o sin ninguno). Una
-- organización compartida sin una persona destinataria concreta no encaja
-- con el modelo de "un envío por persona" que ya usa todo `lib/mail/`.
--
-- Nullable y sin backfill: la inmensa mayoría de las cuentas existentes no
-- tiene un número capturado todavía -- ausencia de número es un estado
-- válido y esperado (el wiring de WhatsApp en `apps/api` lo trata como
-- "no enviar", nunca como error), no un dato faltante que haya que rellenar.
-- Aditiva: no toca ninguna columna existente ni reordena nada.
--
-- Formato E.164 (`+` seguido de 1 a 15 dígitos, el primero distinto de
-- cero -- ver el comentario de `OutboundWhatsAppMessage.to` en
-- `packages/whatsapp/src/provider/types.ts`), el mismo formato que ya
-- documenta ese paquete como contrato de entrada. El CHECK solo se evalúa
-- cuando la columna NO es null (comportamiento estándar de Postgres para
-- restricciones sobre columnas nullable) -- una fila sin número guardado
-- nunca viola la restricción.
alter table users add column if not exists whatsapp_phone_e164 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_users_whatsapp_phone_e164_format'
  ) then
    alter table users
      add constraint ck_users_whatsapp_phone_e164_format
      check (whatsapp_phone_e164 is null or whatsapp_phone_e164 ~ '^\+[1-9][0-9]{1,14}$');
  end if;
end
$$;
