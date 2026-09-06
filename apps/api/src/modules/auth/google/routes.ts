/**
 * REQ-172..180 (docs/REQUISITOS.md §34.1): login/registro con Google
 * (OIDC estándar -- Authorization Code + PKCE + state + nonce).
 *
 *   GET  /auth/google/start        -- inicia el flujo, devuelve la URL de
 *                                      autorización con state/PKCE/nonce
 *                                      persistidos en `oauth_states` (TTL).
 *   GET  /auth/google/callback     -- intercambia el code, verifica el
 *                                      id_token contra el JWKS real del
 *                                      proveedor, resuelve identidad
 *                                      (vincular/crear/rechazar) y emite
 *                                      sesión -- salvo que la cuenta tenga
 *                                      2FA activo (REQ-176), en cuyo caso
 *                                      responde `requires_2fa`.
 *   POST /auth/google/verify-2fa   -- completa un login `requires_2fa` con
 *                                      un código TOTP/backup válido.
 *
 * Ver `apps/api/README.md` para las variables de entorno
 * (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`/
 * `OIDC_ISSUER_URL`) y el estado BLOQUEADO_EXTERNO (REQ-178) sin
 * credenciales reales. `apps/api/test/helpers/fake-oidc.ts` implementa el
 * proveedor OIDC falso usado por las pruebas de este módulo.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DbExecutor } from '@atiende/db';
import { AppError, BadRequestError, ConflictError, ForbiddenError, TooManyRequestsError, UnauthorizedError } from '../../../lib/errors.js';
import { recordAuthAudit } from '../../../lib/audit.js';
import { decryptSecret, verifyTotpCode, hashBackupCode, assertSixDigitCode } from '../../../lib/step-up.js';
import { checkTwofaLockout, recordTwofaFailure, resetTwofaFailures } from '../../../lib/twofa-lockout.js';
import { auditContext, issueTokenPair } from '../routes.js';
import { loadGoogleOidcEnv, assertConfiguredIssuerUrlIsSecure, GoogleOidcConfigError } from './env.js';
import { fetchDiscoveryDocument } from './discovery.js';
import { generateCodeVerifier, computeCodeChallengeS256, generateNonce } from './pkce.js';
import { signOauthState, verifyOauthState } from './state.js';
import { verifyGoogleIdToken } from './id-token.js';
import { exchangeAuthorizationCode } from './token-exchange.js';
import { signPending2faToken, verifyPending2faToken } from './pending-2fa.js';
import { googleStartResponseSchema, googleCallbackQuerySchema, googleVerify2faBodySchema, googleAuthResultSchema } from './schemas.js';

const OAUTH_STATE_TTL_MINUTES = 10;

/**
 * GO-07 (docs/auditoria-2/api-google.md): SQLSTATE de Postgres para
 * `unique_violation` -- el MISMO código que `POST /auth/register` ya captura
 * explícitamente en `modules/auth/routes.ts` para no convertir una carrera
 * entre dos registros simultáneos en un 500. Se replica aquí, en espejo, para
 * el flujo de Google.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * GO-07: número TOTAL de intentos de `resolveGoogleIdentityOnce`. Dos basta
 * por construcción: la única forma de recibir `23505` es que OTRA transacción
 * ganara la carrera y YA HAYA COMMITEADO la fila (usuario o identidad) --
 * el segundo intento abre una transacción nueva, con un snapshot posterior a
 * ese commit, así que ya la ve y toma la rama de vinculación/login normal.
 * Un tercer intento no aportaría información nueva (y un bucle sin techo
 * sería un vector de amplificación bajo carga).
 */
const IDENTITY_RESOLUTION_ATTEMPTS = 2;

/** GO-07: ¿este error es una violación de restricción única de Postgres? (mismo criterio que `/auth/register`). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/** Un código de respaldo tiene forma "XXXX-XXXX"; cualquier otra cosa se intenta como TOTP de 6 dígitos (mismo criterio que `modules/twofa/routes.ts`). */
function looksLikeBackupCode(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code.trim());
}

