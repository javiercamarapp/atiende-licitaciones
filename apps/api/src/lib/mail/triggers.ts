import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { NotificationPreferences, SendOutcome } from '@atiende/mail';
import { formatFechaEs } from '@atiende/mail';
import { sendTransactionalMail } from './send-transactional.js';
import { registeredUserRecipient, invitedRecipient, internalInboxRecipient } from './recipients.js';
import { buildPreferencesUrl, buildUnsubscribeUrl } from './links.js';
import { readNotificationPreferences } from './preferences.js';
import { sendWhatsAppSideChannel } from './whatsapp-channel.js';

const EMAIL_VERIFICATION_TTL_MINUTES = 30;
const PASSWORD_RESET_TTL_MINUTES = 30;

export interface MinimalUser {
  id: string;
  email: string;
  fullName?: string | null;
}

/**
 * `MinimalUser` + el número de WhatsApp de la persona, para los dos
 * disparadores (`tender_matches`, `submission`) que además del correo
 * mandan el aviso ADICIONAL de WhatsApp (ver `whatsapp-channel.ts`). El
 * llamador es quien carga `whatsappPhone` (`users.whatsapp_phone_e164`,
 * migración 0090) -- mismo criterio que el resto de `MinimalUser`: estos
 * trigger functions reciben datos ya leídos, nunca hacen su propia consulta
 * a `users`. `null`/`undefined` cuando la persona no tiene un número
 * guardado -- eso no es un error, WhatsApp simplemente no se manda.
 */
export interface MinimalUserWithPhone extends MinimalUser {
  whatsappPhone?: string | null;
}

function displayName(user: MinimalUser): string {
  return user.fullName?.trim() || user.email.split('@')[0];
}

/**
 * Mismo criterio de `resolvePreferences` (`send-transactional.ts`): un
 * fallo al leer las preferencias NUNCA bloquea el aviso -- se sigue con
 * `undefined` (equivalente a "todo activado", ver
 * `DEFAULT_NOTIFICATION_PREFERENCES`). Se lee UNA sola vez por llamada y el
 * mismo resultado se reusa para decidir el correo Y el WhatsApp -- ninguno
 * de los dos canales consulta una preferencia separada.
 */
async function safeReadPreferences(app: FastifyInstance, userId: string): Promise<NotificationPreferences | undefined> {
  try {
    return await readNotificationPreferences(app, userId);
  } catch (error) {
    app.log.error(
      { err: error instanceof Error ? error.message : String(error), userId },
      'No se pudieron leer las preferencias de notificación; se usan los valores por defecto'
    );
    return undefined;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * REQ-181 (plantilla `email-verification`): crea un token de un solo uso
 * (`email_verification_tokens`, 0084) y manda el correo con un enlace
 * FIRMADO (`mailService.signedLink`) que lleva ambos -- la firma protege
 * contra manipulación/expiración a nivel de transporte; el token en la
 * base de datos es lo que de verdad garantiza el uso único (una firma
 * válida y no vencida NO basta si el token ya fue consumido). Se llama al
 * registrarse (`modules/auth/routes.ts`) y desde
 * `POST /auth/email/resend-verification`.
 */
export async function sendEmailVerification(app: FastifyInstance, user: MinimalUser): Promise<SendOutcome> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenId = randomUUID();
  const tokenHash = hashToken(rawToken);

  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query(
      `select app.create_email_verification_token($1, $2, $3, now() + interval '${EMAIL_VERIFICATION_TTL_MINUTES} minutes')`,
      [tokenId, user.id, tokenHash],
    );
  });

  const verificationUrl = app.mail.signedLink(
    app.config.publicUrl,
    '/verificar-correo',
    { verificationId: tokenId, token: rawToken },
    EMAIL_VERIFICATION_TTL_MINUTES * 60,
  );

  return sendTransactionalMail(app, {
    to: registeredUserRecipient(user),
    templateId: 'email-verification',
    messageKey: `email-verification:${tokenId}`,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      verificationUrl,
      expiresInMinutes: EMAIL_VERIFICATION_TTL_MINUTES,
    },
  });
}

/**
 * REQ-181 (plantilla `organization-invite`): envuelve el token de
 * invitación YA EMITIDO por `POST /organizations/invitations`
 * (`modules/organizations/routes.ts`, sin cambios en su formato/hash) en
 * un enlace firmado con expiración -- capa de defensa en profundidad
 * adicional sobre el propio TTL de `invitations.expires_at`, y el
 * transporte "firmado" que pide la tarea. El destinatario puede NO ser
 * todavía una cuenta de `users` (`invitedRecipient`, ver `recipients.ts`).
 */
