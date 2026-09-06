import type { Role } from '@atiende/agents';

/**
 * Identidad de "actor" para corridas de agente disparadas AUTÓNOMAMENTE por
 * un evento de plataforma (ingesta, nueva versión, vencimiento próximo —
 * Ronda 6, tarea 4), sin que ningún usuario humano las haya solicitado.
 *
 * `SYSTEM_ACTOR_ID` es el UUID nil estándar (RFC 4122 §4.1.7), nunca un
 * usuario real de `users` — no se usa para verificar membresía (la fila
 * `agent_runs` que estas corridas crean vía `enqueueAgentRun` siempre queda
 * con `started_by = null`, y `PROPOSAL-06-agent-business-tools-grants.sql`
 * autoriza el INSERT/UPDATE de `worker_role` sobre esas filas exactamente
 * por esa condición — `started_by is null` — no por membresía de
 * `actorId`). Se usa únicamente como valor UUID válido para satisfacer la
 * validación de formato de `updateAgentRunRow` (WK-23) y como
 * `app.current_user_id` de una transacción que, para estas filas
 * específicas, ninguna política de RLS existente basada en membresía
 * necesita evaluar con éxito.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export const SYSTEM_ACTOR_ROLE: Role = 'system';
