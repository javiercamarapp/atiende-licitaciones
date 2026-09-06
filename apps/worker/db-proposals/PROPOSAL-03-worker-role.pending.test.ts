import { describe, it } from 'vitest';

/**
 * Test PENDIENTE (WK-08, docs/auditoria-1/worker.md): acompaña a
 * `PROPOSAL-03-worker-role.sql`. La defensa en profundidad en CÓDIGO
 * (filtro explícito `org_id` en `updateAgentRunRow`) ya está cubierta y en
 * verde HOY — ver apps/worker/test/run-agent-handler.test.ts ("WK-08: un
 * job run_agent con organizationId de otro tenant nunca actualiza la fila
 * real"). Este test pendiente cubre la garantía ESTRUCTURAL adicional que
 * solo `worker_role` + RLS real puede dar: que ni siquiera un bug futuro en
 * el código de apps/worker (una query nueva sin el filtro `org_id`, un
 * `UPDATE agent_runs` distinto que alguien agregue después) pueda tocar la
 * fila de otro tenant, porque la propia conexión a la base de datos no
 * tiene privilegios para eso.
 */
describe.skip('PENDIENTE esquema — WK-08: worker_role con RLS real sobre agent_runs', () => {
  it('una conexión como worker_role con app.current_org_id de la org A no puede actualizar una fila agent_runs de la org B, ni con una query sin filtro explícito', () => {
    // Intencionalmente vacío. Habilitar tras aplicar
    // PROPOSAL-03-worker-role.sql: conectar como worker_role (o
    // `db.transaction` + `set local role worker_role` +
    // `set_config('app.current_org_id', orgA, true)`), ejecutar
    // `UPDATE agent_runs SET status='succeeded' WHERE id = $1` (SIN
    // filtro org_id, a propósito) sobre una fila que pertenece a orgB, y
    // esperar `rowCount === 0` (RLS bloquea, no una excepción de permiso
    // de columna/tabla).
  });

  it('worker_role no tiene ningún grant sobre tablas fuera de jobs/source_runs/agent_runs', () => {
    // Intencionalmente vacío. Habilitar tras aplicar la migración:
    // consultar information_schema.role_table_grants para worker_role y
    // afirmar que el conjunto de tablas es exactamente {jobs, source_runs,
    // agent_runs}.
  });
});
