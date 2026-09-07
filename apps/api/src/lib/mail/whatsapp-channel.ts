import type { FastifyInstance } from 'fastify';
import { isCategoryEnabled } from '@atiende/mail';
import type { NotificationCategory, NotificationPreferences } from '@atiende/mail';
import { createWhatsAppProviderFromEnv } from '@atiende/whatsapp';
import type { WhatsAppEnv, WhatsAppProvider } from '@atiende/whatsapp';

/**
 * Canal ADICIONAL de WhatsApp (`@atiende/whatsapp`, Meta Business Cloud
 * API) para dos categorías de notificación que ya mandan correo:
 * `tender_matches` (nuevo match de convocatoria) y `submission` (paquete de
 * propuesta listo). Ver `packages/whatsapp/README.md` para la restricción
 * real de plantillas pre-aprobadas de Meta.
 *
 * Este módulo NUNCA decide por su cuenta cuándo mandar un aviso -- eso lo
 * deciden los trigger functions de `triggers.ts` (`sendNewTenderMatchEmail`,
 * `sendTenderMatchDigestEmail`, `sendSubmissionPackageReadyEmail`), que
 * mandan el correo PRIMERO y llaman a `sendWhatsAppSideChannel` DESPUÉS,
 * nunca en su lugar.
 */

/**
 * Construye el `WhatsAppProvider` único del proceso -- mismo criterio que
 * `buildMailServiceFromEnv` (`lib/mail/env.ts`): `provider` explícito es una
 * costura de inyección real para pruebas (forzar `not_configured`,
 * `retryable`, etc. sin salir a la red), no un atajo. Sin `WHATSAPP_PROVIDER`
 * (o con uno desconocido), `createWhatsAppProviderFromEnv` ya degrada a
 * `CaptureProvider` -- nunca sale a Internet por accidente en este entorno,
 * que no tiene credenciales reales de Meta configuradas.
 */
export function buildWhatsAppProviderFromEnv(options: { env?: WhatsAppEnv; provider?: WhatsAppProvider } = {}): WhatsAppProvider {
  return options.provider ?? createWhatsAppProviderFromEnv(options.env ?? (process.env as WhatsAppEnv));
}

export interface WhatsAppSideChannelInput {
  /** Para el log si falla -- nunca para decidir nada de negocio aquí. */
  userId: string;
  /** `users.whatsapp_phone_e164` (migración 0090), ya cargado por el
   *  llamador. `null`/`undefined` cuando el usuario no tiene un número
   *  guardado -- eso NO es un error, es el estado normal de casi toda
   *  cuenta hoy: simplemente no se manda nada por este canal. */
  phone: string | null | undefined;
  category: NotificationCategory;
  /**
   * MISMAS `NotificationPreferences` que ya se usaron (o se van a usar) para
   * decidir el correo de esta misma categoría -- este módulo nunca consulta
   * ni inventa una preferencia separada para WhatsApp. `undefined` cuenta
   * como "todo activado", igual que en `isCategoryEnabled` de
   * `@atiende/mail` (lista de EXCLUSIÓN, no de opt-in).
   */
  preferences: NotificationPreferences | undefined;
  /** Nombre exacto de la plantilla aprobada en el WhatsApp Manager de Meta. */
  templateName: string;
  templateParams: Record<string, string>;
  languageCode?: string;
}

/**
 * Envía (si corresponde) el aviso adicional de WhatsApp para una categoría
 * que ya mandó -- o va a mandar -- su correo. Dos compuertas, en orden:
 *
 *  1. `isCategoryEnabled(category, preferences)`: si el usuario apagó esta
 *     categoría, apaga TODOS sus canales -- correo Y WhatsApp -- no solo el
 *     correo. No existe hoy una preferencia separada de "solo WhatsApp" ni
 *     se agrega una: la categoría es del AVISO, no del transporte.
 *  2. `phone`: sin un número guardado no hay a quién mandarle. Ausencia de
 *     número nunca es un error ni bloquea nada.
 *
 * Un resultado `{ok:false}` (incluido `not_configured` -- sin credenciales
 * reales de Meta en este entorno, ver README de `@atiende/whatsapp`) o
 * cualquier excepción al llamar al proveedor se registran en el log y
 * NUNCA se propagan: este canal es un extra, nunca puede tumbar, revertir
 * ni marcar como fallida la operación de negocio (ni el correo, que ya se
 * mandó o se está mandando por su cuenta) que lo originó.
 */
export async function sendWhatsAppSideChannel(app: FastifyInstance, input: WhatsAppSideChannelInput): Promise<void> {
  if (!isCategoryEnabled(input.category, input.preferences)) return;
  if (!input.phone) return;

  try {
    const result = await app.whatsapp.send({
      to: input.phone,
      templateName: input.templateName,
      templateParams: input.templateParams,
      ...(input.languageCode ? { languageCode: input.languageCode } : {}),
    });
    if (!result.ok) {
      app.log.warn(
        {
          userId: input.userId,
          category: input.category,
          templateName: input.templateName,
          kind: result.kind,
        },
        'No se pudo mandar el aviso de WhatsApp (canal adicional; el correo de esta categoría no se ve afectado)'
      );
    }
  } catch (error) {
    app.log.error(
      {
        err: error instanceof Error ? error.message : String(error),
        userId: input.userId,
        category: input.category,
        templateName: input.templateName,
      },
      'Fallo inesperado al mandar el aviso de WhatsApp (canal adicional; el correo de esta categoría no se ve afectado)'
    );
  }
}
