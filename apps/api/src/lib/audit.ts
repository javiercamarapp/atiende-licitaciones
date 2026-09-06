import type { DbExecutor } from '@atiende/db';

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
  | 'auth.logout';

export interface AuthAuditEntry {
  actorId: string | null;
  action: AuthAuditAction;
  /** NUNCA debe incluir contraseñas ni tokens -- solo metadatos (ip, user-agent, email en login_failed). */
  after?: unknown;
  requestId?: string | null;
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
  await tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', [
    entry.action,
    entry.actorId,
    entry.after !== undefined ? JSON.stringify(entry.after) : null,
    entry.requestId ?? null,
  ]);
}

export type SecurityAuditAction = 'twofa.enroll' | 'twofa.verify_enrollment' | 'twofa.step_up_verified';

export interface SecurityAuditEntry {
  action: SecurityAuditAction;
  actorId: string;
  entity: 'user_totp_secrets' | 'step_up_sessions';
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
