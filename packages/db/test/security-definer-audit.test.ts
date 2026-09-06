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
  'app.record_auth_event(text,uuid,jsonb,text)':
    'API-13 (0051) + API-14 (docs/auditoria-2/api-expediente-reverificacion.md, 0054_fix_api14_auth_audit_actor_match.sql): no acepta ningún identificador de ORGANIZACIÓN (nunca resuelve org_id de un parámetro externo -- siempre inserta org_id=null en audit_log, bypassing RLS SOLO para eso). Desde 0054, además, EXIGE que p_actor_id coincida con app.current_user_id() ya fijado por el llamador para cualquier acción salvo `auth.login_failed` (el único evento genuinamente pre-autenticación, sin sesión establecida) -- cierra el hallazgo API-14 (un llamador con app_role ya no puede forjar un evento atribuido a un actor_id arbitrario). `p_action` sigue restringido en SQL a una lista fija de 5 acciones de autenticación.',
  'app.record_security_event(text,uuid,text,text,jsonb,text,text)':
    'REQ-044/064 (0057), mismo patrón que app.record_auth_event (0051/0054): los eventos de 2FA (enrolar/verificar/step-up) ocurren sin organización activa (credenciales de USUARIO), así que necesitan bypassing RLS SOLO para insertar con org_id=null. `p_action` restringido en SQL a una lista fija de 3 acciones de 2FA; `p_entity` restringido a `user_totp_secrets`/`step_up_sessions`; y -- a diferencia de record_auth_event, que exime `auth.login_failed` por ser pre-sesión -- aquí NO hay ninguna excepción: se exige SIEMPRE que p_actor_id coincida con app.current_user_id() ya fijado por el llamador (toda acción de 2FA ocurre con sesión ya autenticada).',
  'app.org_members(uuid)':
    'Ronda 4 (docs/logs/api-ronda4.log, item 2): NO confía en p_org_id por sí solo -- verifica DENTRO de la función que app.current_user_id() es miembro activo de esa organización (cualquier rol) o superadmin, y lanza excepción (org_members_forbidden) si no, antes de devolver ninguna fila (mismo criterio DB-01/DB-12: nunca resolver datos de una organización sin relación verificada con el llamador).',
  // --- REQ-172..180 (0071_req172_google_oidc.sql / 0072_req177_google_auth_audit.sql): login con Google ---
  'app.create_oauth_state(uuid,text,text,text,text,timestamp with time zone)':
    'RLS habilitada SIN políticas sobre oauth_states (mismo patrón que refresh_tokens, 0017): no acepta ningún identificador de usuario/organización -- solo persiste PKCE/nonce/redirect_uri de un intento de login ANÓNIMO (todavía no existe ninguna identidad), bajo un `id` aleatorio (uuid v4) generado por el propio llamador, nunca adivinable ni de entrada del cliente.',
  'app.consume_oauth_state(uuid)':
    'Consumo ATÓMICO de un solo uso (UPDATE ... WHERE consumed_at IS NULL AND expires_at > now() RETURNING, mismo patrón check-y-mutación que app.rotate_refresh_token, 0043); p_id nunca viaja en claro al cliente (va firmado dentro del `state` JWT, ver modules/auth/google/state.ts) -- posesión de un id válido, no vencido y no consumido es equivalente a autenticarse con el propio token de refresh (mismo criterio que find_refresh_token/revoke_refresh_token).',
  'app.find_identity_by_subject(text,text)':
    'DB-01-style (mismo patrón que find_user_by_email, 0019): rechaza ejecutarse (raise exception) si app.current_user_id() ya está fijado -- solo utilizable en el contexto pre-sesión del login con Google para el que fue diseñada.',
  'app.accept_pending_invitations_for_user(uuid)':
    'Mismo endurecimiento anti-forjado que 0054 aplicó a record_auth_event tras API-14: exige que app.current_user_id() ya esté fijado e IGUAL a p_user_id (si no, lanza excepción) -- el llamador (modules/auth/google/routes.ts) lo fija al id ya verificado (encontrado por email/subject, o recién creado en la misma transacción) ANTES de invocarla. Nunca acepta un email como parámetro externo: siempre lo deriva de users.email del propio p_user_id ya verificado, jamás de una entrada de cliente sin verificar.',
  // --- REQ-181..195 (correos transaccionales, 0080-0084): outbox/supresión/
  // webhook/preferencias/verificación de correo/restablecimiento de
  // contraseña. Todas operan sobre tablas de SISTEMA (RLS habilitada SIN
  // políticas, mismo patrón que refresh_tokens/oauth_states, 0017/0071) --
  // ninguna acepta un identificador de organización; las que aceptan un
  // p_user_id/p_dedupe_key/p_email lo hacen por POSESIÓN de un secreto
  // opaco (token_hash/dedupe_key generado por el propio backend) o porque
  // el `userId` ya viene verificado por la firma HMAC de un enlace firmado
  // (`MailService.verifySignedLink`, packages/mail) -- nunca de un valor de
  // entrada de cliente sin verificar.
  'app.mail_outbox_reserve(text,text,integer,uuid,uuid,text)':
    'Reserva atómica (INSERT ... ON CONFLICT, ML-01 de packages/mail) del outbox de correo; p_org_id/p_user_id son solo metadatos informativos para diagnóstico (no deciden nada de RLS -- la tabla completa es de sistema), y p_dedupe_key es una llave de idempotencia de NEGOCIO generada por apps/api (p.ej. "verificacion:<userId>"), nunca un secreto ajeno.',
  'app.mail_outbox_get(text)':
    'Lectura por p_dedupe_key (llave de idempotencia propia del llamador, ver arriba); solo devuelve estados finales (status <> pending).',
  'app.mail_outbox_save(text,text,text,integer,integer,text)':
    'Escritura del resultado final por p_dedupe_key; p_status restringido en SQL a la lista cerrada de SendStatus (sent/failed_permanent/dead).',
  'app.mail_outbox_release(text)':
    'Libera una reserva pendiente por p_dedupe_key (retrocede updated_at) para permitir un reintento posterior no concurrente -- no expone ni muta ningún dato de otro dedupe_key.',
  'app.mail_outbox_peek(text)':
    'Lectura de diagnóstico SIN filtrar por estado (incluye pending); exige explícitamente app.is_superadmin() dentro de la función -- lanza excepción si quien invoca no lo es.',
  'app.mail_suppression_check(text)':
    'Consulta booleana de supresión por email (normalizado a minúsculas); no expone ningún otro dato de la fila.',
  'app.mail_suppression_add(text,text,text)':
    'Upsert de supresión por email; p_reason/p_source son metadatos de auditoría de texto libre, sin identificador de usuario/organización.',
  'app.mail_suppression_remove(text)':
    'Elimina la supresión de un email -- acción administrativa deliberada, sin identificador de usuario/organización.',
  'app.mail_suppression_get(text)':
    'Lectura completa de la entrada de supresión de un email -- mismo criterio que mail_suppression_check.',
  'app.mail_webhook_claim(text,integer)':
    'Anti-replay (ML-05, packages/mail) por p_svix_id -- un identificador opaco emitido por el proveedor del webhook (Resend/Svix), nunca un identificador de usuario/organización; compare-and-set atómico (INSERT ... ON CONFLICT DO NOTHING).',
  'app.set_notification_preference_unsigned(uuid,text,boolean)':
    'p_user_id llega YA verificado por la firma HMAC de un enlace de baja de un clic (MailService.verifySignedLink, imposible de forjar sin el secreto MAIL_LINK_SECRET) -- nunca de un valor de entrada de cliente sin verificar; p_category restringido en SQL a la lista cerrada de columnas de notification_preferences.',
  'app.create_email_verification_token(uuid,uuid,text,timestamp with time zone)':
    'Mismo patrón que app.create_oauth_state (0071): contexto ANÓNIMO (registro recién hecho, sin sesión todavía) -- p_id/p_token_hash son generados por el propio backend (uuid v4 / sha256 de un secreto aleatorio), nunca de entrada de cliente.',
  'app.consume_email_verification_token(text)':
    'Consumo ATÓMICO de un solo uso (mismo patrón check-y-mutación que app.consume_oauth_state, 0071) por posesión de p_token_hash (sha256 de un secreto de 256 bits enviado fuera de banda por correo) -- equivalente a autenticarse con el propio token; el UPDATE de users.email_verified_at que hace dentro es SIEMPRE sobre el user_id que la propia fila de token ya tenía asociado, nunca un parámetro externo.',
  'app.create_password_reset_token(uuid,uuid,text,timestamp with time zone)':
    'Idéntico a app.create_email_verification_token, para password_reset_tokens.',
  'app.reset_password_with_token(text,text)':
    'Consumo ATÓMICO de un solo uso por posesión de p_token_hash (mismo criterio que consume_email_verification_token); el UPDATE de users.password_hash y la revocación de refresh tokens (revoke_all_refresh_tokens) operan SIEMPRE sobre el user_id resuelto de la propia fila de token consumida, nunca de un parámetro externo.',
  'app.enqueue_mail_retry(uuid,uuid,jsonb,integer,integer,text)':
    'REQ-188 (0086): encola el reintento diferido de un correo cuyo envío agotó los reintentos de MailService. Es SECURITY DEFINER porque un correo de verificación o de restablecimiento de contraseña no tiene organización NI sesión (org_id NULL, app.current_org_id() NULL) y la política ins_jobs (0028) rechazaría ese INSERT -- relajar esa política habría abierto la cola de trabajo entera a cualquier usuario autenticado. Está ACOTADA en SQL a kind = "mail_retry" (nunca un kind/status arbitrario) y exige un payload con messageKey; p_org_id solo etiqueta el job para el worker y no concede acceso a nada (jobs.org_id no es una credencial: quien lea la cola sigue pasando por ins_jobs/sel_jobs).',
  'app.record_mail_retry_event(text,uuid,text,jsonb,text)':
    'REQ-188 (0087): el handler `mail_retry` de apps/worker (mismo motivo que app.enqueue_mail_retry, 0086) necesita dejar rastro en audit_log para un job sin organización (correo de verificación/restablecimiento de contraseña), y la política de audit_log exige app.is_superadmin() cuando org_id es null -- worker_role/app_role nunca lo es. Mismo patrón que app.record_auth_event/app.record_security_event: SIEMPRE inserta actor_id=null (nunca acepta un actor externo) y p_action está ACOTADA en SQL a la lista fija de eventos de este único flujo (entity siempre "mail_retry", fijo en el cuerpo de la función, nunca un parámetro); p_org_id/p_entity_id son solo metadatos informativos (igual que p_org_id de mail_outbox_reserve), no deciden ningún acceso.',
  'app.mail_outbox_reopen_for_retry(text)':
    'REQ-188 (0087): reabre deliberadamente una reserva `dead` de `mail_outbox` (transición SOLO dead -> pending, retrocediendo updated_at) para que el job `mail_retry` de apps/worker pueda reclamarla de nuevo vía app.mail_outbox_reserve() -- sin esto, una fila `dead` queda atascada para siempre (ninguna función de 0080 puede des-marcarla). Opera por p_dedupe_key (la misma llave de idempotencia de negocio que mail_outbox_reserve/mail_outbox_get, generada por apps/api, nunca un secreto ajeno); nunca toca `sent` (el correo ya se mandó) ni `failed_permanent` (WK-10: un rechazo ya clasificado como no-reintentable) porque el WHERE exige status = "dead" exacto.',
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
