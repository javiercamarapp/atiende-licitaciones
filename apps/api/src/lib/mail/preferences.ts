import type { FastifyInstance } from 'fastify';
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@atiende/mail';

/**
 * REQ-181..195: las 8 categorías de notificación APAGABLES, tal cual se
 * llaman las columnas de `notification_preferences` (migración 0082). Las
 * obligatorias (`account_security`, `internal`) no están aquí a propósito:
 * no se pueden apagar -- `isCategoryEnabled` de packages/mail nunca las
 * consulta.
 *
 * Esta lista es CERRADA y vive solo en este archivo: es la única fuente de
 * la que sale un nombre de columna para interpolar en SQL (ver
 * `setNotificationPreferences`), nunca un valor del cuerpo de una petición.
 */
export const OPTIONAL_CATEGORIES = [
  'tender_matches',
  'tender_changes',
  'approvals',
  'submission',
  'deadlines',
  'document_expiration',
  'post_award',
  'weekly_summary',
] as const;

export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];

/** Columna (snake_case, como la tabla) -> llave de `NotificationPreferences` (camelCase, como packages/mail). */
export const COLUMN_TO_KEY: Record<OptionalCategory, keyof NotificationPreferences> = {
  tender_matches: 'tenderMatches',
  tender_changes: 'tenderChanges',
  approvals: 'approvals',
  submission: 'submission',
  deadlines: 'deadlines',
  document_expiration: 'documentExpiration',
  post_award: 'postAward',
  weekly_summary: 'weeklySummary',
};

export function isOptionalCategory(value: unknown): value is OptionalCategory {
  return typeof value === 'string' && (OPTIONAL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Preferencias vigentes de un usuario. AUSENCIA DE FILA == todo activado:
 * es una lista de EXCLUSIÓN, no de opt-in (ver
 * `DEFAULT_NOTIFICATION_PREFERENCES` de packages/mail) -- un aviso de plazo
 * que nunca llegó por defecto es peor que uno de más.
 *
 * Se lee con el contexto RLS del propio usuario (`app.current_user_id`
 * fijado al id que el llamador ya verificó: el `sub` de un access token, o
 * el `userId` de un enlace firmado), nunca con una función SECURITY DEFINER
 * que pudiera leer las de cualquiera.
 */
export async function readNotificationPreferences(
  app: FastifyInstance,
  userId: string
): Promise<Required<NotificationPreferences>> {
  const { rows } = await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    return tx.query<Record<OptionalCategory, boolean>>(
      `select ${OPTIONAL_CATEGORIES.join(', ')} from notification_preferences where user_id = $1`,
      [userId]
    );
  });
  const row = rows[0];
  if (!row) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  const result = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const column of OPTIONAL_CATEGORIES) {
    result[COLUMN_TO_KEY[column]] = row[column];
  }
  return result;
}

/**
 * Actualiza las categorías indicadas (las omitidas se dejan como estaban).
 * La fila se crea perezosamente en la primera edición (ver 0082).
 */
export async function setNotificationPreferences(
  app: FastifyInstance,
  userId: string,
  updates: Partial<Record<keyof NotificationPreferences, boolean>>
): Promise<void> {
  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    await tx.query('insert into notification_preferences (user_id) values ($1) on conflict (user_id) do nothing', [userId]);
    for (const column of OPTIONAL_CATEGORIES) {
      const value = updates[COLUMN_TO_KEY[column]];
      if (value === undefined) continue;
      // `column` sale SIEMPRE de OPTIONAL_CATEGORIES (lista cerrada arriba),
      // jamás del cuerpo de la petición; el valor va como parámetro.
      await tx.query(`update notification_preferences set ${column} = $1 where user_id = $2`, [value, userId]);
    }
  });
}
