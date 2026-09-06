import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SendOutcome } from '@atiende/mail';
import { sendTransactionalMail } from './send-transactional.js';
import { registeredUserRecipient, invitedRecipient, internalInboxRecipient } from './recipients.js';

const EMAIL_VERIFICATION_TTL_MINUTES = 30;
const PASSWORD_RESET_TTL_MINUTES = 30;

export interface MinimalUser {
  id: string;
  email: string;
  fullName?: string | null;
}

function displayName(user: MinimalUser): string {
  return user.fullName?.trim() || user.email.split('@')[0];
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
