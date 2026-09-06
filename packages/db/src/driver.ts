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
}

export async function createPgClient(options: PgDbOptions): Promise<DbClient> {
  const pg = await import('pg');
  const Pool = pg.default?.Pool ?? pg.Pool;
  const pool = new Pool({ connectionString: options.connectionString, max: options.max ?? 10 });

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
    return createPgClient({ connectionString: url });
  }
  // Por defecto (sin DATABASE_URL, p.ej. en tests): PGlite en memoria.
  return createPgliteClient();
}
