/**
 * D-11 (docs/DECISIONES.md, despliegue serverless en Vercel): `Store` de
 * `@fastify/rate-limit` (ver `../app.ts`, `app.register(rateLimit, { store
 * ... })`) persistido en `packages/db/migrations/0097_rate_limit_buckets.sql`
 * en vez de `LocalStore` (por defecto, en memoria del PROCESO). Necesario
 * porque una invocación serverless de Vercel puede ser una instancia de
 * Node distinta en cada request -- sin memoria compartida entre ellas -- así
 * que un `LocalStore` nunca vería el tráfico completo y el límite real
 * quedaría multiplicado por el número de instancias vivas.
 *
 * Contrato exacto que exige `@fastify/rate-limit` (ver
 * `node_modules/@fastify/rate-limit/store/{Local,Redis}Store.js`, la propia
 * librería no exporta un tipo TS de este contrato):
 *  - `incr(key, cb, timeWindowMs, max)`: incrementa el contador de `key` y
 *    entrega `{ current, ttl }` (`ttl` en ms restantes de la ventana) por
 *    callback -- NUNCA lanza de forma síncrona, siempre vía `cb`.
 *  - `child(routeOptions)`: `@fastify/rate-limit` crea una instancia hija
 *    por CADA configuración de ruta distinta (`config.rateLimit` en cada
 *    ruta, ver `modules/auth/routes.ts`, `modules/twofa/routes.ts`, etc.) --
 *    sin namespacing propio, dos tiers distintos (p. ej. `auth` y
 *    `sensitiveAction`) que compartieran el mismo `keyGenerator` por
 *    defecto (`req.ip`) COLISIONARÍAN en la misma fila de la tabla y un
 *    tier "prestaría" cupo al otro. `LocalStore` lo evita implícitamente
 *    (cada hija tiene su propio `Map` en memoria); `RedisStore` lo hace
 *    explícito con un prefijo `${method}${url}-` por hija (ver
 *    `RedisStore.child`). Aquí se replica exactamente ese patrón para que
 *    dos filas de `rate_limit_buckets` nunca se pisen entre tiers.
 *
 * Semántica de ventana (idéntica a `LocalStore`, documentada también en el
 * `comment on table` de la migración): ventana fija desde el primer hit
 * (`window_started_at`); hits siguientes solo incrementan `count` mientras
 * `now() < window_started_at + window_ms`; si ya expiró, se reinicia
 * (`count = 1`, `window_started_at = now()`). Todo en un único UPSERT
 * atómico (sin lectura-luego-escritura en JS): seguro bajo N instancias
 * concurrentes incrementando la MISMA clave, porque Postgres serializa el
 * UPSERT por fila (mismo argumento que ya documenta
 * `JobQueue.enqueue`/`claim` en apps/worker para su propio `FOR UPDATE SKIP
 * LOCKED`).
 *
 * `continueExceeding`/`exponentialBackoff` (ver `RateLimitOptions` de
 * `@fastify/rate-limit`): ningún tier de `lib/rate-limit-settings.ts` los
 * activa hoy, pero se soportan igual (misma fórmula que `LocalStore`) en
 * vez de ignorarlos en silencio, para que activarlos en el futuro no
 * requiera tocar este store.
 */
import type { DbClient } from '@atiende/db';

export interface RateLimitIncrResult {
  current: number;
  ttl: number;
}

export type RateLimitIncrCallback = (error: Error | null, result?: RateLimitIncrResult) => void;

/** Subconjunto de `RateLimitPluginOptions`/`RateLimitOptions` que este store necesita leer. */
export interface RateLimitStoreCtorOptions {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
  routeInfo?: { method?: string; url?: string };
}

