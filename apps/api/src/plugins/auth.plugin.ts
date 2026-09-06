import { timingSafeEqual } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/jwt.js';
import { UnauthorizedError, ForbiddenError, BadRequestError } from '../lib/errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decora `app.authenticate`: exige `Authorization: Bearer <access token>`. */
async function authPluginImpl(app: FastifyInstance): Promise<void> {
  app.decorate('authenticate', async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Falta encabezado Authorization: Bearer <token>');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await verifyAccessToken(app.config.jwtSecret, token);
      request.userId = payload.sub;
    } catch {
      throw new UnauthorizedError('Token de acceso inválido o expirado');
    }
  });

  app.decorate('requireOrg', async function requireOrg(request: FastifyRequest): Promise<void> {
    if (!request.userId) {
      throw new UnauthorizedError();
    }
    const orgId = request.headers['x-org-id'];
    if (!orgId || typeof orgId !== 'string') {
      throw new ForbiddenError('Falta encabezado X-Org-Id');
    }
    // API-04 (docs/auditoria-1/db-api.md): un X-Org-Id que no es un UUID
    // válido llegaba sin validar hasta la consulta SQL, donde Postgres
    // lanzaba "invalid input syntax for type uuid" -- un 500 evitable
    // (enmascarado en producción, pero seguía siendo un 500). Se valida el
    // formato aquí y se responde 400 explícito antes de tocar la base.
    if (!UUID_PATTERN.test(orgId)) {
      throw new BadRequestError('X-Org-Id no es un UUID válido');
    }
    const { rows } = await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      // DB-01 (docs/auditoria-1/db-api.md): `app.membership_role` ahora solo
      // acepta `org_id` y resuelve SIEMPRE la membresía del propio
      // `app.current_user_id()` (fijado aquí abajo) -- ya no acepta un
      // `p_user_id` arbitrario que permitiera consultar el rol de otro
      // usuario. Ver packages/db/migrations/0019_fix_db01_security_definer_scope.sql.
      await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
      return tx.query<{ role: string | null }>('select app.membership_role($1) as role', [orgId]);
    });
    const role = rows[0]?.role;
    if (!role) {
      throw new ForbiddenError('No eres miembro de esta organización');
    }
    request.orgId = orgId;
    request.orgRole = role as FastifyRequest['orgRole'];
  });

  // Autenticación de servicios internos (p.ej. apps/worker) vía cabecera
  // `X-Platform-Api-Key` comparada contra `config.platformApiKey`. Falla
  // CERRADO: si la variable de entorno no está configurada, NINGUNA
  // solicitud pasa (nunca "sin clave configurada = abierto").
  app.decorate('requirePlatformApiKey', async function requirePlatformApiKey(request: FastifyRequest): Promise<void> {
    const expected = app.config.platformApiKey;
    if (!expected) {
      throw new ForbiddenError('PLATFORM_API_KEY no está configurada: la ingesta interna está deshabilitada');
    }
    const provided = request.headers['x-platform-api-key'];
    // API-12 (docs/auditoria-1/db-api-reverificacion.md, BAJA): comparar
    // secretos con `!==` filtra un canal de timing teórico (la comparación
    // de string de V8 termina en el primer byte distinto). Se usa
    // `timingSafeEqual` (mismo patrón que lib/passwords.ts), igualando
    // longitudes primero -- `timingSafeEqual` lanza si los buffers no
    // miden lo mismo, así que esa comparación de longitud debe hacerse
    // aparte y de forma segura de todos modos (una clave más corta/larga
    // ya es, por definición, distinta).
    if (!provided || typeof provided !== 'string' || !constantTimeEquals(provided, expected)) {
      throw new UnauthorizedError('Clave de API de plataforma inválida o ausente');
    }
  });
}

function constantTimeEquals(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export const authPlugin = fp(authPluginImpl, { name: 'auth-plugin' });
