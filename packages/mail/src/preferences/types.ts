/**
 * Categorías de notificación. Las de `MANDATORY_CATEGORIES` no se pueden
 * apagar desde el centro de preferencias — son seguridad de cuenta
 * (verificación, invitación, contraseña, 2FA) o correo interno (contacto
 * recibido, dirigido al equipo de Atiende, no a un cliente). El resto son
 * avisos operativos del producto: un usuario puede elegir no recibirlos sin
 * perder acceso a su cuenta.
 */
export type NotificationCategory =
  | "account_security"
  | "tender_matches"
  | "tender_changes"
  | "approvals"
  | "submission"
  | "deadlines"
  | "document_expiration"
  | "post_award"
  | "weekly_summary"
  | "internal";

export const MANDATORY_CATEGORIES: readonly NotificationCategory[] = ["account_security", "internal"];

export function isMandatoryCategory(category: NotificationCategory): boolean {
  return MANDATORY_CATEGORIES.includes(category);
}

/**
 * Las preferencias del usuario: una casilla por categoría apagable. `true`
 * (u omitida) significa "sí quiero este correo" — el default de toda cuenta
 * nueva es recibir todo; es una lista de EXCLUSIÓN, no de opt-in, porque un
 * aviso de plazo o de vencimiento de documento que nunca llegó por defecto
 * es peor que uno de más.
 */
export interface NotificationPreferences {
  tenderMatches?: boolean;
  tenderChanges?: boolean;
  approvals?: boolean;
  submission?: boolean;
  deadlines?: boolean;
  documentExpiration?: boolean;
  postAward?: boolean;
  weeklySummary?: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Required<NotificationPreferences> = {
  tenderMatches: true,
  tenderChanges: true,
  approvals: true,
  submission: true,
  deadlines: true,
  documentExpiration: true,
  postAward: true,
  weeklySummary: true,
};

/** Mapeo categoría opcional → llave de `NotificationPreferences`. Las
 *  categorías obligatorias no tienen llave: nunca se consulta. */
export const CATEGORY_PREFERENCE_KEY: Partial<Record<NotificationCategory, keyof NotificationPreferences>> = {
  tender_matches: "tenderMatches",
  tender_changes: "tenderChanges",
  approvals: "approvals",
  submission: "submission",
  deadlines: "deadlines",
  document_expiration: "documentExpiration",
  post_award: "postAward",
  weekly_summary: "weeklySummary",
};
