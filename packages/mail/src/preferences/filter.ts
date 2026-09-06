import { CATEGORY_PREFERENCE_KEY, isMandatoryCategory, type NotificationCategory, type NotificationPreferences } from "./types";

/**
 * ¿Se debe mandar un correo de esta categoría a alguien con estas
 * preferencias? Las categorías obligatorias siempre pasan. Las opcionales
 * pasan salvo que el usuario las haya apagado explícitamente (`false`) —
 * `undefined` es "todavía no eligió", y el default de esta librería es
 * mandar (ver `DEFAULT_NOTIFICATION_PREFERENCES`).
 */
export function isCategoryEnabled(category: NotificationCategory, preferences: NotificationPreferences | undefined): boolean {
  if (isMandatoryCategory(category)) return true;
  const key = CATEGORY_PREFERENCE_KEY[category];
  if (!key) return true;
  const value = preferences?.[key];
  return value !== false;
}