function serviceUnavailable(message: string): AppError {
  return new AppError(503, 'https://atiende.example/errors/google-oidc-not-configured', message);
}

interface RejectAuditParams {
  actorId: string | null;
  reason: string;
  ip: string;
  userAgent: string | null;
  requestId: string;
}

/**
 * REQ-177/REQ-179/REQ-180: audita un rechazo explícito EN SU PROPIA
 * transacción (mismo patrón que `auth.login_failed`/`twofa.*_failed` en el
 * resto de `apps/api`) -- así el `throw` que produce el 401/403 al cliente
 * nunca hace ROLLBACK de este registro. Best-effort: un fallo al auditar
 * nunca debe ocultar el rechazo real ni convertirlo en un 500.
 */
async function auditGoogleRejected(app: FastifyInstance, params: RejectAuditParams): Promise<void> {
  try {
    await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await recordAuthAudit(tx, {
        actorId: params.actorId,
        action: 'auth.google_rejected',
        after: { reason: params.reason, ip: params.ip, userAgent: params.userAgent },
        requestId: params.requestId,
      });
    });
  } catch {
    // ver docstring de auditGoogleRejected.
  }
}

/** Sentinel interno: distingue "rechazo de negocio ya auditado" de cualquier otro error inesperado en `handleCallback`. */
class GoogleRejectionError extends Error {
  constructor(
    public httpStatus: 401 | 403 | 409,
    public reason: string,
    public userMessage: string,
    public actorId: string | null = null
  ) {
    super(reason);
  }
}

interface ResolvedIdentity {
  userId: string;
  isNewUser: boolean;
  linkedNow: boolean;
  acceptedInvitations: number;
  requiresTwoFactor: boolean;
  hasAnyOrganization: boolean;
}

/**
 * Resuelve la identidad de Google (REQ-173/REQ-174/REQ-180) dentro de UNA
 * transacción: vincula con una cuenta existente por email verificado,
 * acepta invitación(es) pendiente(s) para una cuenta nueva (REQ-174), o
 * deja la compuerta `sin_acceso` (ninguna organización automática) --
 * nunca vía valores de entrada sin verificar: el `user_id` objetivo se fija
 * en `app.current_user_id` en cuanto se determina (por
 * `app.find_identity_by_subject`/`app.find_user_by_email`, ambas
 * pre-sesión y SECURITY DEFINER, o por el `id` recién insertado), y TODO lo
 * que sigue en la misma transacción corre ya bajo ese contexto real.
 *
 * UN SOLO INTENTO: puede lanzar `23505` si otra transacción concurrente ganó
 * la carrera entre el `find_*` y el `insert` (ver GO-07). El reintento --y la
 * traducción a una respuesta limpia si ni así se resuelve-- viven en
 * `resolveGoogleIdentity`, no aquí.
 */
