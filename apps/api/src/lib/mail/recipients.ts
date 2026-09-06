import type { RegisteredRecipient } from '@atiende/mail';

/**
 * Un destinatario que SÍ es una cuenta de `users` (activa). El `userId`
 * real (no inventado) es lo que distingue esto de `pseudoRecipient` de
 * abajo -- úsese siempre que exista una fila de `users` de por medio
 * (verificación de correo, restablecimiento de contraseña, 2FA,
 * bienvenida, resumen semanal, etc.).
 */
export function registeredUserRecipient(user: { id: string; email: string }, organizationId?: string): RegisteredRecipient {
  return { email: user.email, userId: user.id, organizationId, status: 'active' };
}

/**
 * REQ-181 (invitación a organización): la persona invitada puede NO ser
 * todavía una cuenta de `users` -- `RegisteredRecipient.status` incluye
 * `"invited"` exactamente para este caso (packages/mail/src/recipients/types.ts).
 * `userId` es el propio id de la invitación (`invitations.id`, único y
 * estable), NUNCA un id de usuario inventado: sigue siendo un identificador
 * real y auditable de ESTE envío, solo que no corresponde a una fila de
 * `users` todavía.
 */
export function invitedRecipient(email: string, invitationId: string, organizationId: string): RegisteredRecipient {
  return { email, userId: invitationId, organizationId, status: 'invited' };
}

/**
 * REQ-181 (contacto interno, `contact-received`): el destinatario es el
 * buzón INTERNO del equipo de Atiende (`config.contactInbox`), no una
 * cuenta de cliente -- `MailService.send()` exige de todos modos un
 * `RegisteredRecipient` (nunca un string suelto), así que se arma un
 * pseudo-registro estable con `userId` fijo (no hay una fila de `users`
 * real detrás, ni falta que la haya: es un buzón operativo, no una
 * persona con preferencias que respetar -- por eso la plantilla
 * `contact-received` es de categoría `internal`, MANDATORY, que
 * `isCategoryEnabled` nunca filtra).
 */
export function internalInboxRecipient(email: string): RegisteredRecipient {
  return { email, userId: 'internal-inbox', status: 'active' };
}
