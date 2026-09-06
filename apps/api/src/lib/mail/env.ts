import type { DbClient } from '@atiende/db';
import type { MailProvider } from '@atiende/mail';
import { MailService, createLinkSigner, createMailProviderFromEnv, TokenBucketRateLimiter } from '@atiende/mail';
import { PgSendRecordStore } from './pg-send-record-store.js';
import { PgSuppressionStore } from './pg-suppression-store.js';

export interface BuildMailServiceOptions {
  db: DbClient;
  mailLinkSecret: string;
  env?: NodeJS.ProcessEnv;
}

export interface BuiltMailService {
  mail: MailService;
  /**
   * El `MailProvider` REAL que quedó configurado. Se devuelve (y se decora
   * como `app.mailProvider`) por dos motivos, ninguno de ellos "para las
   * pruebas y ya": (1) sin proveedor configurado es un `CaptureProvider`, y
   * poder inspeccionar qué se habría mandado es justo lo que hace que ese
   * estado degradado sea AUDITABLE en vez de un agujero negro (mismo
   * criterio que `MAIL_CAPTURE_FILE`); (2) las pruebas de integración de
   * correo de `apps/api` verifican el contenido real del correo (asunto,
   * enlace firmado, cabeceras List-Unsubscribe) sin salir a la red.
   */
  provider: MailProvider;
}

/**
 * Construye el `MailService` único de `apps/api` (decorado como `app.mail`
 * en `src/app.ts`) a partir de variables de entorno -- ver
 * packages/mail/README.md §Variables de entorno.
 *
 * `MAIL_PROVIDER` decide el `MailProvider` real (`createMailProviderFromEnv`,
 * packages/mail): sin ella (o con un valor desconocido), degrada a
 * `CaptureProvider` -- nunca sale a Internet por accidente, mismo criterio
 * en desarrollo/pruebas y en un despliegue al que aún no se le
 * configuraron credenciales reales (RESEND_API_KEY/POSTMARK_SERVER_TOKEN/
 * SMTP_*, todas "PENDIENTE del usuario" documentadas en ese README).
 *
 * El outbox (`PgSendRecordStore`) y la lista de supresión
 * (`PgSuppressionStore`) son SIEMPRE la implementación real sobre Postgres
 * -- nunca las variantes en memoria de packages/mail (esas son solo para
 * las pruebas UNITARIAS de ese paquete) -- así que la idempotencia/outbox y
 * la supresión sobreviven un reinicio del proceso incluso en desarrollo.
 *
 * Límite de tasa por destinatario (`TokenBucketRateLimiter`): protege
 * contra una ráfaga hacia una sola dirección (p.ej. un bug que reintente
 * `sendTransactionalMail` en bucle) -- capacidad de 20 con relleno de
 * ~1 cada 30s (20 correos de arranque, luego ~2/minuto sostenido),
 * generoso para cualquier flujo legítimo de este catálogo (ningún usuario
 * recibe más de un puñado de correos de seguridad/avisos en una sola
 * sesión).
 */
export function buildMailServiceFromEnv(options: BuildMailServiceOptions): BuiltMailService {
  const env = options.env ?? process.env;
  const provider = createMailProviderFromEnv(env);
  const store = new PgSendRecordStore(options.db);
  const suppressionStore = new PgSuppressionStore(options.db);
  const linkSigner = createLinkSigner(options.mailLinkSecret);
  const rateLimiter = new TokenBucketRateLimiter(20, 1 / 30);

  return { mail: new MailService({ provider, store, suppressionStore, linkSigner, rateLimiter }), provider };
}
