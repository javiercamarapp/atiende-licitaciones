import type { SourceId } from '@atiende/sources';

export interface SourceScheduleConfig {
  sourceId: SourceId;
  /** `null`/`undefined` = corrida de plataforma (no por organización), que es el caso de descubrimiento hoy. */
  orgId?: string | null;
  /**
   * Cadencia real de esta fuente, en milisegundos (REQ-146: "según límites
   * reales del portal, no una cadencia fija universal"). Este worker
   * implementa el scheduler como "ventanas de tiempo fijas" alineadas a
   * `intervalMs` (una expresión cron real de tipo `* * * * *` queda
   * documentada como pendiente en el README: para el alcance de esta ronda,
   * un intervalo configurable por fuente ya cumple REQ-146/REQ-150 sin
   * arrastrar un parser de cron adicional).
   */
  intervalMs: number;
  enabled?: boolean;
}

/**
 * Cadencias por defecto, documentadas por fuente (no una cifra arbitraria
 * universal, ver REQ-146). Ajustables por env (`WORKER_SCHEDULE_JSON`, ver
 * `loadScheduleConfig`) sin tocar código para operar en producción con
 * límites reales medidos contra cada portal.
 */
export const DEFAULT_SCHEDULES: SourceScheduleConfig[] = [
  // ComprasMX exige reCAPTCHA (ver packages/sources README): mientras no haya
  // acceso autorizado, correr cada 30 min es suficiente para no insistir
  // contra un endpoint que hoy responde 401 de forma consistente.
  { sourceId: 'compras-mx', intervalMs: 30 * 60_000 },
  // OCDS-SHCP y PDN-S6 son APIs OCDS estándar: cadencia moderada (15 min).
  { sourceId: 'ocds-shcp', intervalMs: 15 * 60_000 },
  { sourceId: 'pdn-s6', intervalMs: 15 * 60_000 },
  // El DOF publica una vez al día (edición matutina/vespertina): cada hora
  // es más que suficiente y evita cargar el portal sin necesidad.
  { sourceId: 'dof', intervalMs: 60 * 60_000 },
  // Portales estatales: hoy sin `baseUrl` verificada (ver
  // packages/sources/src/connectors/state-portal), se mantiene en el
  // scheduler para que en cuanto se active una URL real, ya tenga cadencia.
  { sourceId: 'state-portal', intervalMs: 60 * 60_000 },
];

export function loadScheduleConfig(env: NodeJS.ProcessEnv = process.env): SourceScheduleConfig[] {
  const raw = env.WORKER_SCHEDULE_JSON;
  if (!raw) return DEFAULT_SCHEDULES;
  try {
    const parsed = JSON.parse(raw) as SourceScheduleConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_SCHEDULES;
    return parsed;
  } catch {
    return DEFAULT_SCHEDULES;
  }
}
