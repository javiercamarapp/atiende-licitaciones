import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * WK6-04 (docs/auditoria-2/worker-agentes-reverificacion.md, MEDIA): el
 * `correlationId` de NEGOCIO de un job (p. ej. el `tenderId` de origen, ver
 * `RunAgentPayload.correlationId` en `handlers/run-agent.ts`) es un dato de
 * confianza LIMITADA. Hoy `apps/api` ya lo sanea a UUID en su frontera
 * (`plugins/correlation-id.plugin.ts`) y los productores internos de
 * `run_agent`/`discover_tenders` (`handlers/discover-tenders.ts`,
 * `scheduler/deadline-reminders.ts`, `scheduler/scheduler.ts`) pasan UUIDs
 * reales de la base -- pero `apps/worker` en sí mismo no tenía NINGUNA
 * defensa propia: un valor mal formado (10 KB, caracteres de control,
 * overrides bidireccionales RTL/LRO, secuencias ANSI, un byte NUL) se
 * propagaba íntegro a cada línea de log estructurado (`queue/worker.ts`) y
 * a `agent_runs.output`/`agent_runs.correlation_id` (`handlers/run-agent.ts`),
 * un byte NUL rompía directamente el `INSERT` en Postgres (jsonb no admite
 * el byte 0x00) para cualquier productor DENTRO de este mismo paquete que
 * lo escribiera en un payload nuevo (`agents/enqueue-agent-run.ts`), y el
 * mismo valor crudo viajaba tal cual hacia `source_runs.correlation_id` y
 * la cabecera HTTP saliente `X-Correlation-Id` (`handlers/discover-tenders.ts`
 * + `ingest/ingest-client.ts`, REQ-171) -- ahí un salto de línea/CR es
 * inyección de cabecera, no solo un dato sucio en un log.
 *
 * Esta es la ÚNICA función de saneamiento para las cuatro fronteras donde el
 * valor cruza de "dato de negocio no confiable" a "log/columna persistida/
 * cabecera saliente":
 *  1. `queue/worker.ts` (`businessCorrelationId`) -- al LEER el payload de
 *     un job ya reclamado, antes de fijarlo como binding del logger hijo.
 *  2. `agents/enqueue-agent-run.ts` -- al ESCRIBIR el payload de un job
 *     `run_agent` nuevo Y al abrir su fila `agent_runs` (INSERT), para que
 *     un valor con NUL nunca llegue a `JobQueue.enqueue()` y la fila nazca
 *     ya correlacionable (WK6-04, "audit gap": antes de esta corrección
 *     `correlation_id` quedaba NULL hasta que la corrida terminara -- una
 *     corrida que muere a mitad de camino sin ese `UPDATE` final quedaba
 *     sin correlación de forma permanente).
 *  3. `handlers/run-agent.ts` -- antes de construir `AgentRunRequest`, así
 *     que `run.correlationId`/`ToolCallTrace.correlationId`/
 *     `agent_runs.correlation_id` nunca reciben el valor crudo.
 *  4. `handlers/discover-tenders.ts` -- antes de usarlo como
 *     `source_runs.correlation_id` y como la cabecera `X-Correlation-Id`
 *     que `TenderIngestClient.ingest()` manda a `apps/api`.
 *
 * Acepta SOLO un UUID (cualquier versión, minúsculas o mayúsculas) o un
 * token opaco `[A-Za-z0-9._-]{1,64}` -- mismo alfabeto que los identificadores
 * ya usados en el resto del sistema (slugs, ids de plantilla, etc.).
 * Cualquier otro valor (longitud fuera de rango, caracteres de control,
 * overrides bidireccionales, ANSI, NUL, unicode fuera de ese alfabeto) se
 * reemplaza por un id DERIVADO determinista (`sane-<16 hex de sha256>`):
 * el valor crudo NUNCA se propaga a ningún log ni a la base de datos, pero
 * el reemplazo es estable -- el MISMO valor crudo malformado siempre deriva
 * el MISMO id saneado, así que jobs relacionados del mismo productor (p.
 * ej. reintentos con el mismo `correlationId` corrupto) siguen siendo
 * agrupables entre sí por ese id derivado.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const CORRELATION_ID_SCHEMA = z
  .string()
  .refine((value) => UUID_RE.test(value) || TOKEN_RE.test(value), {
    message: 'correlationId debe ser un UUID o un token [A-Za-z0-9._-]{1,64}',
  });

const SANITIZED_ID_PREFIX = 'sane-';

/**
 * Determinista a propósito (ver docstring del módulo): sha256 del valor
 * crudo completo (nunca truncado ANTES de hashear, para que dos valores
 * crudos distintos que solo difieren después del carácter 64 no colisionen
 * en el mismo id derivado), recortado a 16 hex -- suficiente para agrupar
 * sin acercarse al límite de 64 caracteres de `TOKEN_RE`.
 */
function deriveSanitizedId(raw: string): string {
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${SANITIZED_ID_PREFIX}${digest}`;
}

export interface SanitizeCorrelationIdResult {
  /** Siempre seguro de propagar a logs/BD: el valor original si pasó `CORRELATION_ID_SCHEMA`, o un id derivado determinista si no. */
  value: string;
  /** `true` cuando el valor original NO pasó el esquema y tuvo que reemplazarse por el id derivado. */
  wasSanitized: boolean;
}

/**
 * `raw` es lo que sea que venga en `payload.correlationId` (tipo `unknown`
 * a propósito: el payload de un job es JSONB sin esquema forzado). Devuelve
 * `null` cuando no hay NADA usable -- falta el campo, no es `string`, o es
 * la cadena vacía -- para que el llamador conserve su propio comportamiento
 * de respaldo ya existente (`?? job.id`, WK6-02), nunca `"undefined"` ni una
 * cadena vacía como identificador de correlación.
 */
export function sanitizeCorrelationId(raw: unknown): SanitizeCorrelationIdResult | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const parsed = CORRELATION_ID_SCHEMA.safeParse(raw);
  if (parsed.success) return { value: raw, wasSanitized: false };
  return { value: deriveSanitizedId(raw), wasSanitized: true };
}