async function resolveGoogleIdentityOnce(
  app: FastifyInstance,
  claims: { sub: string; email: string },
  audit: { ip: string; userAgent: string | null; requestId: string }
): Promise<ResolvedIdentity> {
  return app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');

    let userId: string | null = null;
    let isNewUser = false;
    let linkedNow = false;
    let acceptedInvitations = 0;

    // 1) ¿Ya existe una identidad de Google vinculada (login repetido)?
    const bySubject = await tx.query<{ user_id: string; email: string; is_active: boolean }>(
      'select * from app.find_identity_by_subject($1, $2)',
      ['google', claims.sub]
    );

    if (bySubject.rows.length > 0) {
      const row = bySubject.rows[0];
      if (!row.is_active) {
        throw new GoogleRejectionError(403, 'account_inactive', 'Esta cuenta está desactivada.', row.user_id);
      }
      userId = row.user_id;
      // GO-10 (docs/auditoria-2/api-google.md): a diferencia de las otras dos
      // ramas (vinculación por email y usuario nuevo), esta rama de LOGIN
      // REPETIDO nunca fijaba `app.current_user_id` -- `app.find_identity_by_subject`
      // es SECURITY DEFINER/pre-sesión y ya devolvió el `user_id` verificado,
      // así que es seguro fijar el contexto AQUÍ, antes de las consultas que
      // dependen de él más abajo (`app.my_organizations()`, RLS de
      // `user_totp_secrets`): sin esto, ambas ven 0 filas y el usuario recibe
      // `sin_acceso` con su 2FA sin exigir (bypass, REQ-176).
      await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    } else {
      // 2) REQ-173: vinculación automática por email verificado con una
      // cuenta existente (email+contraseña, u otra ya creada antes).
      const byEmail = await tx.query<{ id: string; password_hash: string | null; is_active: boolean; email_verified_at: string | Date | null }>(
        'select * from app.find_user_by_email($1)',
        [claims.email]
      );

      if (byEmail.rows.length > 0) {
        const row = byEmail.rows[0];
        if (!row.is_active) {
          throw new GoogleRejectionError(403, 'account_inactive', 'Esta cuenta está desactivada.', row.id);
        }
        userId = row.id;
        // Fija el contexto AHORA, con el id ya verificado por
        // `app.find_user_by_email` -- todo lo que sigue en esta rama corre
        // ya como este usuario real.
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        // AM-01 (docs/auditoria-2/api-mail.md, ALTA -- roza CRÍTICA):
        // "squatting" de correo -- un atacante que conoce el email de la
        // víctima ejecuta POST /auth/register con ese email y una
        // contraseña suya ANTES de que la víctima use Google. Esta rama
        // vinculaba la identidad de Google a esa cuenta sin mirar
        // `email_verified_at`/`password_hash`: si la verificación NATIVA se
        // completaba después por cualquier vía (el correo original de
        // registro sigue vivo 30 minutos, o /auth/email/resend-verification
        // es anónimo), la contraseña del ATACANTE -- nunca invalidada --
        // quedaba operativa para tomar la cuenta, incluidas las
        // organizaciones a las que la víctima ya se hubiera unido vía
        // Google. REQ-180 exige tratar esto como el "estado inconsistente"
        // que debe detectarse y corregirse: Google ya probó la propiedad
        // del correo con MÁS fuerza que un token de verificación nativo
        // (OIDC completo, no un enlace que cualquiera con acceso al buzón
        // puede consumir), así que se usa esa prueba para (a) invalidar
        // cualquier contraseña preexistente que nunca se verificó (si el
        // dueño real la puso, `/auth/password/forgot` se la deja rehacer;
        // si la puso un atacante, queda inservible en el mismo acto) y
        // revocar toda sesión de esa cuenta, y (b) marcar el correo como
        // verificado por Google -- en el MISMO acto que la vinculación,
        // nunca en un paso posterior que un atacante pudiera ganar de
        // carrera.
        //
        // Alternativa MÁS conservadora considerada y descartada: rechazar
        // la vinculación con 409 y exigir verificación nativa primero. Se
        // descarta porque invertiría REQ-173 (vinculación automática) en el
        // caso más común y benigno -- alguien que se registró con
        // contraseña, nunca confirmó el correo, y simplemente prefiere
        // entrar con Google -- y porque Google YA es una prueba de
        // propiedad del correo al menos tan fuerte como la nativa; negar la
        // vinculación no cierra ningún vector adicional, solo empeora la
        // experiencia del caso legítimo.
        const accountWasSquatted = row.password_hash !== null && row.email_verified_at === null;
        if (accountWasSquatted) {
          await tx.query('update users set password_hash = null, email_verified_at = now() where id = $1', [userId]);
          // Mismo patrón que `app.reset_password_with_token` (0084) aplica
          // al restablecer una contraseña: invalidar credenciales sin
          // revocar sesiones vivas dejaría cualquier sesión YA ABIERTA con
          // la contraseña del atacante intacta.
          await tx.query('select app.revoke_all_refresh_tokens($1)', [userId]);
        }

        // REQ-180: antes de vincular, verificar que no exista un conflicto
        // -- esta cuenta ya tiene una identidad de Google vinculada a un
        // `subject` DISTINTO (posible confusión/toma de cuenta: no
        // sobrescribir un vínculo existente en silencio).
        const existingGoogleIdentity = await tx.query<{ subject: string }>(
          'select subject from user_identities where user_id = $1 and provider = $2',
          [userId, 'google']
        );
        if (existingGoogleIdentity.rows.length > 0 && existingGoogleIdentity.rows[0].subject !== claims.sub) {
          throw new GoogleRejectionError(
            403,
            'identity_conflict',
            'Esta cuenta ya tiene una identidad de Google distinta vinculada; contacte a soporte.',
            userId
          );
        }

        await tx.query('insert into user_identities (user_id, provider, subject, email) values ($1, $2, $3, $4)', [
          userId,
          'google',
          claims.sub,
          claims.email,
        ]);
        linkedNow = true;

        // AM-01, punto (d) del hallazgo (correo transaccional "se vinculó
        // Google a tu cuenta"): NO implementado en esta ronda. El catálogo
        // de plantillas (`packages/mail/src/templates/catalog`) no tiene
        // una para este evento y añadirla queda fuera del alcance asignado
        // a este corrector (packages/mail no está en su ámbito de cambio).
        // Dado que (a)-(c) ya cierran la toma de cuenta en el mismo acto
        // (la contraseña del atacante queda inservible de inmediato, sin
        // depender de que la víctima llegue a leer ningún correo), (d)
        // queda como mejora de notificación, no como parte del cierre de
        // la vulnerabilidad -- pendiente para una ronda que sí toque
        // packages/mail.

        await recordAuthAudit(tx, {
          actorId: userId,
          action: 'auth.google_linked',
          // AM-01: `accountWasSquatted` distingue auditablemente esta rama
          // de una vinculación "limpia" -- nunca un `action` nuevo:
          // `app.record_auth_event` (0084) rechaza cualquier acción fuera
          // de su lista fija en SQL, y ampliarla requeriría una migración
          // de packages/db, fuera del alcance de esta ronda de
          // correcciones (ver AM-04 en docs/auditoria-2/api-mail.md).
          after: { ip: audit.ip, userAgent: audit.userAgent, accountWasSquatted },
          requestId: audit.requestId,
        });
      } else {
        // 3) REQ-174: ningún usuario con ese email -- crear cuenta nueva,
        // SIN contraseña (password_hash NULL, ver 0071_req172_google_oidc.sql).
        const newUserId = randomUUID();
        await tx.query('insert into users (id, email, password_hash, full_name) values ($1, $2, null, null)', [
          newUserId,
          claims.email,
        ]);
        userId = newUserId;
        isNewUser = true;
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        await tx.query('insert into user_identities (user_id, provider, subject, email) values ($1, $2, $3, $4)', [
          userId,
          'google',
          claims.sub,
          claims.email,
        ]);

        // REQ-174: si había invitación(es) pendiente(s) para este email,
        // aceptarlas ahora (entra a esa/esas organización(es) en vez de la
        // compuerta `sin_acceso`) -- nunca se crea una organización nueva
        // automáticamente (ver docs/investigacion/salida-promocion-referencias.md
        // §1.3, patrón `SIN_ROL`/`/sin-acceso` de Likida).
        const accepted = await tx.query('select * from app.accept_pending_invitations_for_user($1)', [userId]);
        acceptedInvitations = accepted.rows.length;
      }
    }

    if (!userId) {
      // Inalcanzable en la práctica (todas las ramas de arriba fijan
      // `userId`) -- se deja como salvaguarda explícita.
      throw new GoogleRejectionError(401, 'no_user_resolved', 'No se pudo resolver la identidad de Google.');
    }

    // REQ-176: ¿la cuenta tiene 2FA enrolado Y VERIFICADO? Un usuario recién
    // creado en esta misma operación nunca puede tenerlo (aún no existía).
    let requiresTwoFactor = false;
    if (!isNewUser) {
      const totp = await tx.query<{ verified_at: string | Date | null }>(
        'select verified_at from user_totp_secrets where user_id = $1',
        [userId]
      );
      requiresTwoFactor = totp.rows.length > 0 && totp.rows[0].verified_at !== null;
    }

    const orgs = await tx.query('select * from app.my_organizations()');
    const hasAnyOrganization = orgs.rows.length > 0;

    return { userId, isNewUser, linkedNow, acceptedInvitations, requiresTwoFactor, hasAnyOrganization };
  });
}