export async function sendOrganizationInviteEmail(
  app: FastifyInstance,
  params: {
    invitationId: string;
    email: string;
    organizationId: string;
    organizationName: string;
    inviterName: string;
    roleLabel: string;
    token: string;
    expiresInMinutes: number;
  },
): Promise<SendOutcome> {
  const inviteUrl = app.mail.signedLink(
    app.config.publicUrl,
    '/invitaciones/aceptar',
    { invitationId: params.invitationId, token: params.token },
    params.expiresInMinutes * 60,
  );

  return sendTransactionalMail(app, {
    to: invitedRecipient(params.email, params.invitationId, params.organizationId),
    templateId: 'organization-invite',
    orgId: params.organizationId,
    messageKey: `organization-invite:${params.invitationId}`,
    variables: {
      recipientName: params.email.split('@')[0],
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      organizationName: params.organizationName,
      inviterName: params.inviterName,
      roleLabel: params.roleLabel,
      inviteUrl,
      expiresInMinutes: params.expiresInMinutes,
    },
  });
}

/**
 * REQ-181 (plantilla `password-reset`) + paridad Ronda G (recuperación de
 * contraseña): crea un token de un solo uso (`password_reset_tokens`,
 * 0084) y manda el correo -- llamado SIEMPRE desde
 * `POST /auth/password/forgot`, exista o no la cuenta (anti-enumeración,
 * ver `modules/auth/password.routes.ts`: el caller decide si invoca esto
 * o no, la respuesta HTTP es idéntica en ambos casos).
 */
export async function sendPasswordResetEmail(app: FastifyInstance, user: MinimalUser, requestIp: string | null): Promise<SendOutcome> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenId = randomUUID();
  const tokenHash = hashToken(rawToken);

  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query(
      `select app.create_password_reset_token($1, $2, $3, now() + interval '${PASSWORD_RESET_TTL_MINUTES} minutes')`,
      [tokenId, user.id, tokenHash],
    );
  });

  const resetUrl = app.mail.signedLink(
    app.config.publicUrl,
    '/restablecer-contrasena',
    { resetId: tokenId, token: rawToken },
    PASSWORD_RESET_TTL_MINUTES * 60,
  );

  return sendTransactionalMail(app, {
    to: registeredUserRecipient(user),
    templateId: 'password-reset',
    // Único por SOLICITUD (no por usuario): dos solicitudes de
    // restablecimiento del mismo usuario deben mandar dos correos (cada
    // una con un enlace/token distinto) -- messageKey incluye tokenId.
    messageKey: `password-reset:${tokenId}`,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      resetUrl,
      expiresInMinutes: PASSWORD_RESET_TTL_MINUTES,
      ...(requestIp ? { requestIp } : {}),
    },
  });
}

/** REQ-181 (plantilla `two-factor-enabled`): enviado tras confirmar el enrolamiento (`POST /auth/2fa/verify-enrollment`). */
export async function sendTwoFactorEnabledEmail(app: FastifyInstance, user: MinimalUser): Promise<SendOutcome> {
  return sendTransactionalMail(app, {
    to: registeredUserRecipient(user),
    templateId: 'two-factor-enabled',
    messageKey: `two-factor-enabled:${user.id}:${Date.now()}`,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      activatedAtIso: new Date().toISOString(),
      method: 'app_autenticadora' as const,
      securityUrl: new URL('/cuenta/seguridad', app.config.publicUrl).toString(),
    },
  });
}

/** REQ-181 (plantilla `backup-codes-generated`): enviado al enrolar (`POST /auth/2fa/enroll`), ÚNICO momento en que los códigos existen en claro. */
export async function sendBackupCodesGeneratedEmail(app: FastifyInstance, user: MinimalUser, codes: string[]): Promise<SendOutcome> {
  return sendTransactionalMail(app, {
    to: registeredUserRecipient(user),
    templateId: 'backup-codes-generated',
    messageKey: `backup-codes-generated:${user.id}:${Date.now()}`,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      codes,
      generatedAtIso: new Date().toISOString(),
    },
  });
}

