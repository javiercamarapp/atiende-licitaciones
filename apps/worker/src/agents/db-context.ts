import type { DbClient, DbExecutor } from '@atiende/db';

/**
 * SchemaGrantPendingError (Ronda 6, agentes de negocio reales): traduce la
 * ausencia de la política RLS/grant que `PROPOSAL-06-agent-business-tools-
 * grants.sql` (PENDIENTE esquema, no aplicada a `packages/db` en esta
 * ronda) añadiría, en un mensaje explícito.
 *
 * NUNCA se traga el error ni devuelve una lista vacía/dato fabricado en su
 * lugar (REQ-150/AMPLIACION-BACKOFFICE, tolerancia cero a fabricar éxito):
 * el paso de la herramienta falla explícitamente, `AgentRunner` lo registra
 * como `status: "error"` en el `ToolCallTrace` y detiene la corrida. Se
 * marca `permanent: true` (WK-10, `apps/worker/src/queue/errors.ts`):
 * reintentar el job no arregla una política/grant que no se ha aplicado.
 *
 * Nota de diseño IMPORTANTE (descubierta al probar esto contra PGlite real,
 * no una suposición): `worker_role` hereda (`grant app_role to worker_role
 * ... inherit`, `packages/db/migrations/0028_worker_role.sql`) los
 * privilegios de TABLA por defecto de `app_role`
 * (`alter default privileges ... grant select, insert, update, delete on
 * tables to app_role`, `packages/db/migrations/0001_bootstrap.sql`) —es
 * decir, el GRANT de tabla en sí NUNCA fue la barrera real para
 * `worker_role` (ni siquiera antes de esta ronda: `information_schema.
 * role_table_grants` solo lista los GRANTS explícitos por nombre, no los
 * heredados por membresía, pero el acceso real SÍ existe vía herencia). La
 * única barrera real es la política RLS (`app.apply_org_rls`): sin una
 * política que reconozca a `worker_role`, un SELECT no lanza ningún error
 * — simplemente devuelve CERO FILAS en silencio (RLS filtra filas, no
 * bloquea la sentencia). Devolver una lista vacía como si fuera un
 * resultado real sería EXACTAMENTE el tipo de fabricación de éxito que
 * este proyecto prohíbe (REQ-150) — por eso estas funciones verifican
 * PRIMERO, contra el catálogo real `pg_policies`, que la política
 * `PROPOSAL-06` que reconoce a `worker_role` por identidad de conexión
 * (`current_user = 'worker_role'`) ya exista, y solo entonces ejecutan la
 * consulta de negocio. (Para INSERT/UPDATE, una violación de `with check`
 * SÍ es un error real de Postgres — la verificación de catálogo aplica
 * igual, por claridad y para no depender de emparejar mensajes de error).
 */
export class SchemaGrantPendingError extends Error {
  readonly permanent = true as const;