export interface RateLimitStore {
  // NOTA: `@fastify/rate-limit` declara `FastifyRateLimitStore.incr` con
  // SOLO 2 parámetros (`key`, `callback`) en su propio `.d.ts`, pero su
  // implementación real (`index.js`, `applyRateLimit`) SIEMPRE lo llama con
  // 4 (`store.incr(key, cb, timeWindow, max)`, ver `LocalStore`/
  // `RedisStore`) -- un `.d.ts` incompleto de la librería, no un contrato
  // real de 2 argumentos. `timeWindowMs`/`max` se declaran opcionales aquí
  // SOLO para que TypeScript acepte esta clase como asignable a
  // `FastifyRateLimitStoreCtor` (que exige poder invocar `incr` con 2
  // argumentos) -- en la práctica siempre llegan (`incrAsync` lanza si no).
  incr(key: string, cb: RateLimitIncrCallback, timeWindowMs?: number, max?: number): void;
  // Mismo problema de tipado incompleto que `incr`: el `.d.ts` de
  // `@fastify/rate-limit` declara `child(routeOptions: RouteOptions &
  // {path, prefix})` (pensado, aparentemente, solo para stores que
  // necesitan la ruta) pero la implementación real (`index.js`,
  // `onRoute`/`createLimiterArgs`) SIEMPRE le pasa `mergedRateLimitParams`
  // (`continueExceeding`/`exponentialBackoff`/`routeInfo.method`/
  // `routeInfo.url`, ver `RedisStore.child` leyendo esos mismos campos) --
  // un objeto que NO tiene relación estructural con `RouteOptions`. `unknown`
  // es el único parámetro que hace a esta clase asignable a
  // `FastifyRateLimitStoreCtor` en cualquier dirección (contravarianza:
  // aceptar `unknown` es válido dondequiera que se espere aceptar algo más
  // específico); `readRouteMergedParams` extrae los campos reales en
  // tiempo de ejecución de forma segura.
  child(routeOptions: unknown): RateLimitStore;
}

function readRouteMergedParams(routeOptions: unknown): RateLimitStoreCtorOptions {
  if (!routeOptions || typeof routeOptions !== 'object') return {};
  const params = routeOptions as Record<string, unknown>;
  const routeInfoRaw = params.routeInfo;
  const routeInfo =
    routeInfoRaw && typeof routeInfoRaw === 'object'
      ? {
          method: typeof (routeInfoRaw as Record<string, unknown>).method === 'string' ? ((routeInfoRaw as Record<string, unknown>).method as string) : undefined,
          url: typeof (routeInfoRaw as Record<string, unknown>).url === 'string' ? ((routeInfoRaw as Record<string, unknown>).url as string) : undefined,
        }
      : undefined;
  return {
    continueExceeding: params.continueExceeding === true,
    exponentialBackoff: params.exponentialBackoff === true,
    routeInfo,
  };
}

interface BucketRow {
  count: string | number;
  ttl_ms: string | number | null;
}

const MAX_SAFE_TTL_MS = Number.MAX_SAFE_INTEGER;

// Verificado empíricamente contra PGlite (mismo motor que Postgres real
// para `power(float8, float8)`): a diferencia de `2 ** backoffExponent` en
// JS (que ante overflow produce silenciosamente `Infinity`, capturado luego
// por `Number.isSafeInteger` en `LocalStore.incr`, ver
// node_modules/@fastify/rate-limit/store/LocalStore.js), `power()` de
// Postgres LANZA `error: value out of range: overflow` en cuanto el
// resultado deja de representarse como `float8` (a partir de exponente
// 1024, `power(2::float8, 1024::float8)`). Sin este tope, un cliente que
// siguiera excediendo el límite el tiempo suficiente bajo un tier con
// `exponentialBackoff` (ninguno lo activa hoy, ver `rate-limit-settings.ts`,
// pero este store debe sostenerlo) haría que `incrAsync` rechazara con ese
// error -- y como el plugin se registra con `skipOnError: true` (ver
// `../app.ts`), un error del store hace que ESA petición se trate como
// "dentro del límite" (`current` se queda en 0, ver
// `applyRateLimit` en `node_modules/@fastify/rate-limit/index.js`): el
// propio backoff exponencial, cuyo objetivo es frenar CADA VEZ más a quien
// sigue excediendo el límite, terminaría abriendo la puerta por completo.
// 60 es un tope arbitrario pero sobra: `$2 * 2^60` ya excede
// `MAX_SAFE_TTL_MS` para cualquier `timeWindowMs` realista (incluso de solo
// 1 ms), así que el `least(...)` exterior sigue clampando el resultado al
// mismo valor que si no hubiera tope -- este límite solo evita que `power()`
// intente calcular un número astronómicamente más grande que igual iba a
// descartarse.
const MAX_BACKOFF_EXPONENT = 60;

