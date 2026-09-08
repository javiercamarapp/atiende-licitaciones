/**
 * REQ-055 — radar de renovaciones. `POST /renewals/scan` es un escaneo BAJO
 * DEMANDA (sin cron real en esta ronda, ver README) sobre los contratos de
 * la organización con `end_date` conocida: genera alertas (`renewal_alerts`
 * + un job `renewal_radar_alert` por alerta, `jobs`, SIN envío externo) con
 * antelación configurable (por defecto 90/60/30 días). Cada alerta se
 * enriquece con hasta `MAX_HISTORICAL_TENDERS` convocatorias PREVIAS de la
 * MISMA organización y el MISMO `contracting_body` (si existen) como
 * contexto de apoyo -- ver límite documentado en
 * `lib/expediente/renewal-radar.ts`.
 *
 * R6-03 (docs/auditoria-2/api-ronda6.md, ALTA): la versión original hacía,
 * POR CADA alerta candidata, un `SELECT` de dedupe, un `SELECT` de
 * convocatorias históricas y 2 `INSERT` -- un patrón N+1 sin batching, sin
 * paginación y sin límite de tiempo. Medido en vivo por la auditoría: 5,000
 * contratos (15,000 alertas candidatas) tardaban 16.6-28s en una sola
 * petición HTTP/transacción contra PGlite EN MEMORIA (sin latencia de red
 * real) -- con Postgres real sobre red, mucho peor, y candidato claro a
 * exceder timeouts típicos de proxy/gateway (30-60s) sosteniendo una
 * transacción abierta todo ese tiempo.
 *
 * Reparación de esta ronda:
 *  - Contratos evaluados en PÁGINAS (`pageSize`, keyset sobre `contracts.id`
 *    -- `cursor`), nunca todos de una sola vez sin límite.
 *  - Por página: UNA sola consulta de dedupe (`contract_id = any($...)`) y
 *    UNA sola consulta de convocatorias históricas (ventana `row_number()`
 *    particionada por `contracting_body` para TODAS las entidades de la
 *    página a la vez) -- nunca una consulta por alerta.
 *  - Inserciones de `jobs`/`renewal_alerts` en LOTE (`INSERT ... SELECT ...
 *    FROM unnest(...)`, arreglos como parámetros) -- una sola sentencia por
 *    página sin importar cuántas alertas nuevas tenga, nunca un INSERT por
 *    fila.
 *  - Límite de tiempo por request (`maxDurationMs`, default 8s): si se
 *    supera entre páginas, el escaneo se detiene y responde
 *    `truncated:true` + `nextCursor` -- el llamador reintenta con ese
 *    cursor para continuar exactamente donde se quedó, en vez de dejar la
 *    petición HTTP colgada minutos.
 *  - `POST /renewals/scan/enqueue`: alternativa para NO ejecutar el
 *    escaneo de forma síncrona -- encola un job (`kind='renewal_radar_scan'`)
 *    para que un futuro worker lo procese en segundo plano avanzando por
 *    páginas (mismo `cursor`/`pageSize` de arriba) y persistiendo progreso
 *    en el propio payload del job. NINGÚN consumidor en `apps/worker`
 *    existe todavía para este `kind` en esta ronda -- se documenta
 *    honestamente, mismo patrón ya aceptado para `contract_state_alert`/
 *    `renewal_radar_alert` (ver `apps/api/docs/e11-cobertura.md`).
 *
 * Test de rendimiento (`test/expediente-renewal-radar.test.ts`): 5,000
 * contratos / 15,000 alertas candidatas en PGlite completan en <2s.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { WRITE_ROLES } from '@atiende/db';
import type { DbExecutor } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { ValidationAppError } from '../../lib/errors.js';
import { withTx } from '../../lib/expediente/context.js';
import { encodeCursor, decodeCursor, parsePageSize, toIsoString } from '../../lib/cursor.js';
import {
  computeRenewalAlertCandidates,
  computeUpcomingRenewals,
  urgencyForLeadDays,
  DEFAULT_RENEWAL_LEAD_DAYS,
  MAX_HISTORICAL_TENDERS,
  type RenewalCandidateContract,
} from '../../lib/expediente/renewal-radar.js';
import {
  renewalScanRequestSchema,
  renewalRadarRunSchema,
  renewalAlertsListQuerySchema,
  renewalAlertsListResponseSchema,
  renewalScanEnqueueRequestSchema,
  renewalScanEnqueueResponseSchema,
  renewalUpcomingQuerySchema,
  renewalUpcomingResponseSchema,
} from './schemas.js';

const NO_ENTITY_LABEL = 'no disponible';

function mapAlertRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    contractId: r.contract_id,
    tenderId: r.tender_id,
    sourceKind: r.source_kind,
    predictedDate: r.predicted_date,
    leadDays: r.lead_days,
    confidence: r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : null,
    notes: r.notes,
    jobId: r.job_id,
    status: r.status,
    createdAt: r.created_at,
  };
}

function toDateOnlyString(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * REQ-055 (ronda 8): parsea el CSV de `?thresholds=90,60,30` de
 * `GET /renewals/upcoming` a una lista de enteros positivos, ascendente y
 * sin duplicados. El formato ya lo validó `renewalUpcomingQuerySchema`
 * (regex `^\d+(,\d+)*$`) -- aquí solo falta el límite de CANTIDAD (mismo
 * tope de 10 que `renewalScanRequestSchema`, R6-14) que un regex de formato
 * no puede expresar.
 */
