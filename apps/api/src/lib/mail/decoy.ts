import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CaptureProvider, MailService } from '@atiende/mail';
import { PgSendRecordStore } from './pg-send-record-store.js';
import { PgSuppressionStore } from './pg-suppression-store.js';

/**
 * AM-02 (docs/auditoria-2/api-mail.md, ALTA): `/auth/password/forgot` y
 * `/auth/email/resend-verification` medían 8.34x/5.83x de diferencia de
 * mediana de latencia entre cuenta existente e inexistente -- el mismo
 * oráculo de temporización que API-03 ya había cerrado para `/auth/login`.
 * La causa: el trabajo real (`sendEmailVerification`/`sendPasswordResetEmail`
 * -> `MailService.send()`: render de la plantilla + supresión + reserva de
 * `mail_outbox`) solo se disparaba cuando la cuenta era elegible, y aunque se
 * dispara SIN `await` (`fireAndForgetMail`), ese trabajo compite por CPU con
 * la propia respuesta HTTP antes de que termine de enviarse (igual que el
 * `verifyPassword` de `/auth/login` antes de API-03).
 *
 * La reparación es el MISMO principio que API-03: ejecutar SIEMPRE un
 * trabajo real de costo equivalente, exista o no la cuenta -- nunca decidir
 * antes si "vale la pena" pagar el costo según el resultado de
 * `findUserForMail`. Cuando la cuenta no es elegible, este módulo dispara un
 * envío DECOY con la MISMA plantilla real (mismo render, misma consulta de
 * supresión, misma reserva de `mail_outbox`) pero:
 *
 *  - SIEMPRE a través de un `CaptureProvider` propio, dedicado, que nunca es
 *    el `MailProvider` real configurado por `MAIL_PROVIDER` -- si se
 *    reutilizara `app.mail` (que en producción puede ser Resend/Postmark/SMTP
 *    real), un decoy que sale a la red mandaría un correo real con apariencia
 *    de restablecimiento de contraseña a CUALQUIER dirección que el llamador
 *    haya escrito en el cuerpo de la petición -- un vector de abuso (relé de
 *    correo/spam a terceros) bastante peor que el oráculo de temporización
 *    que se busca cerrar. `CaptureProvider` nunca hace red ni disco (no se le
 *    pasa `filePath`), así que un decoy jamás sale del proceso.
 *  - a una dirección/`userId` fijos, sin ninguna vinculación con el correo
 *    real que mandó el llamador ni con ninguna cuenta real -- nunca se debe
 *    poder distinguir un decoy de un envío real por su contenido, pero
 *    tampoco debe existir NINGÚN canal por el que un decoy alcance a un
 *    tercero real.
 *  - con un `messageKey` único por invocación (`randomUUID()`): reutilizar
 *    uno fijo haría que la reserva de `mail_outbox` (idempotente) acortara
 *    cada decoy repetido después del primero, reabriendo el mismo oráculo en
 *    sentido inverso.
 */
const DECOY_RECIPIENT = { email: 'oraculo-decoy@atiende.invalid', userId: 'oraculo-decoy-am02', status: 'active' as const };

const DECOY_VARIABLES_BY_TEMPLATE = {
  'email-verification': {
    recipientName: 'Oráculo AM-02',
    appUrl: 'https://decoy.atiende.invalid',
    supportEmail: 'decoy@atiende.invalid',
    verificationUrl: 'https://decoy.atiende.invalid/verificar-correo?d=decoy&s=decoy',
    expiresInMinutes: 30,
  },
  'password-reset': {
    recipientName: 'Oráculo AM-02',
    appUrl: 'https://decoy.atiende.invalid',
    supportEmail: 'decoy@atiende.invalid',
    resetUrl: 'https://decoy.atiende.invalid/restablecer-contrasena?d=decoy&s=decoy',
    expiresInMinutes: 30,
  },
} as const;

export type DecoyMailTemplateId = keyof typeof DECOY_VARIABLES_BY_TEMPLATE;

/**
 * Un `MailService` decoy por instancia de `app`, memoizado en un `WeakMap`
 * (nunca en `app.decorate`: este módulo vive en `lib/mail`, fuera del
 * alcance de `app.ts` en esta ronda de correcciones) -- construirlo de
 * nuevo en cada petición pagaría el costo de instanciar sus dependencias
 * cada vez, lo que introduciría SU PROPIA asimetría si una petición lo
 * reutiliza (conexión ya "caliente") y otra no.
 */
const decoyServices = new WeakMap<FastifyInstance, MailService>();

function getDecoyMailService(app: FastifyInstance): MailService {
  const existing = decoyServices.get(app);
  if (existing) return existing;
  const decoy = new MailService({
    // CaptureProvider fresco, SIN `filePath`: nunca red, nunca disco --
    // deliberadamente independiente de `app.mailProvider` (ver docstring del
    // módulo).
    provider: new CaptureProvider(),
    // Misma tienda real (`mail_outbox`) que `app.mail`: el costo de la
    // reserva/guardado es lo que hace que el decoy sea comparable, no un
    // simulacro en memoria.
    store: new PgSendRecordStore(app.db),
    suppressionStore: new PgSuppressionStore(app.db),
  });
  decoyServices.set(app, decoy);
  return decoy;
}

/**
 * Una transacción real (mismo rol, mismo roundtrip a Postgres) que no
 * escribe ni lee nada de negocio -- existe SOLO para igualar el costo de
 * las DOS transacciones extra que el camino real paga y el envío por sí
 * solo (`MailService.send()`) no: crear el token de un solo uso
 * (`app.create_email_verification_token`/`app.create_password_reset_token`)
 * y registrar la auditoría (`recordAuthAudit`). Sin esto, AM-02 medía 2.08x
 * en `/auth/password/forgot` -- por debajo del 8.34x original, pero todavía
 * por encima del umbral de 1.5x del propio proyecto.
 */
async function decoyTransaction(app: FastifyInstance): Promise<void> {
  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query('select 1');
  });
}

/**
 * Dispara un envío DECOY de costo equivalente a `sendEmailVerification`/
 * `sendPasswordResetEmail` para la plantilla dada -- ver docstring del
 * módulo. Nunca lanza al llamador cuando el propio `MailService.send()`
 * termina en un estado de fallo (`CaptureProvider.send()` nunca falla, así
 * que en la práctica esto no debería lanzar) -- este módulo no decide qué
 * hacer con un error, eso es responsabilidad de `fireAndForgetMail`, que
 * SIEMPRE envuelve la llamada.
 */
export async function runDecoyMailWork(app: FastifyInstance, templateId: DecoyMailTemplateId): Promise<void> {
  const decoyMail = getDecoyMailService(app);
  // Iguala la transacción de creación del token de un solo uso
  // (`create_email_verification_token`/`create_password_reset_token`) del
  // camino real -- ver docstring de `decoyTransaction`.
  await decoyTransaction(app);
  await decoyMail.send({
    to: DECOY_RECIPIENT,
    templateId,
    variables: DECOY_VARIABLES_BY_TEMPLATE[templateId],
    // Convención de `PgSendRecordStore` (`"<templateId>:<resto>"`) +
    // `randomUUID()` para que cada decoy pague la reserva completa -- ver
    // docstring del módulo.
    messageKey: `${templateId}:decoy-${randomUUID()}`,
  });
  // Iguala la transacción de `recordAuthAudit` (`auth.email_verification_sent`/
  // `auth.password_reset_requested`) del camino real -- ver docstring de
  // `decoyTransaction`.
  await decoyTransaction(app);
}
