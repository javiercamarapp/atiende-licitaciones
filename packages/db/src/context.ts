import type { DbClient, DbExecutor } from './driver.js';

export interface TenantContext {
  /** UUID de la organización activa, o `undefined` para operar sin org (p.ej. login). */
  orgId?: string | null;
  /** UUID del usuario autenticado, o `undefined` para acciones anónimas (registro). */
  userId?: string | null;
}

/**
 * Ejecuta `fn` dentro de una transacción con:
 *  1. `SET LOCAL ROLE app_role` (imprescindible: sin esto la conexión sigue
 *     siendo el propietario/superusuario de las migraciones y las políticas
 *     RLS NO se aplican).
 *  2. `app.current_org_id` / `app.current_user_id` fijados vía
 *     `set_config(..., true)` (alcance de transacción, se revierte solo).
 *
 * Toda petición HTTP de la API que toque datos de negocio debe pasar por
 * aquí para que RLS aísle correctamente por organización y rol.
 */
export async function withTenantContext<T>(
  db: DbClient,
  ctx: TenantContext,
  fn: (tx: DbExecutor) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [ctx.orgId ?? '']);
    await tx.query("select set_config('app.current_user_id', $1, true)", [ctx.userId ?? '']);
    return fn(tx);
  });
}

/** Igual que withTenantContext pero sin abrir transacción explícita propia
 * (para usarse dentro de una transacción ya abierta por el llamador). */
export async function applyTenantContext(tx: DbExecutor, ctx: TenantContext): Promise<void> {
  await tx.query('set local role app_role');
  await tx.query("select set_config('app.current_org_id', $1, true)", [ctx.orgId ?? '']);
  await tx.query("select set_config('app.current_user_id', $1, true)", [ctx.userId ?? '']);
}