function parseThresholdsCsv(csv: string | undefined): number[] {
  // Bug real (ronda 8): sin este `.sort`, el caso por defecto devolvía
  // `DEFAULT_RENEWAL_LEAD_DAYS` tal cual está declarado -- [90, 60, 30],
  // DESCENDENTE -- rompiendo la garantía documentada arriba ("ascendente")
  // y el contrato de `renewalUpcomingResponseSchema.thresholds` que el resto
  // de esta función sí cumple (ver el `.sort` de la rama con CSV, abajo).
  if (!csv) return [...DEFAULT_RENEWAL_LEAD_DAYS].sort((a, b) => a - b);
  const values = [...new Set(csv.split(',').map((v) => Number.parseInt(v, 10)))];
  if (values.length === 0 || values.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new ValidationAppError({ thresholds: 'debe ser una lista de enteros positivos separados por comas' });
  }
  if (values.length > 10) {
    throw new ValidationAppError({ thresholds: 'admite hasta 10 umbrales distintos' });
  }
  return values.sort((a, b) => a - b);
}

interface ContractPageRow {
  contract_id: string;
  tender_id: string;
  end_date: string | Date;
  contracting_body: string | null;
  title: string;
}

interface ScanPageResult {
  evaluatedContracts: number;
  alertsCreated: number;
  lastContractId: string | null;
  hasMore: boolean;
}

/**
 * Procesa UNA página de contratos (hasta `pageSize`, ordenados por `id`
 * ascendente a partir de `cursor` exclusivo) de forma completamente
 * batcheada: sin ninguna consulta ni inserción por alerta individual.
 */
