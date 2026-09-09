/**
 * Abstracción mínima de acceso a datos que funciona igual sobre PGlite
 * (desarrollo/tests, Postgres embebido en WASM) y sobre `pg` (producción,
 * Postgres real vía DATABASE_URL). El objetivo es ejecutar EXACTAMENTE el
 * mismo SQL (migraciones y queries de la API) en ambos casos.
 */

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

/** Superficie mínima de ejecución de queries (una conexión o una transacción). */
export interface DbExecutor {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

/** Cliente de base de datos: puede ejecutar queries sueltas o abrir una transacción. */
export interface DbClient extends DbExecutor {
  /** Ejecuta un script SQL con varias sentencias (usado solo por el migrador). */
  exec(sql: string): Promise<void>;
  /** Ejecuta `fn` dentro de una transacción; hace COMMIT si resuelve, ROLLBACK si lanza. */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly dialect: 'pglite' | 'pg';
}

export interface PgliteDbOptions {
  /** Ruta a un directorio para persistir datos, o `undefined`/`'memory://'` para en memoria. */
  dataDir?: string;
}

export async function createPgliteClient(options: PgliteDbOptions = {}): Promise<DbClient> {
  const { PGlite } = await import('@electric-sql/pglite');
  const instance = options.dataDir ? new PGlite(options.dataDir) : new PGlite();

  const client: DbClient = {
    dialect: 'pglite',
    async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await instance.query<Row>(sql, params);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string) {
      await instance.exec(sql);
    },
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return instance.transaction(async (tx) => {
        const wrapped: DbExecutor = {
          async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            const res = await tx.query<Row>(sql, params);
            return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
          },
        };
        return fn(wrapped);
      });
    },
    async close() {
      await instance.close();
    },
  };

  return client;
}

export interface PgDbOptions {
  connectionString: string;
  max?: number;
  /**
   * Supabase (y la mayoría de Postgres gestionados) exige TLS incluso en el
   * *transaction pooler* (puerto 6543): sin esto, `pg` intenta una conexión
   * en claro y el proveedor la rechaza. `rejectUnauthorized: false` es
   * necesario porque Supabase presenta un certificado firmado por una CA
   * que Node no trae en su almacén por defecto (mismo patrón documentado
   * por Supabase/Prisma/Vercel para `pg` -- no es "sin verificar el
   * servidor", es "sin verificar la cadena CA completa"; el propio host
   * fijo de `connectionString` ya ancla la conexión al proveedor correcto).
   * `undefined`/`false` deshabilita TLS (solo para PGlite/Postgres local
   * sin TLS -- nunca usar `ssl: false` explícito contra un proveedor real).
   */
  ssl?: boolean | { rejectUnauthorized: boolean };
}

/**
 * NOTA (Supabase transaction pooler, puerto 6543, PgBouncer en modo
 * transaction): `pg.Pool.query(text, params)` -- el ÚNICO patrón usado en
 * todo el repo (ver grep documentado en docs/despliegue-supabase-vercel.md)
 * -- ejecuta el SQL con una sentencia preparada SIN NOMBRE (`name`
 * ausente), que `pg` prepara/ejecuta/descarta dentro del MISMO checkout de
 * conexión antes de liberarla al pool; nunca sobrevive entre dos llamadas
 * a `.query()` distintas. Eso es exactamente lo que el modo transacción de
 * PgBouncer/Supabase soporta -- el problema conocido de "prepared
 * statement does not exist" solo aparece con sentencias NOMBRADAS
 * reutilizadas entre checkouts (`client.query({ name: '...', ... })`),
 * patrón que este código no usa en ningún sitio. `SET LOCAL ROLE
 * app_role`/`set_config(..., true)` (ver plugins/auth.plugin.ts,
 * lib/step-up.ts) también son seguros: ambos son transaction-scoped
 * (`true` = local a la transacción) y solo se usan dentro de
 * `db.transaction()`, que mantiene una única conexión física para todo el
 * BEGIN..COMMIT -- compatible con el pooler transaccional. No se requiere
 * ningún cambio de código para esto, solo esta nota + `max` bajo (ver
 * `PgDbOptions.max`, cada instancia serverless abre su propio pool: con
 * muchas instancias concurrentes, un `max` alto multiplicaría conexiones
 * reales contra el pooler).
 */
export async function createPgClient(options: PgDbOptions): Promise<DbClient> {
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    ssl: options.ssl,
  });

  const client: DbClient = {
    dialect: 'pg',
    async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as Row[], rowCount: res.rowCount ?? 0 };
    },
    async exec(sql: string) {
      // node-postgres ejecuta múltiples sentencias separadas por ';' vía el
      // protocolo simple cuando la query es un string plano sin parámetros.
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      try {
        await conn.query('begin');
        const wrapped: DbExecutor = {
          async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            const res = await conn.query(sql, params);
            return { rows: res.rows as Row[], rowCount: res.rowCount ?? 0 };
          },
        };
        const result = await fn(wrapped);
        await conn.query('commit');
        return result;
      } catch (err) {
        await conn.query('rollback').catch(() => undefined);
        throw err;
      } finally {
        conn.release();
      }
    },
    async close() {
      await pool.end();
    },
  };

  return client;
}

/**
 * Crea el cliente adecuado según la variable de entorno DATABASE_URL:
 * - Si empieza por `pglite://` (o está vacía y NODE_ENV=test), usa PGlite.
 * - Si es una URL de Postgres normal (postgres:// o postgresql://), usa `pg`.
 */
export async function createDbClientFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<DbClient> {
  const url = env.DATABASE_URL ?? '';
  if (url.startsWith('pglite://')) {
    const dataDir = url.slice('pglite://'.length);
    return createPgliteClient({ dataDir: dataDir === 'memory' || dataDir === '' ? undefined : dataDir });
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    // `DATABASE_URL_NO_SSL=true` es una vía de escape SOLO para Postgres
    // local sin TLS (docker-compose de desarrollo) -- cualquier otro caso
    // (incluida la ausencia de esta variable) activa TLS, porque un
    // proveedor gestionado real (Supabase) siempre lo exige. `DATABASE_URL_POOL_MAX`
    // (por defecto 3, deliberadamente bajo): en despliegue serverless cada
    // instancia de función abre su PROPIO pool -- con `max=10` por defecto
    // y decenas de instancias concurrentes se agotarían las conexiones del
    // *transaction pooler* de Supabase mucho antes que su propio límite
    // documentado (ver docs/despliegue-supabase-vercel.md).
    const ssl = env.DATABASE_URL_NO_SSL === 'true' ? undefined : { rejectUnauthorized: false };
    const max = Number(env.DATABASE_URL_POOL_MAX ?? 3);
    return createPgClient({ connectionString: url, ssl, max: Number.isFinite(max) && max > 0 ? max : 3 });
  }
  // Por defecto (sin DATABASE_URL, p.ej. en tests): PGlite en memoria.
  return createPgliteClient();
}
