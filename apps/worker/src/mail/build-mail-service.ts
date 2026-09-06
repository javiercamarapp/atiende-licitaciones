import type { DbClient } from '@atiende/db';
import { MailService, TokenBucketRateLimiter, createMailProviderFromEnv, type MailProvider } from '@atiende/mail';
import { PgMailOutboxStore, PgMailSuppressionStore } from './pg-mail-stores.js';

export interface BuildMailServiceForWorkerOptions {
  db: DbClient;
  env?: NodeJS.ProcessEnv;
  /** Inyectable para pruebas: un `MailProvider` explícito en vez del que
   *  resolvería `MAIL_PROVIDER` (ver `createMailProviderFromEnv`). Es la
   *  MISMA costura de inyección que `apps/api/src/lib/mail/env.ts`
   *  documenta para su propio `buildMailServiceFromEnv`. */
  provider?: MailProvider;
  /** Inyectable para pruebas: evita los `setTimeout` REALES del backoff
   *  interno de `MailService` (`packages/mail/src/service/retry.ts`,
   *  `DEFAULT_RETRY_POLICY`) cuando un test necesita forzar varios
   *  intentos fallidos deliberadamente -- sin esto, una prueba de "agota
   *  reintentos" tarda segundos de verdad y se vuelve inestable bajo la
   *  contención de la suite completa (mismo síntoma documentado como
   *  WK6-03 en `apps/worker/README.md`). En producción nunca se pasa. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BuiltWorkerMailService {
  mail: MailService;
  provider: MailProvider;
  /** Expuesto además del `MailService` porque `reopenDeadForRetry()` (0087)
   *  es una operación fuera del contrato genérico `SendRecordStore` que
   *  necesita `apps/worker/src/handlers/mail-retry.ts` -- ver esa función. */
  outboxStore: PgMailOutboxStore;
}

/**
 * REQ-188 (S7): el `MailService` que usa el handler `mail_retry` de
 * `apps/worker` para re-intentar un correo transaccional cuyo primer envío
 * (desde `apps/api`) agotó los reintentos internos de `MailService` y quedó
 * `dead` en `mail_outbox` (0080/0086).
 *
 * Deliberadamente EQUIVALENTE a `apps/api/src/lib/mail/env.ts`
 * (`buildMailServiceFromEnv`) -- el docstring de
 * `apps/api/src/lib/mail/send-transactional.ts` documenta explícitamente
 * que el `MailService` de `apps/worker` "solo depende de `DbClient` +
 * variables de entorno, ninguna de las dos exclusiva de `apps/api`" -- pero
 * implementado de forma independiente dentro de `apps/worker/**` (ver nota
 * de "DUPLICADA A PROPÓSITO" en `pg-mail-stores.ts`), no importado de
 * `apps/api`, que está fuera de este ámbito.
 *
 * Diferencia deliberada: SIN `linkSigner`. El worker nunca genera un enlace
 * firmado nuevo -- `job.payload.variables` ya trae, tal cual, las variables
 * COMPLETAS con las que `apps/api` renderizó el intento original (incluido
 * cualquier `verificationUrl`/`resetUrl` ya firmado en ese momento); volver
 * a firmar aquí cambiaría el enlace del correo reintentado sin necesidad
 * (y exigiría propagar `MAIL_LINK_SECRET`, que este flujo no necesita).
 *
 * `MAIL_PROVIDER` ausente o desconocido degrada a `CaptureProvider` (mismo
 * criterio que `createMailProviderFromEnv`, packages/mail): un despliegue
 * sin credenciales de proveedor real nunca intenta salir a la red desde
 * este reintento tampoco.
 */
export function buildMailServiceForWorker(options: BuildMailServiceForWorkerOptions): BuiltWorkerMailService {
  const env = options.env ?? process.env;
  const provider = options.provider ?? createMailProviderFromEnv(env);
  const store = new PgMailOutboxStore(options.db);
  const suppressionStore = new PgMailSuppressionStore(options.db);
  // Mismo límite que apps/api (packages/mail/src/service/rate-limiter.ts):
  // 20 correos de arranque, luego ~2/minuto sostenido por destinatario --
  // suficiente para cualquier flujo legítimo de reintento (nunca más de un
  // puñado de mensajes reintentados a la misma dirección en poco tiempo).
  const rateLimiter = new TokenBucketRateLimiter(20, 1 / 30);

  return {
    mail: new MailService({ provider, store, suppressionStore, rateLimiter, sleep: options.sleep }),
    provider,
    outboxStore: store,
  };
}
