import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedUser, asActor } from './helpers.js';

/**
 * DB-08 (docs/auditoria-1/db-api-reverificacion.md, CRÍTICA) +
 * "auditar TODAS las funciones SECURITY DEFINER existentes con el mismo
 * criterio" (misma tarea).
 *
 * Parte 1: enumera TODAS las funciones `SECURITY DEFINER` de verdad
 * presentes en `pg_proc` (schema `app`) tras aplicar todas las migraciones,
 * y exige que cada una esté en una lista blanca explícita con su
 * justificación -- si una migración futura agrega una función
 * `SECURITY DEFINER` nueva sin pasar por esta lista, este test falla y
 * obliga a revisarla conscientemente (evita que el patrón de DB-01/DB-08/
 * DB-12 reaparezca sin ser detectado, como pasó con
 * `app.create_refresh_token`/`app.revoke_all_refresh_tokens` en 0017 y
 * `app.my_organizations` en 0010: ninguna fue tocada cuando 0019 cerró
 * DB-01 porque nadie las buscó explícitamente).
 *
 * Parte 2: ataques reales contra `refresh_tokens` (DB-08) confirmando que
 * el fix de 0040 bloquea acuñar/revocar sesiones ajenas.
 */

interface SecdefRow {
  signature: string;
  args: string;
}

/**
 * Lista blanca de funciones `SECURITY DEFINER` del schema `app`, con la
 * justificación de por qué NO representan el patrón DB-01/DB-08/DB-12
 * (parámetro de identidad externo aceptado sin validar contra el
 * llamador). Mantener esta lista actualizada es intencional: un nuevo
 * hallazgo de este tipo se detecta cuando una función no aparece aquí, no
 * cuando alguien recuerda auditarla manualmente.
 */
const SECURITY_DEFINER_WHITELIST: Record<string, string> = {
  'app.has_role(uuid,org_role[])':
    'Resuelve el rol del propio app.current_user_id() en p_org_id; p_org_id no expone datos de otro usuario (solo responde "yo, ¿tengo alguno de estos roles ahí?").',
  'app.is_superadmin()':
    'Sin parámetros de identidad externos; resuelve exclusivamente sobre app.current_user_id().',
  'app.org_has_no_memberships(uuid)':
    'Devuelve un booleano ("esa organización no tiene ningún miembro aún"), sin filtrar identidades; usada solo dentro de la política RLS de bootstrap (0008).',
  'app.find_user_by_email(text)':
    'DB-01 (0019): rechaza ejecutarse (raise exception) si app.current_user_id() ya está fijado -- solo utilizable en el contexto pre-sesión de login para el que fue diseñada.',
  'app.membership_role(uuid)':
    'DB-01 (0019): resuelve siempre sobre el propio app.current_user_id(), sin parámetro de usuario.',
  'app.my_organizations()':
    'DB-12 (0041): resuelve siempre sobre el propio app.current_user_id(), sin parámetro de usuario (antes tenía p_user_id arbitrario).',
  'app.create_refresh_token(uuid,uuid,text,timestamp with time zone)':
    'DB-08 (0040): exige app.current_user_id() = p_user_id, si no coinciden lanza excepción; el llamador (apps/api) fija current_user_id al id ya verificado antes de invocar.',
  'app.find_refresh_token(text)':
    'Opera por posesión de un token_hash (derivado de un secreto de 256 bits firmado por el servidor), no por un user_id adivinable -- equivalente a autenticarse con el propio token.',
  'app.revoke_refresh_token(text)':
    'Idem: opera por posesión del hash del token, nunca por user_id arbitrario.',
  'app.revoke_all_refresh_tokens(uuid)':
    'DB-08 (0040): exige app.current_user_id() = p_user_id o app.is_superadmin().',
  'app.rotate_refresh_token(text,uuid,text,timestamp with time zone)':
    'API-01/API-09 (0043): opera por posesión de un token_hash (igual que find_refresh_token/revoke_refresh_token); el user_id de destino se resuelve internamente de la fila encontrada, nunca de un parámetro externo.',
  'app.accept_invitation(text,uuid)':
    'p_user_id es siempre el actor YA autenticado (apps/api lo fija igual a app.current_user_id() antes de invocarla); el verdadero secreto de un solo uso es p_token_hash (UUID aleatorio de 122 bits enviado fuera de banda), no p_user_id.',
  'app.source_freshness()':
    'Sin parámetros de identidad; expone deliberadamente datos NO multi-tenant (frescura agregada de fuentes públicas, ver 0018).',
  'app.verify_audit_log_chain()':
    'Sin parámetros de identidad; solo valida la integridad del hash chain completo de audit_log.',
  'app.agent_run_context(uuid)':
    'DB-09 (0044, mitigación PARCIAL documentada): rechaza ejecutarse si ya hay contexto de sesión fijado (mismo patrón "pre-sesión" que find_user_by_email); el hueco residual (una llamada SIN contexto previo sigue resolviendo org_id/actor_id de cualquier run_id adivinado) requiere que apps/api/src/lib/agent-stores.pg.ts pase la identidad del actor autenticado como parámetro -- ese archivo está fuera del ámbito de este agente (no es apps/api/src/modules/auth/** ni organizations/**), documentado como gap real, no oculto.',
};

