/**
 * Kill-switch por agente (Ronda 6, tarea 4: "kill-switch por agente vía
 * env/tabla propuesta"). Implementación REAL para esta ronda: variable de
 * entorno `WORKER_DISABLED_AGENTS` (lista separada por comas de
 * `agentName`). Una tabla dedicada (control dinámico sin reiniciar el
 * proceso) queda PROPUESTA, no implementada — ver
 * `apps/worker/db-proposals/PROPOSAL-06-agent-business-tools-grants.sql`
 * (comentario final) y README §Pendientes: esta ronda no agrega esa tabla
 * a `packages/db/migrations/` porque el env var ya resuelve el caso de uso
 * inmediato (bloquear un agente con mal comportamiento sin tocar código),
 * y una tabla nueva requeriría además un endpoint de administración en
 * `apps/api` (fuera de mi ámbito esta ronda) para ser operable de verdad.
 */
export class AgentKillSwitchError extends Error {
  readonly permanent = true as const;
  constructor(agentName: string) {
    super(
      `run_agent: el agente "${agentName}" está deshabilitado por kill-switch (WORKER_DISABLED_AGENTS). ` +
        'Ningún tool_call se ejecutó.',
    );
    this.name = 'AgentKillSwitchError';
  }
}

export function parseDisabledAgents(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.WORKER_DISABLED_AGENTS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function assertAgentNotDisabled(agentName: string, disabled: ReadonlySet<string>): void {
  if (disabled.has(agentName)) {
    throw new AgentKillSwitchError(agentName);
  }
}