/**
 * GO-07 (docs/auditoria-2/api-google.md, MODERADA): resuelve la identidad de
 * Google tolerando la CARRERA entre dos callbacks concurrentes del mismo
 * email/subject nunca visto (doble clic, dos pestañas, o un intento
 * deliberado de forzarla).
 *
 * El problema: `resolveGoogleIdentityOnce` decide qué rama tomar leyendo
 * `app.find_identity_by_subject`/`app.find_user_by_email` y DESPUÉS inserta.
 * Dos transacciones simultáneas pueden leer ambas "no existe" antes de que
 * ninguna commitee; la segunda en llegar al `INSERT` recibe un `23505` de
 * `ux_users_email_lower` (0002) o de `user_identities (provider, subject)` /
 * `(provider, user_id)` (0071). Sin este manejo, esa excepción cruda
 * atravesaba `handleCallback` (que solo distinguía `GoogleRejectionError`)
 * hasta el manejador genérico -> **500**, con el mensaje crudo de Postgres
 * reflejado al cliente fuera de producción.
 *
 * La reparación es el espejo exacto del patrón que `POST /auth/register` ya
 * usa para esta MISMA clase de carrera (`UNIQUE_VIOLATION` en
 * `modules/auth/routes.ts`), adaptado a que aquí sí queremos continuar el
 * flujo: reintentar la resolución completa una vez. El reintento abre una
 * transacción NUEVA, cuyo snapshot ya incluye el commit del ganador, así que
 * encuentra la fila y sigue por la rama de vinculación/login normal --
 * el usuario recibe su sesión, no un error.
 *
 * Se reintenta la transacción ENTERA (en vez de un `savepoint` alrededor de
 * cada `INSERT`) por dos razones: en Postgres la transacción queda abortada
 * tras el error, y `app.find_*` son funciones PRE-SESIÓN que se niegan a
 * correr si `app.current_user_id()` ya está fijado (0019/0044/0071) -- releer
 * dentro de la misma transacción, que ya fijó ese contexto, sería imposible.
 *
 * Si el segundo intento vuelve a chocar (escenario patológico: alguien
 * forzando la carrera en bucle), se responde un **409 controlado** --
 * auditado como cualquier otro rechazo, con un mensaje de negocio propio y
 * sin filtrar el error de Postgres ni traza alguna.
 *
 * NOTA: no cambia en absoluto la compuerta `sin_acceso` (D-09,
 * docs/DECISIONES.md) -- este reintento solo decide CÓMO se resuelve la
 * identidad, nunca si se crea una organización.
 */