async function fetchSecurityDefinerFunctions(db: DbClient): Promise<SecdefRow[]> {
  // La firma usada como clave de la lista blanca es SOLO tipos (sin nombres
  // de parámetro, ver `format_type` sobre `proargtypes`): los nombres de
  // parámetro son un detalle incidental que no debería poder tumbar este
  // test con un cambio cosmético, solo la FORMA/tipo de los argumentos
  // importa para decidir si una función acepta un identificador externo.
  const { rows } = await db.query<SecdefRow>(`
    select
      n.nspname || '.' || p.proname || '(' || coalesce((
        select string_agg(format_type(t, null), ',' order by ord)
        from unnest(p.proargtypes) with ordinality as u(t, ord)
      ), '') || ')' as signature,
      pg_get_function_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prosecdef = true
      and n.nspname = 'app'
  `);
  return rows;
}

describe('security-definer-audit: inventario completo de funciones SECURITY DEFINER (app.*)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('toda función SECURITY DEFINER de app.* está en la lista blanca justificada (o el test falla y exige revisión)', async () => {
    const rows = await fetchSecurityDefinerFunctions(db);
    expect(rows.length).toBeGreaterThan(0);

    const unlisted = rows.map((r) => r.signature).filter((sig) => !(sig in SECURITY_DEFINER_WHITELIST));
    expect(unlisted).toEqual([]);
  });

  it('la lista blanca no contiene entradas obsoletas (funciones que ya no existen)', async () => {
    const rows = await fetchSecurityDefinerFunctions(db);
    const live = new Set(rows.map((r) => r.signature));
    const stale = Object.keys(SECURITY_DEFINER_WHITELIST).filter((sig) => !live.has(sig));
    expect(stale).toEqual([]);
  });

  it('DB-08: un usuario NO puede acuñar un refresh token para otro user_id', async () => {
    const attackerId = await seedUser(db, 'db08-attacker@example.com');
    const victimId = await seedUser(db, 'db08-victim@example.com');
    const tokenHash = createHash('sha256').update('stolen-hash-choice').digest('hex');

    // El atacante tiene sesión propia (current_user_id = attackerId) pero
    // intenta acuñar un token para victimId -- debe rechazarse.
    await expect(
      asActor(db, { userId: attackerId }, (tx) =>
        tx.query('select app.create_refresh_token($1, $2, $3, now() + interval \'30 days\')', [
          randomUUID(),
          victimId,
          tokenHash,
        ])
      )
    ).rejects.toThrow(/create_refresh_token_requires_matching_user_context/);

    const found = await db.query<{ id: string }>('select id from app.find_refresh_token($1)', [tokenHash]);
    expect(found.rows.length).toBe(0);
  });

  it('DB-08: un usuario NO puede revocar todas las sesiones de otro usuario conociendo solo su user_id', async () => {
    const victimId = await seedUser(db, 'db08-victim2@example.com');
    const attackerId = await seedUser(db, 'db08-attacker2@example.com');
    const tokenHash = createHash('sha256').update('victim-active-session').digest('hex');

    await asActor(db, { userId: victimId }, (tx) =>
      tx.query('select app.create_refresh_token($1, $2, $3, now() + interval \'30 days\')', [
        randomUUID(),
        victimId,
        tokenHash,
      ])
    );

    await expect(
      asActor(db, { userId: attackerId }, (tx) => tx.query('select app.revoke_all_refresh_tokens($1)', [victimId]))
    ).rejects.toThrow(/revoke_all_refresh_tokens_requires_matching_user_or_superadmin/);

    const stillActive = await db.query<{ revoked_at: string | null }>(
      'select revoked_at from app.find_refresh_token($1)',
      [tokenHash]
    );
    expect(stillActive.rows[0]?.revoked_at).toBeNull();
  });

  it('DB-08: un usuario SÍ puede seguir acuñando y revocando sus PROPIOS refresh tokens (no bloquea el caso legítimo)', async () => {
    const userId = await seedUser(db, 'db08-legit@example.com');
    const tokenHash = createHash('sha256').update('own-session').digest('hex');

    await asActor(db, { userId }, (tx) =>
      tx.query('select app.create_refresh_token($1, $2, $3, now() + interval \'30 days\')', [
        randomUUID(),
        userId,
        tokenHash,
      ])
    );
    const found = await db.query<{ id: string }>('select id from app.find_refresh_token($1)', [tokenHash]);
    expect(found.rows.length).toBe(1);

    await asActor(db, { userId }, (tx) => tx.query('select app.revoke_all_refresh_tokens($1)', [userId]));
    const afterRevoke = await db.query<{ revoked_at: string | null }>(
      'select revoked_at from app.find_refresh_token($1)',
      [tokenHash]
    );
    expect(afterRevoke.rows[0]?.revoked_at).not.toBeNull();
  });
});