/** Ampliación 2 §2 (plantilla `welcome-onboarding`): enviado al completar el onboarding de una organización. */
export async function sendWelcomeOnboardingEmail(
  app: FastifyInstance,
  user: MinimalUser,
  params: { organizationId: string; organizationName: string; checklist: string[] },
): Promise<SendOutcome> {
  return sendTransactionalMail(app, {
    to: registeredUserRecipient(user, params.organizationId),
    templateId: 'welcome-onboarding',
    orgId: params.organizationId,
    messageKey: `welcome-onboarding:${user.id}:${params.organizationId}`,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      organizationName: params.organizationName,
      onboardingUrl: new URL('/panel', app.config.publicUrl).toString(),
      checklist: params.checklist,
    },
  });
}

/** Ampliación 2 §2 (plantilla `contact-received`): correo INTERNO a `CONTACT_INBOX` cuando llega `POST /public/contact`. */
export async function sendContactReceivedEmail(
  app: FastifyInstance,
  params: { id: string; name: string; email: string; message: string; source: 'landing' | 'formulario_contacto' },
): Promise<SendOutcome> {
  return sendTransactionalMail(app, {
    to: internalInboxRecipient(app.config.contactInbox),
    templateId: 'contact-received',
    messageKey: `contact-received:${params.id}`,
    variables: {
      recipientName: 'Equipo Atiende',
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      contactName: params.name,
      contactEmail: params.email,
      message: params.message,
      receivedAtIso: new Date().toISOString(),
      source: params.source,
      adminUrl: new URL('/admin/contact-requests', app.config.publicUrl).toString(),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// `tender_matches` / `submission` -- las dos categorías que además del
// correo mandan el aviso ADICIONAL de WhatsApp (`whatsapp-channel.ts`, ver
// también `packages/whatsapp/README.md`). Sin disparador de negocio
// todavía cableado a un evento real (el motor de matching real y el
// ensamblado de paquete -- `modules/matching/routes.ts`,
// `modules/expediente/package.routes.ts` -- no llaman a ninguna de las tres
// funciones de abajo hoy): mismo patrón que `sendWelcomeOnboardingEmail`/
// `sendTwoFactorEnabledEmail` arriba, ya usado en este archivo, de dejar la
// función de envío lista (correo + WhatsApp, preferencias, idempotencia)
// para que un futuro caller solo tenga que invocarla con los datos del
// evento real. Los tres siguen el MISMO patrón:
//
//  1. Cargar preferencias UNA sola vez (`safeReadPreferences`).
//  2. Mandar el correo (`sendTransactionalMail`, canal principal, como
//     siempre) pasando esas preferencias explícitas -- para no leerlas dos
//     veces y para garantizar que el correo y el WhatsApp usan EXACTAMENTE
//     la misma respuesta de "¿esta categoría está activa?".
//  3. DESPUÉS -- nunca antes, nunca en su lugar -- intentar el aviso de
//     WhatsApp (`sendWhatsAppSideChannel`), que ya decide por su cuenta si
//     corresponde (categoría activa + número guardado) y nunca lanza.
//  4. Devolver el `SendOutcome` del correo -- WhatsApp es un efecto
//     secundario adicional, no cambia el resultado de la operación de
//     negocio ni el `SendOutcome` reportado al llamador.
// ─────────────────────────────────────────────────────────────────────────

/**
 * REQ-181 (plantilla `new-tender-match`, categoría `tender_matches`): una
 * convocatoria nueva que hace match con el perfil de la organización.
 */
export async function sendNewTenderMatchEmail(
  app: FastifyInstance,
  user: MinimalUserWithPhone,
  params: {
    organizationId: string;
    tenderId: string;
    tenderTitle: string;
    contractingEntity: string;
    matchScore: number;
    estimatedValue: string;
    submissionDeadlineIso: string;
    tenderUrl: string;
  }
): Promise<SendOutcome> {
  const preferences = await safeReadPreferences(app, user.id);

  const outcome = await sendTransactionalMail(app, {
    to: registeredUserRecipient(user, params.organizationId),
    templateId: 'new-tender-match',
    orgId: params.organizationId,
    messageKey: `new-tender-match:${user.id}:${params.tenderId}`,
    preferences,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      preferencesUrl: buildPreferencesUrl(app),
      unsubscribeUrl: buildUnsubscribeUrl(app, user.id, 'tender_matches'),
      tenderTitle: params.tenderTitle,
      contractingEntity: params.contractingEntity,
      matchScore: params.matchScore,
      estimatedValue: params.estimatedValue,
      submissionDeadlineIso: params.submissionDeadlineIso,
      tenderUrl: params.tenderUrl,
    },
  });

  await sendWhatsAppSideChannel(app, {
    userId: user.id,
    phone: user.whatsappPhone,
    category: 'tender_matches',
    preferences,
    // Nombre de plantilla pendiente de alta/aprobación real en el WhatsApp
    // Manager de Meta -- ver packages/whatsapp/README.md. `{{1}}` = título de
    // la convocatoria, `{{2}}` = fecha de cierre (mismo formato es-MX que el
    // correo, `formatFechaEs`).
    templateName: 'nuevo_match_licitacion',
    templateParams: {
      '1': params.tenderTitle,
      '2': formatFechaEs(params.submissionDeadlineIso),
    },
  });

  return outcome;
}

/**
 * REQ-181 (plantilla `tender-match-digest`, categoría `tender_matches`): el
 * digesto de varias coincidencias nuevas en un solo aviso (el motor de
 * matching decide cuál de las dos -- esta o `sendNewTenderMatchEmail` --
 * mandar según la ventana de agregación configurada, ver el comentario de
 * `tender-match-digest.tsx`).
 */
export async function sendTenderMatchDigestEmail(
  app: FastifyInstance,
  user: MinimalUserWithPhone,
  params: {
    organizationId: string;
    /** Identifica ESTA corrida del digesto (p. ej. `${orgId}:${fechaIsoDelDia}`) -- es lo que hace único a `messageKey`, ya que un digesto no tiene un solo `tenderId`. */
    digestId: string;
    matches: Array<{ title: string; contractingEntity: string; matchScore: number }>;
    digestUrl: string;
  }
): Promise<SendOutcome> {
  const preferences = await safeReadPreferences(app, user.id);

  const outcome = await sendTransactionalMail(app, {
    to: registeredUserRecipient(user, params.organizationId),
    templateId: 'tender-match-digest',
    orgId: params.organizationId,
    messageKey: `tender-match-digest:${user.id}:${params.digestId}`,
    preferences,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      preferencesUrl: buildPreferencesUrl(app),
      unsubscribeUrl: buildUnsubscribeUrl(app, user.id, 'tender_matches'),
      matches: params.matches,
      digestUrl: params.digestUrl,
    },
  });

  const first = params.matches[0];
  await sendWhatsAppSideChannel(app, {
    userId: user.id,
    phone: user.whatsappPhone,
    category: 'tender_matches',
    preferences,
    // `{{1}}` = número de coincidencias, `{{2}}` = título de la primera (la
    // plantilla de Meta no admite una tabla -- un digesto completo solo cabe
    // en el correo; WhatsApp es el aviso corto que invita a abrir la app).
    templateName: 'resumen_matches_licitacion',
    templateParams: {
      '1': String(params.matches.length),
      '2': first ? first.title : '',
    },
  });

  return outcome;
}

/**
 * REQ-181 (plantilla `submission-package-ready`, categoría `submission`):
 * el paquete de documentos de una convocatoria ya pasó la revisión de
 * cumplimiento y está listo para presentar.
 */
export async function sendSubmissionPackageReadyEmail(
  app: FastifyInstance,
  user: MinimalUserWithPhone,
  params: {
    organizationId: string;
    tenderId: string;
    tenderTitle: string;
    documentCount: number;
    submissionDeadlineIso: string;
    packageUrl: string;
  }
): Promise<SendOutcome> {
  const preferences = await safeReadPreferences(app, user.id);

  const outcome = await sendTransactionalMail(app, {
    to: registeredUserRecipient(user, params.organizationId),
    templateId: 'submission-package-ready',
    orgId: params.organizationId,
    messageKey: `submission-package-ready:${user.id}:${params.tenderId}`,
    preferences,
    variables: {
      recipientName: displayName(user),
      appUrl: app.config.publicUrl,
      supportEmail: app.config.supportEmail,
      preferencesUrl: buildPreferencesUrl(app),
      unsubscribeUrl: buildUnsubscribeUrl(app, user.id, 'submission'),
      tenderTitle: params.tenderTitle,
      documentCount: params.documentCount,
      submissionDeadlineIso: params.submissionDeadlineIso,
      packageUrl: params.packageUrl,
    },
  });

  await sendWhatsAppSideChannel(app, {
    userId: user.id,
    phone: user.whatsappPhone,
    category: 'submission',
    preferences,
    // `{{1}}` = título de la convocatoria, `{{2}}` = documentos incluidos,
    // `{{3}}` = fecha de cierre (es-MX, `formatFechaEs`).
    templateName: 'paquete_listo_licitacion',
    templateParams: {
      '1': params.tenderTitle,
      '2': String(params.documentCount),
      '3': formatFechaEs(params.submissionDeadlineIso),
    },
  });

  return outcome;
}