async function resolveGoogleIdentity(
  app: FastifyInstance,
  claims: { sub: string; email: string },
  audit: { ip: string; userAgent: string | null; requestId: string }
): Promise<ResolvedIdentity> {
  for (let attempt = 1; attempt <= IDENTITY_RESOLUTION_ATTEMPTS; attempt += 1) {
    try {
      return await resolveGoogleIdentityOnce(app, claims, audit);
    } catch (err) {
      // Un rechazo de negocio ya decidido (cuenta inactiva, conflicto de
      // REQ-180...) NUNCA se reintenta: reintentarlo no cambiaría nada y
      // duplicaría su auditoría. Cualquier error que no sea `23505` tampoco
      // es esta carrera: se propaga tal cual.
      if (err instanceof GoogleRejectionError || !isUniqueViolation(err)) throw err;
    }
  }

  throw new GoogleRejectionError(
    409,
    'identity_race_unresolved',
    'Otro inicio de sesión con Google para esta misma cuenta se completó al mismo tiempo. Vuelva a intentarlo.'
  );
}

export async function googleAuthRoutes(app: FastifyInstance): Promise<void> {
  // GO-03 (docs/auditoria-2/api-google.md): FALLA EN ARRANQUE si el operador
  // fijó un `OIDC_ISSUER_URL` inseguro. Se comprueba aquí, al registrar las
  // rutas (es decir, dentro de `buildApp`), y no de forma perezosa en la
  // primera petición: un issuer mal configurado es un error del despliegue,
  // y un despliegue que arranca "sano" y solo falla cuando alguien intenta
  // entrar con Google es peor que uno que se niega a arrancar. No exige que
  // las credenciales de Google existan (REQ-178: la API arranca sin ellas).
  assertConfiguredIssuerUrlIsSecure();

  const server = app.withTypeProvider<ZodTypeProvider>();
  const authRateLimit = { max: app.rateLimitSettings.auth.max, timeWindow: app.rateLimitSettings.auth.timeWindow };

  server.get(
    '/start',
    {
      config: { rateLimit: authRateLimit },
      schema: { response: { 200: googleStartResponseSchema } },
    },
    async () => {
      let env;
      try {
        env = loadGoogleOidcEnv();
      } catch (err) {
        // GO-03: cualquier error de CONFIGURACIÓN (credenciales ausentes o
        // issuer inseguro) responde el mismo 503 explícito, nunca un 500.
        if (err instanceof GoogleOidcConfigError) throw serviceUnavailable(err.message);
        throw err;
      }
      const discovery = await fetchDiscoveryDocument(env.issuerUrl);

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = computeCodeChallengeS256(codeVerifier);
      const nonce = generateNonce();
      const oauthStateId = randomUUID();

      await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query(
          `select app.create_oauth_state($1, $2, $3, $4, $5, now() + interval '${OAUTH_STATE_TTL_MINUTES} minutes')`,
          [oauthStateId, 'google', codeVerifier, nonce, env.redirectUri]
        );
      });

      const state = await signOauthState(app.config.jwtSecret, oauthStateId, OAUTH_STATE_TTL_MINUTES * 60);

      const url = new URL(discovery.authorization_endpoint);
      url.searchParams.set('client_id', env.clientId);
      url.searchParams.set('redirect_uri', env.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');

      return { authorizationUrl: url.toString() };
    }
  );

  server.get(
    '/callback',
    {
      config: { rateLimit: authRateLimit },
      schema: { querystring: googleCallbackQuerySchema, response: { 200: googleAuthResultSchema } },
    },
    async (request) => {
      const { code, state, error } = request.query;
      const { ip, userAgent } = auditContext(request);

      if (error) {
        await auditGoogleRejected(app, { actorId: null, reason: `provider_error:${error}`, ip, userAgent, requestId: request.id });
        throw new BadRequestError('El proveedor reportó un error en el flujo de autorización (el usuario pudo haber cancelado el consentimiento).');
      }

      // 1) Anti-CSRF/anti-replay: verificar firma+expiración del `state` y
      // consumir ATÓMICAMENTE la fila de `oauth_states` (un solo uso --
      // cualquier reintento con el MISMO `state`, incluido un nonce
      // reutilizado, ve 0 filas aquí).
      let oauthStateId: string;
      try {
        oauthStateId = await verifyOauthState(app.config.jwtSecret, state);
      } catch {
        await auditGoogleRejected(app, { actorId: null, reason: 'state_signature_invalid_or_expired', ip, userAgent, requestId: request.id });
        throw new BadRequestError('El parámetro state es inválido o expiró. Reinicie el login con Google.');
      }

      const consumed = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ code_verifier: string; nonce: string; redirect_uri: string }>(
          'select * from app.consume_oauth_state($1)',
          [oauthStateId]
        );
      });
      if (consumed.rows.length === 0) {
        await auditGoogleRejected(app, { actorId: null, reason: 'state_already_consumed_or_expired', ip, userAgent, requestId: request.id });
        throw new BadRequestError('El parámetro state ya fue utilizado o expiró (posible reintento/CSRF). Reinicie el login con Google.');
      }
      const { code_verifier: codeVerifier, nonce, redirect_uri: redirectUri } = consumed.rows[0];

      if (!code) {
        await auditGoogleRejected(app, { actorId: null, reason: 'missing_code', ip, userAgent, requestId: request.id });
        throw new BadRequestError('Falta el parámetro code.');
      }

      let env;
      try {
        env = loadGoogleOidcEnv();
      } catch (err) {
        // GO-03: cualquier error de CONFIGURACIÓN (credenciales ausentes o
        // issuer inseguro) responde el mismo 503 explícito, nunca un 500.
        if (err instanceof GoogleOidcConfigError) throw serviceUnavailable(err.message);
        throw err;
      }
      const discovery = await fetchDiscoveryDocument(env.issuerUrl);

      let idToken: string;
      try {
        const exchanged = await exchangeAuthorizationCode({
          tokenEndpoint: discovery.token_endpoint,
          code,
          codeVerifier,
          redirectUri,
          clientId: env.clientId,
          clientSecret: env.clientSecret,
        });
        idToken = exchanged.idToken;
      } catch {
        await auditGoogleRejected(app, { actorId: null, reason: 'token_exchange_failed', ip, userAgent, requestId: request.id });
        throw new UnauthorizedError('No se pudo completar el intercambio de código con el proveedor de Google.');
      }

      let claims;
      try {
        claims = await verifyGoogleIdToken({
          idToken,
          jwksUri: discovery.jwks_uri,
          issuer: discovery.issuer,
          audience: env.clientId,
          expectedNonce: nonce,
        });
      } catch (err) {
        await auditGoogleRejected(app, { actorId: null, reason: `id_token_invalid:${(err as Error).message}`, ip, userAgent, requestId: request.id });
        throw new UnauthorizedError('El id_token de Google no es válido (aud/iss/exp/nonce).');
      }

      // REQ-179: email_verified=false se rechaza EXPLÍCITAMENTE -- nunca
      // crea cuenta, nunca vincula, nunca inicia sesión.
      if (!claims.email || !claims.emailVerified) {
        await auditGoogleRejected(app, { actorId: null, reason: 'email_not_verified', ip, userAgent, requestId: request.id });
        throw new ForbiddenError('La cuenta de Google no tiene un email verificado; el login se rechaza (REQ-179).');
      }

      let resolved: ResolvedIdentity;
      try {
        resolved = await resolveGoogleIdentity(app, { sub: claims.sub, email: claims.email }, { ip, userAgent, requestId: request.id });
      } catch (err) {
        if (err instanceof GoogleRejectionError) {
          await auditGoogleRejected(app, { actorId: err.actorId, reason: err.reason, ip, userAgent, requestId: request.id });
          if (err.httpStatus === 403) throw new ForbiddenError(err.userMessage);
          // GO-07: carrera de identidad no resuelta tras el reintento --
          // 409 explícito y auditado, nunca un 500 con el error de Postgres.
          if (err.httpStatus === 409) throw new ConflictError(err.userMessage);
          throw new UnauthorizedError(err.userMessage);
        }
        throw err;
      }

      if (resolved.requiresTwoFactor) {
        const pendingToken = await signPending2faToken(app.config.jwtSecret, resolved.userId);
        return { status: 'requires_2fa' as const, pendingToken };
      }

      const tokens = await issueTokenPair(app, resolved.userId, {
        ip,
        userAgent,
        requestId: request.id,
        action: 'auth.google_login',
        extra: { provider: 'google', isNewUser: resolved.isNewUser, linked: resolved.linkedNow, acceptedInvitations: resolved.acceptedInvitations },
      });

      return { status: resolved.hasAnyOrganization ? ('ok' as const) : ('sin_acceso' as const), ...tokens };
    }
  );

  server.post(
    '/verify-2fa',
    {
      config: { rateLimit: authRateLimit },
      schema: { body: googleVerify2faBodySchema, response: { 200: googleAuthResultSchema } },
    },
    async (request) => {
      const { pendingToken, code } = request.body;
      const { ip, userAgent } = auditContext(request);

      let userId: string;
      try {
        userId = await verifyPending2faToken(app.config.jwtSecret, pendingToken);
      } catch {
        throw new UnauthorizedError('El token pendiente de verificación en dos pasos es inválido o expiró. Reinicie el login con Google.');
      }

      const withUserTx = <T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
        app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
          return fn(tx);
        });

      // R5-02 (mismo patrón que `modules/twofa/routes.ts`): bloqueo
      // progresivo por usuario, comparte el contador con
      // `/auth/2fa/step-up`/`/auth/2fa/verify-enrollment` (misma tabla
      // `twofa_lockouts`) -- rotar de flujo no reinicia el presupuesto de
      // intentos contra la misma cuenta.
      const lockout = await withUserTx((tx) => checkTwofaLockout(tx, userId));
      if (lockout.locked) {
        const minutes = Math.max(1, Math.ceil(lockout.retryAfterSeconds / 60));
        throw new TooManyRequestsError(
          `Demasiados intentos fallidos de verificación en dos pasos. Cuenta bloqueada temporalmente por ${minutes} minuto(s).`,
          lockout.retryAfterSeconds
        );
      }

      const totpRow = await withUserTx((tx) =>
        tx.query<{ secret_ciphertext: string; verified_at: string | Date | null; last_used_time_step: string | number | null }>(
          'select secret_ciphertext, verified_at, last_used_time_step from user_totp_secrets where user_id = $1',
          [userId]
        )
      );
      if (totpRow.rows.length === 0 || totpRow.rows[0].verified_at === null) {
        throw new ForbiddenError('Esta cuenta ya no tiene 2FA vigente.');
      }

      const rawCode = code.trim();
      if (looksLikeBackupCode(rawCode)) {
        const codeHash = hashBackupCode(rawCode);
        const backupRow = await withUserTx((tx) =>
          tx.query<{ id: string }>('select id from user_backup_codes where user_id = $1 and code_hash = $2 and used_at is null', [userId, codeHash])
        );
        if (backupRow.rows.length === 0) {
          await withUserTx((tx) => recordTwofaFailure(tx, userId));
          throw new ForbiddenError('Código de respaldo inválido o ya utilizado.');
        }
        await withUserTx((tx) => tx.query('update user_backup_codes set used_at = now() where id = $1', [backupRow.rows[0].id]));
      } else {
        const sixDigit = assertSixDigitCode(rawCode);
        const secret = decryptSecret(totpRow.rows[0].secret_ciphertext, app.config.totpEncryptionKey);
        const verification = await verifyTotpCode(secret, sixDigit);
        const lastUsed = totpRow.rows[0].last_used_time_step === null ? null : Number(totpRow.rows[0].last_used_time_step);
        if (!verification.valid || (lastUsed !== null && verification.timeStep <= lastUsed)) {
          await withUserTx((tx) => recordTwofaFailure(tx, userId));
          throw new ForbiddenError('Código TOTP inválido, o ya fue utilizado (replay rechazado).');
        }
        await withUserTx((tx) => tx.query('update user_totp_secrets set last_used_time_step = $1 where user_id = $2', [verification.timeStep, userId]));
      }

      await withUserTx((tx) => resetTwofaFailures(tx, userId));

      const orgs = await withUserTx((tx) => tx.query('select * from app.my_organizations()'));
      const tokens = await issueTokenPair(app, userId, {
        ip,
        userAgent,
        requestId: request.id,
        action: 'auth.google_login',
        extra: { provider: 'google', twoFactor: true },
      });

      return { status: orgs.rows.length > 0 ? ('ok' as const) : ('sin_acceso' as const), ...tokens };
    }
  );
}