/**
 * `@fastify/rate-limit` instancia el store con `new options.store(globalParams)`
 * (un solo argumento) -- para inyectar `DbClient` (que no forma parte de esa
 * llamada) se usa una fábrica que cierra sobre `db` y devuelve la clase ya
 * ligada a esa conexión. `keyPrefix` es un detalle interno de ESTA
 * implementación (no del contrato de `@fastify/rate-limit`): `child()` lo
 * calcula y lo pasa al construir la instancia hija; la instancia "raíz"
 * (la que crea el propio plugin para el tier `global`, sin pasar por
 * `child()`) usa `'global:'` por defecto.
 */
export function createPgRateLimitStoreCtor(db: DbClient): new (options: unknown) => RateLimitStore {
  return class PgRateLimitStore implements RateLimitStore {
    private readonly continueExceeding: boolean;
    private readonly exponentialBackoff: boolean;
    private readonly keyPrefix: string;

    constructor(options: unknown, keyPrefix = 'global:') {
      const params = readRouteMergedParams(options);
      this.continueExceeding = params.continueExceeding ?? false;
      this.exponentialBackoff = params.exponentialBackoff ?? false;
      this.keyPrefix = keyPrefix;
    }

    incr(key: string, cb: RateLimitIncrCallback, timeWindowMs?: number, max?: number): void {
      if (timeWindowMs === undefined || max === undefined) {
        // Nunca debería ocurrir contra la implementación real de
        // `@fastify/rate-limit` (ver nota en `RateLimitStore.incr`) -- se
        // falla explícito en vez de silenciarlo con un valor inventado.
        cb(new Error('rate-limit-store: incr() invocado sin timeWindowMs/max (contrato inesperado de @fastify/rate-limit)'));
        return;
      }
      const fullKey = `${this.keyPrefix}${key}`;
      this.incrAsync(fullKey, timeWindowMs, max)
        .then((result) => cb(null, result))
        .catch((error: unknown) => cb(error instanceof Error ? error : new Error(String(error))));
    }

    private async incrAsync(fullKey: string, timeWindowMs: number, max: number): Promise<RateLimitIncrResult> {
      const { rows } = await db.query<BucketRow>(
        `insert into rate_limit_buckets (key, count, window_started_at, window_ms, updated_at)
         values ($1, 1, now(), $2, now())
         on conflict (key) do update set
           count = case
             when rate_limit_buckets.window_started_at + (rate_limit_buckets.window_ms * interval '1 millisecond') <= now()
               then 1
             else rate_limit_buckets.count + 1
           end,
           window_started_at = case
             when rate_limit_buckets.window_started_at + (rate_limit_buckets.window_ms * interval '1 millisecond') <= now()
               then now()
             when ($4 or $5) and (rate_limit_buckets.count + 1) > $3
               then now()
             else rate_limit_buckets.window_started_at
           end,
           window_ms = case
             when rate_limit_buckets.window_started_at + (rate_limit_buckets.window_ms * interval '1 millisecond') <= now()
               then $2
             when $4 and (rate_limit_buckets.count + 1) > $3
               then $2
             when $5 and (rate_limit_buckets.count + 1) > $3
               then least($2 * power(2, least(greatest((rate_limit_buckets.count + 1) - $3 - 1, 0), ${MAX_BACKOFF_EXPONENT})), ${MAX_SAFE_TTL_MS})::bigint
             else rate_limit_buckets.window_ms
           end,
           updated_at = now()
         returning
           count,
           extract(epoch from (window_started_at + (window_ms * interval '1 millisecond') - now())) * 1000 as ttl_ms`,
        [fullKey, timeWindowMs, max, this.continueExceeding, this.exponentialBackoff]
      );
      const row = rows[0];
      const current = Number(row.count);
      const ttl = Math.max(0, Math.round(Number(row.ttl_ms ?? 0)));
      return { current, ttl };
    }

    child(routeOptions: unknown): RateLimitStore {
      const params = readRouteMergedParams(routeOptions);
      const method = params.routeInfo?.method ?? '';
      const url = params.routeInfo?.url ?? '';
      // Mismo patrón que `RedisStore.child` (namespacing explícito por
      // ruta): sin esto, dos tiers con el mismo `keyGenerator` por defecto
      // (`req.ip`) compartirían la misma fila de `rate_limit_buckets`.
      return new PgRateLimitStore(params, `${this.keyPrefix}${method}:${url}:`);
    }
  };
}