async function scanContractsPage(
  tx: DbExecutor,
  orgId: string,
  cursor: string | null,
  pageSize: number,
  leadDaysThresholds: readonly number[],
  todayIsoDate: string,
  correlationId: string | null | undefined
): Promise<ScanPageResult> {
  const contractsRes = await tx.query<ContractPageRow>(
    `select c.id as contract_id, c.tender_id, c.end_date, t.contracting_body, t.title
       from contracts c join tenders t on t.id = c.tender_id and t.org_id = c.org_id
      where c.org_id = $1 and c.end_date is not null and c.status not in ('cerrado', 'rescindido')
        and ($2::uuid is null or c.id > $2)
      order by c.id asc
      limit $3`,
    [orgId, cursor, pageSize]
  );
  if (contractsRes.rows.length === 0) {
    return { evaluatedContracts: 0, alertsCreated: 0, lastContractId: null, hasMore: false };
  }

  const contractById = new Map(contractsRes.rows.map((r) => [r.contract_id, r]));
  const candidates: RenewalCandidateContract[] = contractsRes.rows
    .map((r) => ({ contractId: r.contract_id, tenderId: r.tender_id, endDate: toDateOnlyString(r.end_date) as string }))
    .filter((c) => c.endDate !== null);

  const alertCandidates = computeRenewalAlertCandidates(candidates, todayIsoDate, leadDaysThresholds);

  let alertsCreated = 0;
  if (alertCandidates.length > 0) {
    // Dedupe EN LOTE: una sola consulta para toda la página (nunca una por
    // alerta) -- el índice único parcial (org_id, contract_id, lead_days)
    // sigue siendo el resguardo final ante una condición de carrera, pero
    // ya no se depende de capturar la excepción caso por caso.
    const contractIdsInPage = [...new Set(alertCandidates.map((a) => a.contractId))];
    const existingRes = await tx.query<{ contract_id: string; lead_days: number }>(
      'select contract_id, lead_days from renewal_alerts where org_id = $1 and contract_id = any($2::uuid[])',
      [orgId, contractIdsInPage]
    );
    const existingSet = new Set(existingRes.rows.map((r) => `${r.contract_id}:${r.lead_days}`));
    const newAlerts = alertCandidates.filter((a) => !existingSet.has(`${a.contractId}:${a.leadDays}`));

    if (newAlerts.length > 0) {
      // Convocatorias históricas EN LOTE: una sola consulta con ventana
      // `row_number()` particionada por `contracting_body`, para TODAS las
      // entidades presentes en esta página a la vez (nunca una consulta
      // por alerta). Se piden `MAX_HISTORICAL_TENDERS + 1` por entidad --
      // suficiente margen para excluir, en memoria, la propia convocatoria
      // de cada alerta (`id <> alert.tenderId`) sin perder ningún resultado
      // real: si la propia convocatoria cae dentro de ese margen, excluirla
      // y recortar a `MAX_HISTORICAL_TENDERS` da EXACTAMENTE el mismo
      // resultado que excluirla primero y ordenar después (equivalente
      // matemático de la consulta por-alerta original); si no cae dentro
      // del margen, tampoco habría sido excluida por la consulta original.
      const contractingBodies = [...new Set(newAlerts.map((a) => contractById.get(a.contractId)?.contracting_body).filter((b): b is string => Boolean(b)))];
      const historicalByBody = new Map<string, { id: string; title: string }[]>();
      if (contractingBodies.length > 0) {
        const histRes = await tx.query<{ id: string; title: string; contracting_body: string }>(
          `select id, title, contracting_body from (
             select id, title, contracting_body,
                    row_number() over (partition by contracting_body order by published_at desc nulls last) as rn
               from tenders
              where org_id = $1 and contracting_body = any($2::text[])
           ) ranked
           where rn <= $3`,
          [orgId, contractingBodies, MAX_HISTORICAL_TENDERS + 1]
        );
        for (const row of histRes.rows) {
          const list = historicalByBody.get(row.contracting_body) ?? [];
          list.push({ id: row.id, title: row.title });
          historicalByBody.set(row.contracting_body, list);
        }
      }

      const jobIds: string[] = [];
      const jobPayloads: string[] = [];
      const alertIds: string[] = [];
      const alertContractIds: string[] = [];
      const alertTenderIds: string[] = [];
      const alertPredictedDates: string[] = [];
      const alertLeadDays: number[] = [];
      const alertConfidences: number[] = [];
      const alertNotes: string[] = [];

      for (const alert of newAlerts) {
        const contractRow = contractById.get(alert.contractId)!;
        const body = contractRow.contracting_body;
        const historical = (body ? (historicalByBody.get(body) ?? []) : []).filter((h) => h.id !== alert.tenderId).slice(0, MAX_HISTORICAL_TENDERS);
        const notes =
          historical.length > 0
            ? `Contrato con vigencia hasta ${alert.predictedDate} (entidad: ${body ?? NO_ENTITY_LABEL}). Convocatorias históricas de la misma entidad en esta organización: ${historical.map((h) => h.title).join('; ')}.`
            : `Contrato con vigencia hasta ${alert.predictedDate} (entidad: ${body ?? NO_ENTITY_LABEL}). Sin convocatorias históricas de la misma entidad registradas en esta organización.`;

        const jobId = randomUUID();
        jobIds.push(jobId);
        jobPayloads.push(JSON.stringify({ contractId: alert.contractId, tenderId: alert.tenderId, leadDays: alert.leadDays, predictedDate: alert.predictedDate }));

        alertIds.push(randomUUID());
        alertContractIds.push(alert.contractId);
        alertTenderIds.push(alert.tenderId);
        alertPredictedDates.push(alert.predictedDate);
        alertLeadDays.push(alert.leadDays);
        alertConfidences.push(alert.confidence);
        alertNotes.push(notes);
      }

      // INSERT en lote (jobs): una sola sentencia para toda la página.
      await tx.query(
        `insert into jobs (id, org_id, kind, payload, status, next_run_at, correlation_id)
         select j.id, $1, 'renewal_radar_alert', j.payload::jsonb, 'queued', now(), $2
           from unnest($3::uuid[], $4::text[]) as j(id, payload)`,
        [orgId, correlationId ?? null, jobIds, jobPayloads]
      );

      // INSERT en lote (renewal_alerts): idem, ligado 1:1 por posición a jobIds.
      await tx.query(
        `insert into renewal_alerts (id, org_id, contract_id, tender_id, source_kind, predicted_date, lead_days, confidence, notes, job_id)
         select a.id, $1, a.contract_id, a.tender_id, 'contract_end_date', a.predicted_date::date, a.lead_days, a.confidence, a.notes, a.job_id
           from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::date[], $6::int[], $7::numeric[], $8::text[], $9::uuid[])
                  as a(id, contract_id, tender_id, predicted_date, lead_days, confidence, notes, job_id)`,
        [orgId, alertIds, alertContractIds, alertTenderIds, alertPredictedDates, alertLeadDays, alertConfidences, alertNotes, jobIds]
      );

      alertsCreated = newAlerts.length;
    }
  }

  const lastRow = contractsRes.rows[contractsRes.rows.length - 1];
  return {
    evaluatedContracts: candidates.length,
    alertsCreated,
    lastContractId: lastRow.contract_id,
    hasMore: contractsRes.rows.length === pageSize,
  };
}