  constructor(operationLabel: string, cause: unknown) {
    super(
      `Falta la política RLS/grant de "${operationLabel}" para worker_role: ` +
        'apps/worker/db-proposals/PROPOSAL-06-agent-business-tools-grants.sql sigue PENDIENTE esquema ' +
        '(no aplicada a packages/db en esta ronda). ' +
        `Detalle: ${describeCause(cause)}`,
    );
    this.name = 'SchemaGrantPendingError';
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

const PERMISSION_DENIED_SQLSTATES = new Set(['42501']);

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' && PERMISSION_DENIED_SQLSTATES.has(code);
}

/**
 * Verifica en el catálogo REAL de Postgres (`pg_policies`) que la política
 * RLS `policyName` sobre `table` ya exista, antes de correr cualquier
 * consulta de negocio contra esa tabla. Ver docstring de
 * `SchemaGrantPendingError` para por qué esto es necesario (RLS SELECT
 * filtra en silencio, no lanza).
 */
async function assertWorkerPolicyExists(tx: DbExecutor, table: string, policyName: string): Promise<void> {
  const { rows } = await tx.query<{ found: boolean }>(
    `select exists (
       select 1 from pg_policies where schemaname = 'public' and tablename = $1 and policyname = $2
     ) as found`,
    [table, policyName],
  );
  if (!rows[0]?.found) {
    throw new SchemaGrantPendingError(table, new Error(`falta la política RLS "${policyName}" sobre "${table}"`));
  }
}

/**
 * Adopta `worker_role` (mismo patrón que `updateAgentRunRow`,
 * `src/handlers/run-agent.ts`, WK-23) para una operación de LECTURA de
 * negocio de una organización concreta. `orgId` se fija en
 * `app.current_org_id` como defensa en profundidad adicional — el filtro
 * explícito `WHERE org_id = $orgId` en cada query de `business-tools.ts` es
 * lo que de verdad acota el resultado a la organización del
 * `ToolExecutionContext`, nunca a la que el modelo pida.
 *
 * `tables`: nombres de tabla cuya política `sel_<tabla>_worker_role`
 * (PROPOSAL-06) debe existir; si falta CUALQUIERA, lanza
 * `SchemaGrantPendingError` ANTES de ejecutar `fn` — nunca deja pasar un
 * resultado parcial/vacío silencioso por una tabla sin política.
 */
export async function withWorkerBusinessReadContext<T>(
  db: DbClient,
  orgId: string,
  tables: string[],
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query('set local role worker_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
      for (const table of tables) {
        await assertWorkerPolicyExists(tx, table, `sel_${table}_worker_role`);
      }
      return fn(tx);
    });
  } catch (error) {
    if (error instanceof SchemaGrantPendingError) throw error;
    if (isPermissionDeniedError(error)) {
      throw new SchemaGrantPendingError(tables.join(','), error);
    }
    throw error;
  }
}

/**
 * Igual que `withWorkerBusinessReadContext`, pero SIN fijar `org_id` — para
 * el escáner PLATAFORMA de vencimientos próximos
 * (`src/scheduler/deadline-reminders.ts`, Ronda 6, tarea 4), que necesita
 * ver `tenders` de TODAS las organizaciones en una sola consulta (igual que
 * ya hace este worker con `jobs`/`source_runs`, ver README §Seguridad). La
 * política RLS adicional de `worker_role` (PROPOSAL-06:
 * `current_user = 'worker_role'`) no depende de `app.current_org_id`, así
 * que omitirlo aquí es intencional, no un descuido de aislamiento.
 */
export async function withWorkerPlatformReadContext<T>(
  db: DbClient,
  tables: string[],
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query('set local role worker_role');
      for (const table of tables) {
        await assertWorkerPolicyExists(tx, table, `sel_${table}_worker_role`);
      }
      return fn(tx);
    });
  } catch (error) {
    if (error instanceof SchemaGrantPendingError) throw error;
    if (isPermissionDeniedError(error)) {
      throw new SchemaGrantPendingError(tables.join(','), error);
    }
    throw error;
  }
}

/**
 * Igual que `withWorkerBusinessReadContext`, pero para la ÚNICA escritura de
 * negocio autónoma que este worker realiza fuera de `jobs`/`agent_runs`
 * (final de corrida) y `source_runs`: abrir su PROPIA fila de `agent_runs`
 * cuando reacciona a un evento de plataforma sin que `apps/api` la haya
 * creado antes (ver `PROPOSAL-06`, política `ins_agent_runs_worker_role`).
 */
export async function withWorkerAgentRunsInsertContext<T>(
  db: DbClient,
  orgId: string,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.query('set local role worker_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
      await assertWorkerPolicyExists(tx, 'agent_runs', 'ins_agent_runs_worker_role');
      // `INSERT ... RETURNING` también exige una política de SELECT que
      // haga visible la fila recién creada (ver comentario en
      // PROPOSAL-06-agent-business-tools-grants.sql) — verificada aquí
      // también para un mensaje de error más claro que un 42501 genérico.
      await assertWorkerPolicyExists(tx, 'agent_runs', 'sel_agent_runs_worker_role');
      return fn(tx);
    });
  } catch (error) {
    if (error instanceof SchemaGrantPendingError) throw error;
    if (isPermissionDeniedError(error)) {
      throw new SchemaGrantPendingError('insert on agent_runs', error);
    }
    throw error;
  }
}
