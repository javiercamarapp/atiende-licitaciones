/**
 * R5-02 (docs/auditoria-2/api-ronda5.md, CRÍTICA): contador de fallos de
 * verificación TOTP/backup-code POR USUARIO, persistido en DB
 * (`twofa_lockouts`, migración 0058) -- complementa el límite de tasa por
 * IP (`config.rateLimit`, tier `twoFactor`, ver `lib/rate-limit-settings.ts`)
 * aplicado directamente en `modules/twofa/routes.ts`. A diferencia de un
 * límite en memoria por IP, este contador:
 *  - sobrevive un reinicio del proceso (está en Postgres, no en memoria);
 *  - es POR USUARIO: rotar de IP no reinicia el presupuesto de intentos
 *    contra la misma cuenta;
 *  - aplica bloqueo PROGRESIVO: cada vez que los fallos consecutivos
 *    alcanzan un múltiplo de `FAILURES_PER_LOCKOUT` (5), la ventana de
 *    bloqueo se DUPLICA respecto al bloqueo anterior (5, 10, 20, 40...
 *    minutos), con un tope de `MAX_LOCKOUT_MINUTES` (24h).
 *
 * Debe invocarse dentro de una transacción con `SET LOCAL ROLE app_role` +
 * `app.current_user_id` ya fijados (mismo patrón que el resto de
 * apps/api) -- la RLS de `twofa_lockouts` (0058) ya limita cada fila al
 * propio usuario.
 */
import type { DbExecutor } from '@atiende/db';

export const FAILURES_PER_LOCKOUT = 5;
const BASE_LOCKOUT_MINUTES = 5;
const MAX_LOCKOUT_MINUTES = 24 * 60;

export interface TwofaLockoutStatus {
  /** `true` si el usuario está bloqueado AHORA MISMO (locked_until > now()). */
  locked: boolean;
  /** Segundos restantes de bloqueo (0 si no está bloqueado). */
  retryAfterSeconds: number;
}

/** Consulta si el usuario está actualmente bloqueado, SIN modificar el contador. */
export async function checkTwofaLockout(tx: DbExecutor, userId: string): Promise<TwofaLockoutStatus> {
  const { rows } = await tx.query<{ locked_until: string | Date | null }>(
    'select locked_until from twofa_lockouts where user_id = $1',
    [userId]
  );
  const lockedUntil = rows[0]?.locked_until ?? null;
  if (lockedUntil === null) return { locked: false, retryAfterSeconds: 0 };
  const remainingMs = new Date(lockedUntil).getTime() - Date.now();
  if (remainingMs <= 0) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

/**
 * Registra un fallo de verificación (código TOTP inválido, replay, backup
 * code inválido/ya usado). Incrementa `failed_count`; cuando alcanza un
 * múltiplo de `FAILURES_PER_LOCKOUT`, fija `locked_until` con una ventana
 * que DUPLICA la del bloqueo anterior (bloqueo progresivo real, no un
 * número fijo repetido).
 */
export async function recordTwofaFailure(tx: DbExecutor, userId: string): Promise<TwofaLockoutStatus> {
  const { rows } = await tx.query<{ failed_count: number; lock_count: number; locked_until: string | Date | null }>(
    `insert into twofa_lockouts (user_id, failed_count, lock_count, locked_until)
       values ($1, 1, 0, null)
     on conflict (user_id) do update set
       failed_count = twofa_lockouts.failed_count + 1
     returning failed_count, lock_count, locked_until`,
    [userId]
  );
  const row = rows[0];
  if (row.failed_count % FAILURES_PER_LOCKOUT !== 0) {
    return checkTwofaLockout(tx, userId);
  }

  const newLockCount = row.lock_count + 1;
  const lockoutMinutes = Math.min(BASE_LOCKOUT_MINUTES * 2 ** (newLockCount - 1), MAX_LOCKOUT_MINUTES);
  const lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000).toISOString();
  await tx.query('update twofa_lockouts set lock_count = $1, locked_until = $2 where user_id = $3', [newLockCount, lockedUntil, userId]);
  return { locked: true, retryAfterSeconds: lockoutMinutes * 60 };
}

/** Reinicia el contador tras una verificación EXITOSA -- un usuario legítimo que acierta no debe arrastrar fallos previos indefinidamente. */
export async function resetTwofaFailures(tx: DbExecutor, userId: string): Promise<void> {
  await tx.query(
    `insert into twofa_lockouts (user_id, failed_count, lock_count, locked_until)
       values ($1, 0, 0, null)
     on conflict (user_id) do update set failed_count = 0, lock_count = 0, locked_until = null`,
    [userId]
  );
}