export async function expedienteRenewalRadarRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/renewals/scan',
    { preHandler: [app.authenticate, app.requireOrg], schema: { body: renewalScanRequestSchema, response: { 200: renewalRadarRunSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para escanear renovaciones');

      const runId = randomUUID();
      const today = new Date().toISOString().slice(0, 10);
      const startedAt = Date.now();
      const { leadDaysThresholds, pageSize, maxDurationMs } = request.body;
      let cursor: string | null = request.body.cursor ?? null;

      const result = await withTx(app.db, orgId, userId, async (tx) => {
        let evaluatedContracts = 0;
        let alertsCreated = 0;
        let truncated = false;
        let nextCursor: string | null = null;

        // Paginación por cursor (keyset sobre contracts.id): cada iteración
        // procesa UNA página completa de forma batcheada (ver
        // `scanContractsPage`); nunca carga/recorre todos los contratos de
        // la organización sin límite en una sola pasada.
        for (;;) {
          const page = await scanContractsPage(tx, orgId, cursor, pageSize, leadDaysThresholds, today, request.correlationId);
          evaluatedContracts += page.evaluatedContracts;
          alertsCreated += page.alertsCreated;

          if (page.lastContractId === null) {
            // Página vacía: no quedan más contratos por evaluar.
            nextCursor = null;
            break;
          }
          cursor = page.lastContractId;

          if (!page.hasMore) {
            // Última página real (menos filas que pageSize).
            nextCursor = null;
            break;
          }

          if (Date.now() - startedAt > maxDurationMs) {
            // Límite de tiempo por request: se detiene ANTES de pedir la
            // siguiente página -- el llamador reintenta con `cursor:
            // nextCursor` para continuar exactamente donde se quedó.
            truncated = true;
            nextCursor = cursor;
            break;
          }
        }

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'renewal_radar.scan',
          entity: 'renewal_alerts',
          entityId: runId,
          after: { evaluatedContracts, alertsCreated, leadDaysThresholds, truncated, cursor: request.body.cursor ?? null, nextCursor },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { alertsCreated, evaluatedContracts, truncated, nextCursor };
      });

      return { runId, ...result };
    }
  );

  // R6-03: encola el escaneo como un job en vez de ejecutarlo de forma
  // síncrona en esta petición -- ver docstring del módulo (ningún
  // consumidor en apps/worker todavía para este `kind` en esta ronda).
  server.post(
    '/renewals/scan/enqueue',
    { preHandler: [app.authenticate, app.requireOrg], schema: { body: renewalScanEnqueueRequestSchema, response: { 202: renewalScanEnqueueResponseSchema } } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para escanear renovaciones');

      const jobId = await withTx(app.db, orgId, userId, async (tx) => {
        const id = randomUUID();
        // `progress` es el contrato de datos que un futuro worker debe
        // mantener actualizado entre página y página (cursor/contadores) --
        // se inicializa aquí en `done:false` para que cualquier consumidor
        // futuro sepa exactamente desde dónde continuar sin volver a
        // procesar contratos ya evaluados.
        await tx.query(
          `insert into jobs (id, org_id, kind, payload, status, next_run_at, correlation_id)
           values ($1, $2, 'renewal_radar_scan', $3::jsonb, 'queued', now(), $4)`,
          [
            id,
            orgId,
            JSON.stringify({
              leadDaysThresholds: request.body.leadDaysThresholds,
              pageSize: request.body.pageSize,
              progress: { cursor: null, evaluatedContracts: 0, alertsCreated: 0, done: false },
            }),
            request.correlationId ?? null,
          ]
        );
        await recordAudit(tx, {
          orgId, actorId: userId, action: 'renewal_radar.scan_enqueued', entity: 'jobs', entityId: id,
          after: { leadDaysThresholds: request.body.leadDaysThresholds, pageSize: request.body.pageSize },
          requestId: request.id, correlationId: request.correlationId,
        });
        return id;
      });

      reply.code(202);
      return { jobId, status: 'queued' as const };
    }
  );

  // R6-12 (docs/auditoria-2/api-ronda6-reverificacion.md, MEDIA): esta ruta
  // hacía `select * ... order by predicted_date asc` SIN `limit` -- el
  // reverificador midió 60,000 alertas / 32,4 MB en una sola respuesta tras
  // un escaneo de 20,000 contratos, el mismo antipatrón que R6-03 ya había
  // eliminado del lado de escritura del radar. Se pagina con el mismo
  // patrón keyset ya usado en `GET /organizations/:orgId/memberships`
  // (`lib/cursor.ts`): `(predicted_date, id)` como par ordenado/tiebreaker
  // (único, a diferencia de `predicted_date` solo), columnas explícitas en
  // vez de `select *`, `limit`/`cursor` de entrada y `nextCursor` de salida.
  server.get(
    '/renewals/alerts',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { querystring: renewalAlertsListQuerySchema, response: { 200: renewalAlertsListResponseSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { cursor, limit } = request.query;
      const pageSize = parsePageSize(limit, 100, 1000);
      const decoded = cursor ? decodeCursor(cursor) : null;

      const conditions: string[] = ['org_id = $1'];
      const params: unknown[] = [orgId];
      if (decoded) {
        params.push(decoded.sortKey, decoded.id);
        conditions.push(`(predicted_date, id) > ($${params.length - 1}::date, $${params.length}::uuid)`);
      }
      params.push(pageSize + 1);

      const rows = await withTx(app.db, orgId, request.userId, async (tx) =>
        (
          await tx.query<Record<string, unknown>>(
            `select id, org_id, contract_id, tender_id, source_kind, predicted_date, lead_days, confidence, notes, job_id, status, created_at
               from renewal_alerts
              where ${conditions.join(' and ')}
              order by predicted_date asc, id asc
              limit $${params.length}`,
            params
          )
        ).rows
      );

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const last = page[page.length - 1] as Record<string, unknown> | undefined;
      const nextCursor = hasMore && last ? encodeCursor(toIsoString(last.predicted_date), String(last.id)) : null;

      return { items: page.map(mapAlertRow), nextCursor };
    }
  );

  // ---------------------------------------------------------------------------
  // REQ-055 (ronda 8) -- el "cliente concreto" que exige el requisito: "mis
  // renovaciones próximas" agrupadas por urgencia, para consumo directo de
  // un cliente de negocio (no requiere haber corrido antes `POST
  // /renewals/scan`; calcula en vivo, de solo lectura, SIN persistir nada
  // ni encolar jobs -- ese sigue siendo el trabajo de `/renewals/scan`).
  //
  // Los tres umbrales (90/60/30 por defecto, configurables) se calculan
  // SIMULTÁNEA y EXPLÍCITAMENTE: un mismo contrato puede aparecer en más de
  // un grupo de urgencia a la vez (p. ej. a 20 días del vencimiento aparece
  // en 'urgente'/30, 'proxima'/60 Y 'seguimiento'/90) -- nunca se colapsa a
  // un solo nivel "el más cercano gana", porque cada umbral cruzado es una
  // obligación de negocio distinta (a 90 días: empezar a decidir renovar o
  // convocar; a 60: preparar documentación; a 30: ya urgente). Semántica
  // verificada en `test/expediente-renewal-radar.test.ts`.
  //
  // Acotado (sin paginación por cursor, a diferencia de `GET
  // /renewals/alerts`): evalúa hasta `limit` contratos (por defecto 200,
  // techo 2000 -- mismo orden de magnitud que `pageSize` de `/renewals/scan`),
  // ordenados por `end_date` ascendente (los más próximos a vencer primero),
  // así que un límite bajo nunca oculta el contrato más urgente. `truncated`
  // indica honestamente si había más contratos con `end_date` futura sin
  // evaluar.
  server.get(
    '/renewals/upcoming',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { querystring: renewalUpcomingQuerySchema, response: { 200: renewalUpcomingResponseSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const thresholds = parseThresholdsCsv(request.query.thresholds);
      const limit = parsePageSize(request.query.limit, 200, 2000);
      const today = new Date().toISOString().slice(0, 10);

      const rows = await withTx(app.db, orgId, request.userId, async (tx) =>
        (
          await tx.query<ContractPageRow & { contract_number: string | null; has_renewal_option: boolean; renewal_option_notes: string | null }>(
            `select c.id as contract_id, c.tender_id, c.end_date, c.contract_number, c.has_renewal_option, c.renewal_option_notes,
                    t.contracting_body, t.title
               from contracts c join tenders t on t.id = c.tender_id and t.org_id = c.org_id
              where c.org_id = $1 and c.end_date is not null and c.end_date >= current_date
                and c.status not in ('cerrado', 'rescindido')
              order by c.end_date asc
              limit $2`,
            [orgId, limit + 1]
          )
        ).rows
      );

      const truncated = rows.length > limit;
      const page = truncated ? rows.slice(0, limit) : rows;
      const contractById = new Map(page.map((r) => [r.contract_id, r]));
      const candidates: RenewalCandidateContract[] = page
        .map((r) => ({ contractId: r.contract_id, tenderId: r.tender_id, endDate: toDateOnlyString(r.end_date) as string }))
        .filter((c) => c.endDate !== null);

      const upcoming = computeUpcomingRenewals(candidates, today, thresholds);

      const groups = thresholds.map((leadDays) => {
        const items = upcoming
          .filter((u) => u.leadDays === leadDays)
          .sort((a, b) => a.daysUntilEnd - b.daysUntilEnd)
          .map((u) => {
            const row = contractById.get(u.contractId)!;
            return {
              contractId: u.contractId,
              tenderId: u.tenderId,
              tenderTitle: row.title,
              contractingBody: row.contracting_body,
              contractNumber: row.contract_number,
              hasRenewalOption: row.has_renewal_option,
              renewalOptionNotes: row.renewal_option_notes,
              endDate: u.predictedDate,
              daysUntilEnd: u.daysUntilEnd,
              leadDays: u.leadDays,
              confidence: u.confidence,
            };
          });
        // `thresholds` ya viene ascendente (`parseThresholdsCsv`) -- se
        // recalcula la urgencia aquí (en vez de leerla de `upcoming`, que
        // puede no tener NINGÚN elemento para este `leadDays` si ningún
        // contrato lo cruzó todavía) para que el grupo SIEMPRE aparezca,
        // vacío o no, con su etiqueta correcta.
        const urgency = urgencyForLeadDays(leadDays, thresholds);
        return { urgency, leadDays, items };
      });

      return {
        asOfDate: today,
        thresholds,
        totalContractsEvaluated: page.length,
        truncated,
        groups,
      };
    }
  );
}
