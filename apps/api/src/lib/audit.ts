import type { DbClient, DbExecutor } from '@atiende/db';

export interface AuditEntry {
  /**
   * `null` SOLO para eventos verdaderamente plataforma-wide sin
   * organización asociada (p.ej. reintentar un job de discovery, o
   * resolver un incidente sin org) -- API-10
   * (docs/auditoria-1/db-api-reverificacion.md): antes se OMITÍA por
   * completo la auditoría en ese caso, en vez de registrarla con
   * `org_id = null` (que `audit_log` ya soporta desde la migración 0035).
   */
  orgId: string | null;
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  /**
   * REQ-171: id de correlación de negocio (ver
   * `plugins/correlation-id.plugin.ts`) -- distinto de `requestId`
   * (técnico, por request HTTP). Se propaga a `audit_log.correlation_id`
   * (migración 0056) para que `GET /audit-log?correlationId=` reconstruya
   * la traza completa de un flujo que puede abarcar varias requests
   * (convocatoria -> matriz -> propuesta -> paquete -> archivo).
   */
  correlationId?: string | null;
}

/** Inserta una entrada de auditoría dentro de la misma transacción de la mutación. */
export async function recordAudit(tx: DbExecutor, entry: AuditEntry): Promise<void> {
  await tx.query(
    `insert into audit_log (org_id, actor_id, action, entity, entity_id, before, after, request_id, correlation_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      entry.orgId,
      entry.actorId,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.before !== undefined ? JSON.stringify(entry.before) : null,
      entry.after !== undefined ? JSON.stringify(entry.after) : null,
      entry.requestId ?? null,
      entry.correlationId ?? null,
    ]
  );
}

export type AuthAuditAction =
  | 'auth.login_succeeded'
  | 'auth.login_failed'
  | 'auth.refresh_succeeded'
  | 'auth.refresh_reuse_detected'
  | 'auth.logout'
  // REQ-172..180 (0072_req177_google_auth_audit.sql): login/vinculación/
  // rechazo de identidad de Google -- ver `modules/auth/google/routes.ts`.
  | 'auth.google_login'
  | 'auth.google_linked'
  // E19/E21 (docs/BACKLOG.md, migración 0093): desvincular la identidad de
  // Google de la propia cuenta -- ver `modules/auth/google/unlink.routes.ts`.
  | 'auth.google_unlinked'
  | 'auth.google_rejected'
  // REQ-181..195 (0084_req_email_verification_and_password_reset.sql):
  // verificación de correo y restablecimiento de contraseña. Los dos
  // eventos `*_sent`/`*_requested` son PRE-AUTENTICACIÓN (no hay sesión
  // que fijar, igual que `auth.login_failed`); los dos `*_verified`/
  // `*_completed` sí tienen una identidad ya verificada por el consumo
  // atómico del token, y `apps/api` fija `app.current_user_id` a ese
  // valor antes de auditar -- ver `modules/auth/mail.routes.ts`.
  | 'auth.email_verification_sent'
  | 'auth.email_verified'
  | 'auth.password_reset_requested'
  | 'auth.password_reset_completed'
  // E21 (docs/BACKLOG.md, migración 0092): cambiar la contraseña propia
  // (autenticado, con step-up) y gestión de sesiones activas propias --
  // cerrar una sesión concreta, o todas menos la actual. Ver
  // `modules/auth/password.routes.ts`/`modules/auth/sessions.routes.ts`.
  | 'auth.password_changed'
  | 'auth.session_revoked'
  | 'auth.sessions_revoked_others';

export interface AuthAuditEntry {
  actorId: string | null;
  action: AuthAuditAction;
  /** NUNCA debe incluir contraseñas ni tokens -- solo metadatos (ip, user-agent, email en login_failed). */
  after?: unknown;
  requestId?: string | null;
  /**
   * REQ-177: brecha honesta cerrada aquí -- id de correlación de negocio
   * (mismo mecanismo que `AuditEntry.correlationId`, ver
   * `plugins/correlation-id.plugin.ts`), antes NUNCA propagado hasta
   * `app.record_auth_event`, así que `audit_log.correlation_id` quedaba
   * NULL en todo evento de autenticación (login, refresh, logout, Google,
   * verificación de correo, restablecimiento de contraseña) -- con
   * paridad exacta entre Google y email+contraseña.
   */
  correlationId?: string | null;
}

/**
 * API-13 (docs/auditoria-1/db-api-seguridad-reverificacion.md): los eventos
 * de autenticación (login, refresh, logout) ocurren SIN contexto de
 * organización (`org_id` no aplica) y el actor casi nunca es superadmin --
 * la política RLS de `audit_log` (0008, relajada en 0035) solo permite un
 * INSERT con `org_id IS NULL` cuando el actor ES superadmin, así que un
 * `recordAudit(tx, {orgId: null, ...})` normal fallaría para el login de
 * cualquier usuario común. `app.record_auth_event` (SECURITY DEFINER,
 * 0051_fix_api13_auth_audit_log.sql) inserta bypassing RLS -- igual que
 * `app.create_refresh_token`/`app.rotate_refresh_token` ya hacen sobre
 * `refresh_tokens` -- pero restringido en SQL a una lista fija de acciones
 * de autenticación conocidas (nunca una `action`/`entity`/`orgId`
 * arbitrarios). Requiere `set local role app_role` en la transacción
 * llamadora, igual que cualquier otra escritura de `apps/api`.
 */
export async function recordAuthAudit(tx: DbExecutor, entry: AuthAuditEntry): Promise<void> {
  await tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4, $5)', [
    entry.action,
    entry.actorId,
    entry.after !== undefined ? JSON.stringify(entry.after) : null,
    entry.requestId ?? null,
    entry.correlationId ?? null,
  ]);
}

export type SecurityAuditAction =
  | 'twofa.enroll'
  | 'twofa.verify_enrollment'
  | 'twofa.step_up_verified'
  // R5-03: fallos de verificación (código inválido, replay, backup code ya
  // usado, o cuenta bloqueada) -- ver `lib/twofa-lockout.ts` y 0059.
  | 'twofa.verification_failed'
  | 'twofa.step_up_denied'
  // E21 (docs/BACKLOG.md, migración 0091): desactivar 2FA de la cuenta
  // propia, o regenerar (invalidando las anteriores) sus códigos de
  // respaldo -- ver `modules/twofa/routes.ts`.
  | 'twofa.disabled'
  | 'twofa.backup_codes_regenerated';

export interface SecurityAuditEntry {
  action: SecurityAuditAction;
  actorId: string;
  entity: 'user_totp_secrets' | 'step_up_sessions' | 'user_backup_codes';
  entityId: string;
  after?: unknown;
  requestId?: string | null;
  correlationId?: string | null;
}

/**
 * REQ-044/064: eventos de 2FA (enrolar/verificar/step-up) ocurren sin
 * organización activa (credenciales de USUARIO) -- mismo patrón que
 * `recordAuthAudit` (API-13/0051), vía `app.record_security_event`
 * (SECURITY DEFINER, 0057), restringida a una lista fija de acciones.
 */
export async function recordSecurityAudit(tx: DbExecutor, entry: SecurityAuditEntry): Promise<void> {
  await tx.query('select app.record_security_event($1, $2, $3, $4, $5::jsonb, $6, $7)', [
    entry.action,
    entry.actorId,
    entry.entity,
    entry.entityId,
    entry.after !== undefined ? JSON.stringify(entry.after) : null,
    entry.requestId ?? null,
    entry.correlationId ?? null,
  ]);
}

export interface AccessDeniedAuditEntry {
  actorId: string;
  /** `null` cuando no hay contexto de organización resuelto para esta request (p.ej. una ruta de superadmin, o `app.requireOrg` denegando ANTES de fijar `request.orgId`). */
  orgId: string | null;
  /** Ruta HTTP denegada (`request.url`) -- ver `plugins/error-handler.ts`. */
  entity: string;
  requestId?: string | null;
  correlationId?: string | null;
  /** Metadatos de diagnóstico -- NUNCA credenciales/tokens (mismo criterio que `AuthAuditEntry.after`). */
  detail?: unknown;
}

/**
 * Patrón Likida/atiende.ai #6: complemento del mapa ruta/rol que YA existe
 * y YA se refuerza en la aplicación (`requireOrgRole`/`APPROVER_ROLES`/
 * `MEMBERSHIP_ADMIN_ROLES`, `app.requireSuperadmin`) -- registra CADA
 * intento de acceso denegado por rol en `audit_log`, no solo en el log
 * efímero de la request. Llamada centralizadamente desde
 * `plugins/error-handler.ts` para todo `AppError` con `statusCode === 403`,
 * en vez de instrumentar cada punto de la aplicación que lanza
 * `ForbiddenError`.
 *
 * A diferencia de `recordAudit` (recibe una transacción YA abierta por la
 * ruta de negocio), esta función abre su PROPIA transacción: el manejador
 * de errores corre FUERA de esa transacción -- de hecho la ruta pudo
 * fallar precisamente porque nunca llegó a abrir una (`app.requireOrg`
 * deniega antes de fijar contexto de org; `app.requireSuperadmin` deniega
 * cuando el actor NO es superadmin). Por eso usa
 * `app.record_access_denied_event` (SECURITY DEFINER, migración
 * 0099_patron6_access_denied_audit.sql): el actor denegado casi siempre
 * NO cumple la política RLS normal de `audit_log` (no es miembro de
 * `orgId`, o no es superadmin) -- que es justo la razón de la denegación,
 * así que un INSERT directo bajo RLS fallaría ahí también.
 *
 * NUNCA lanza: un fallo al auditar no debe tumbar la respuesta 403 real
 * que ya se le debe al cliente. `onAuditFailure` (si se pasa) recibe el
 * error para que el llamador lo registre en su logger de request.
 */
export async function recordAccessDenied(
  db: DbClient,
  entry: AccessDeniedAuditEntry,
  onAuditFailure?: (err: unknown) => void
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_user_id', $1, true)", [entry.actorId]);
      await tx.query('select app.record_access_denied_event($1, $2, $3, $4, $5, $6::jsonb)', [
        entry.actorId,
        entry.orgId,
        entry.entity,
        entry.requestId ?? null,
        entry.correlationId ?? null,
        entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
      ]);
    });
  } catch (err) {
    onAuditFailure?.(err);
  }
}
