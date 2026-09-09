import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient, DbExecutor } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';
import { computeUpcomingRenewals, urgencyForLeadDays } from '../src/lib/expediente/renewal-radar.js';

/**
 * REQ-055 — radar de renovaciones: a partir de contratos con fecha de fin y
 * de convocatorias históricas de la misma entidad, genera alertas de
 * renovación probable con antelación configurable; jobs en `jobs`, sin
 * envío externo.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string, contractingEntity = 'Secretaría de Ejemplo'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: `Convocatoria ${externalId}`, contractingEntity, sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * R6-09 (corrección de la corrección R6-03): instrumenta el cliente de base
 * de datos que comparte la app de prueba para contar cuántas sentencias SQL
 * se ejecutan dentro de las transacciones mientras dura una operación. Es la
 * forma DETERMINISTA de comprobar la ausencia de un patrón N+1, en vez de un
 * umbral de milisegundos que depende de la carga de la máquina y de cuántos
 * archivos de test corren en paralelo.
 *
 * R6-09 (docs/auditoria-2/api-ronda6-reverificacion.md, "criterio
 * trivialmente satisfacible"): el reverificador demostró que el criterio
 * ORIGINAL (`scanQueries < 100`) lo satisface igual de bien una
 * implementación degradada que quita `limit`/`pageSize` y trae TODOS los
 * contratos en una sola consulta (12 sentencias en total, muy por debajo
 * de 100) -- lo que atrapaba esa regresión no era este criterio sino el
 * test VECINO de paginación por cursor. Se añade `matchSql`: además del
 * TOTAL de sentencias, cuenta cuántas veces se ejecutó específicamente la
 * consulta que trae UNA PÁGINA de contratos -- una implementación sin
 * límite ejecuta esa consulta una sola vez sin importar cuántos contratos
 * haya, mientras que la paginación real la ejecuta `ceil(contratos /
 * pageSize)` veces. Este conteo, no el total de sentencias, es el que
 * distingue "paginado de verdad" de "una sola consulta sin límite".
 */
function countTxQueries(db: DbClient, opts: { matchSql?: RegExp } = {}): { stop: () => { total: number; matching: number } } {
  const originalTransaction = db.transaction.bind(db);
  let total = 0;
  let matching = 0;
  db.transaction = (async <T,>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> =>
    originalTransaction(async (tx: DbExecutor) => {
      const originalQuery = tx.query.bind(tx);
      const counting: DbExecutor = {
        ...tx,
        query: (async (sql: string, params?: unknown[]) => {
          total += 1;
          if (opts.matchSql?.test(sql)) matching += 1;
          return originalQuery(sql, params);
        }) as DbExecutor['query'],
      };
      return fn(counting);
    })) as DbClient['transaction'];
  return {
    stop() {
      db.transaction = originalTransaction;
      return { total, matching };
    },
  };
}

/** R6-09: patrón único de la consulta de UNA página de contratos en `scanContractsPage` (`renewal-radar.routes.ts`) -- contar sus ejecuciones es contar páginas realmente recorridas. */
const CONTRACT_PAGE_QUERY_PATTERN = /from contracts c join tenders t/;

/**
 * REQ-055 (ronda 8) -- `computeUpcomingRenewals`/`urgencyForLeadDays`
 * (`lib/expediente/renewal-radar.ts`), la lógica pura que consume `GET
 * /renewals/upcoming`: los tres umbrales 90/60/30 se calculan de forma
 * SIMULTÁNEA y EXPLÍCITA (un contrato puede caer en varios grupos de
 * urgencia a la vez, o solo en el más cercano si todavía no cruzó los
 * otros dos) -- sin tocar base de datos, así que las fechas límite se
 * verifican exactas con precisión de un día.
 */
describe('lib/expediente/renewal-radar — computeUpcomingRenewals/urgencyForLeadDays (REQ-055, ronda 8)', () => {
  const TODAY = '2026-01-01';

  it('urgencyForLeadDays: el umbral más pequeño es "urgente", el más grande "seguimiento", cualquiera intermedio "proxima"', () => {
    const sorted = [30, 60, 90];
    expect(urgencyForLeadDays(30, sorted)).toBe('urgente');
    expect(urgencyForLeadDays(60, sorted)).toBe('proxima');
    expect(urgencyForLeadDays(90, sorted)).toBe('seguimiento');
    // Un único umbral configurado: no hay "más"/"menos" urgente que comparar -- 'urgente' por definición.
    expect(urgencyForLeadDays(45, [45])).toBe('urgente');
  });

  // Semántica cumulativa (documentada arriba y en `renewal-radar.routes.ts`):
  // un umbral se cruza cuando `daysUntilEnd <= leadDays`, así que un
  // contrato SIEMPRE cruza también todo umbral MAYOR al más pequeño que ya
  // cruzó (a exactamente 30 días cruza 30, 60 Y 90 -- nunca "solo 30"; ver
  // el test de "20 días" más abajo, que ya cubre ese caso). Estos casos de
  // borde verifican, umbral por umbral, la fecha límite EXACTA: el día
  // exacto del umbral ya cuenta ("<=", no "<"), un día antes NO cruza ESE
  // umbral concreto (pero sigue cruzando cualquiera mayor), un día después
  // ya lo cruzó desde antes.
  it.each([
    [90, [90]],
    [60, [60, 90]],
    [30, [30, 60, 90]],
  ] as const)('un contrato a exactamente %i días de vencer cruza justo los umbrales <= %i (%j), nunca uno menor que todavía no le toca', (exactDays, expectedLeadDays) => {
    const endDate = new Date(`${TODAY}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() + exactDays);
    const contract = { contractId: 'c1', tenderId: 't1', endDate: endDate.toISOString().slice(0, 10) };
    const at = computeUpcomingRenewals([contract], TODAY, [90, 60, 30]);
    expect(at.map((c) => c.leadDays).sort((a, b) => a - b)).toEqual([...expectedLeadDays]);
    expect(at.every((c) => c.daysUntilEnd === exactDays)).toBe(true);
  });

  it.each([90, 60, 30] as const)('un contrato a exactamente %i + 1 días de vencer (un día antes de cruzar ese umbral) todavía NO lo cruza, sin margen de un día', (threshold) => {
    const endDate = new Date(`${TODAY}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() + threshold + 1);
    const contract = { contractId: 'c1', tenderId: 't1', endDate: endDate.toISOString().slice(0, 10) };
    const at = computeUpcomingRenewals([contract], TODAY, [90, 60, 30]);
    expect(at.map((c) => c.leadDays)).not.toContain(threshold);
  });

  it.each([90, 60, 30] as const)('un contrato a exactamente %i - 1 días de vencer (un día después de cruzar ese umbral) ya lo cruzó desde antes', (threshold) => {
    const endDate = new Date(`${TODAY}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() + threshold - 1);
    const contract = { contractId: 'c1', tenderId: 't1', endDate: endDate.toISOString().slice(0, 10) };
    const at = computeUpcomingRenewals([contract], TODAY, [90, 60, 30]);
    expect(at.map((c) => c.leadDays)).toContain(threshold);
  });

  it('un contrato a 20 días de vencer cruza los TRES umbrales por defecto SIMULTÁNEAMENTE -- aparece una vez por cada uno, con la urgencia correcta en cada caso, nunca colapsado al más cercano', () => {
    const contract = { contractId: 'c1', tenderId: 't1', endDate: '2026-01-21' }; // 20 días desde TODAY.
    const upcoming = computeUpcomingRenewals([contract], TODAY);

    expect(upcoming).toHaveLength(3);
    const byLeadDays = new Map(upcoming.map((u) => [u.leadDays, u]));
    expect([...byLeadDays.keys()].sort((a, b) => a - b)).toEqual([30, 60, 90]);
    for (const u of upcoming) {
      expect(u.daysUntilEnd).toBe(20); // MISMO contrato, MISMA fecha de fin -- daysUntilEnd es igual en los tres grupos.
      expect(u.contractId).toBe('c1');
    }
    expect(byLeadDays.get(30)!.urgency).toBe('urgente');
    expect(byLeadDays.get(60)!.urgency).toBe('proxima');
    expect(byLeadDays.get(90)!.urgency).toBe('seguimiento');
  });

  it('un contrato a 45 días de vencer cruza SOLO 60 y 90 -- 30 todavía no, de forma independiente (no "el más cercano gana")', () => {
    const contract = { contractId: 'c1', tenderId: 't1', endDate: '2026-02-15' }; // 45 días desde TODAY.
    const upcoming = computeUpcomingRenewals([contract], TODAY);
    expect(upcoming.map((u) => u.leadDays).sort((a, b) => a - b)).toEqual([60, 90]);
    expect(upcoming.every((u) => u.daysUntilEnd === 45)).toBe(true);
  });

  it('un contrato ya vencido no aparece en ningún grupo (fuera de alcance de "próxima" renovación)', () => {
    const contract = { contractId: 'c1', tenderId: 't1', endDate: '2025-12-31' }; // 1 día antes de TODAY.
    expect(computeUpcomingRenewals([contract], TODAY)).toEqual([]);
  });

  it('varios contratos con distinta antelación se clasifican cada uno de forma independiente en el mismo cálculo', () => {
    const contracts = [
      { contractId: 'urgente-20d', tenderId: 't1', endDate: '2026-01-21' }, // 20 días -> 90/60/30.
      { contractId: 'medio-45d', tenderId: 't2', endDate: '2026-02-15' }, // 45 días -> 90/60.
      { contractId: 'lejano-80d', tenderId: 't3', endDate: '2026-03-22' }, // 80 días -> 90.
      { contractId: 'fuera-100d', tenderId: 't4', endDate: '2026-04-11' }, // 100 días -> ninguno.
    ];
    const upcoming = computeUpcomingRenewals(contracts, TODAY);
    const contractIdsByThreshold = (leadDays: number) =>
      upcoming.filter((u) => u.leadDays === leadDays).map((u) => u.contractId).sort();

    expect(contractIdsByThreshold(30)).toEqual(['urgente-20d']);
    expect(contractIdsByThreshold(60)).toEqual(['medio-45d', 'urgente-20d']);
    expect(contractIdsByThreshold(90)).toEqual(['lejano-80d', 'medio-45d', 'urgente-20d']);
    expect(upcoming.some((u) => u.contractId === 'fuera-100d')).toBe(false);
  });
});

describe('expediente — radar de renovaciones (REQ-055)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('genera una alerta cuando un contrato entra dentro del umbral de antelación configurado, encola un job, y no la duplica en un segundo escaneo', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 1', 'c055-org-1');
    const tenderId = await createTender(app, org.id, 'c055-001');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 45); // ya cruzó los umbrales de 60 y 90 (retroactivo, primer escaneo); el de 30 todavía no.
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: toDateOnly(soon) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().evaluatedContracts).toBe(1);
    expect(scan.json().alertsCreated).toBe(2); // umbrales 60 y 90 cumplidos; 30 todavía no (45 > 30).

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    expect(alerts.statusCode).toBe(200);
    const alertRows = alerts.json().items;
    expect(alertRows.map((a: any) => a.leadDays).sort((a: number, b: number) => a - b)).toEqual([60, 90]);
    for (const a of alertRows) {
      expect(a.sourceKind).toBe('contract_end_date');
      expect(a.jobId).toBeTruthy();
    }

    const jobs = await db.query("select kind, status from jobs where org_id = $1 and kind = 'renewal_radar_alert'", [org.id]);
    expect(jobs.rows.length).toBe(alertRows.length);

    // Segundo escaneo: mismos umbrales ya cumplidos -> no duplica alertas.
    const secondScan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(secondScan.json().alertsCreated).toBe(0);
    const alertsAfter = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    expect(alertsAfter.json().items.length).toBe(alertRows.length);
  });

  it('90/60/30: un contrato a 20 días de vencer cruza los tres umbrales por defecto en un solo escaneo', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 2', 'c055-org-2');
    const tenderId = await createTender(app, org.id, 'c055-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 20);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: toDateOnly(soon) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(scan.json().alertsCreated).toBe(3);

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    const leadDays = alerts.json().items.map((a: any) => a.leadDays).sort((a: number, b: number) => a - b);
    expect(leadDays).toEqual([30, 60, 90]);
  });

  it('enriquece la alerta con convocatorias históricas de la misma entidad cuando existen', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 3', 'c055-org-3');
    await createTender(app, org.id, 'c055-hist-1', 'Secretaría Compartida');
    const currentTenderId = await createTender(app, org.id, 'c055-003', 'Secretaría Compartida');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${currentTenderId}/contract`, headers });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 10);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${currentTenderId}/contract`, headers, payload: { endDate: toDateOnly(soon) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: { leadDaysThresholds: [30] } });
    expect(scan.json().alertsCreated).toBe(1);

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    const alert = alerts.json().items[0];
    expect(alert.notes).toContain('Convocatoria c055-hist-1');
  });

  it('un contrato ya vencido no genera alerta (fuera de alcance del radar de "próxima" renovación)', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 4', 'c055-org-4');
    const tenderId = await createTender(app, org.id, 'c055-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });

    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 5);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: toDateOnly(past) } });

    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    expect(scan.json().alertsCreated).toBe(0);
  });

  it('R6-03: 5,000 contratos (15,000 alertas candidatas) se escanean con un numero de consultas O(paginas), no O(alertas) -- sin N+1, en lote y paginado por cursor', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 6', 'c055-org-6');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // Siembra directa (bulk, una sola sentencia con dos CTE encadenados) --
    // 5,000 convocatorias repartidas en 50 `contracting_body` distintos
    // (para ejercitar de verdad el agrupamiento de convocatorias históricas
    // en lote) + 5,000 contratos, todos con `end_date` a 20 días -- cruza
    // los 3 umbrales por defecto (90/60/30) => 15,000 alertas candidatas,
    // igual que la medición original de la auditoría (R6-03).
    await db.query(
      `with new_tenders as (
         insert into tenders (org_id, source, external_id, title, contracting_body, published_at)
         select $1, 'perf-test', 'perf-' || gs, 'Contrato de prueba ' || gs, 'Entidad ' || (gs % 50), now() - (gs || ' days')::interval
           from generate_series(1, 5000) as gs
         returning id
       )
       insert into contracts (org_id, tender_id, status, end_date)
       select $1, id, 'adjudicado', current_date + 20
         from new_tenders`,
      [org.id]
    );

    // R6-09: el criterio de aceptación de R6-03 es ESTRUCTURAL (ausencia de
    // N+1), no un umbral de reloj de pared: contamos las sentencias SQL que
    // el handler ejecuta dentro de su transacción. Con el N+1 original eran
    // ~4 por alerta (~60,000 para 15,000 alertas); en lote deben ser O(número
    // de páginas) -- 5,000 contratos / pageSize por defecto 2,000 = 3
    // páginas x ~5 consultas + contexto de tenant y auditoría. Un umbral de
    // milisegundos aquí era no determinista (esta suite corre en paralelo con
    // otros archivos: se midió 1.1s aislado y 2.9s bajo carga completa) --
    // exactamente el tipo de test intermitente que esta ronda vino a eliminar.
    const queriesDuringScan = countTxQueries(db, { matchSql: CONTRACT_PAGE_QUERY_PATTERN });
    const startedAt = Date.now();
    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    const elapsedMs = Date.now() - startedAt;
    const { total: scanQueries, matching: pagesScanned } = queriesDuringScan.stop();
    console.log(`R6-03 perf: 5000 contratos, primer escaneo=${elapsedMs}ms, consultas SQL=${scanQueries}, paginas=${pagesScanned}`);

    expect(scan.statusCode).toBe(200);
    expect(scan.json().evaluatedContracts).toBe(5000);
    expect(scan.json().alertsCreated).toBe(15000);
    expect(scan.json().truncated).toBe(false);
    expect(scan.json().nextCursor).toBeNull();
    // O(páginas), no O(alertas): con N+1 serían decenas de miles.
    // NO se asserta `elapsedMs`: esta máquina ejecuta varios agentes y
    // suites en paralelo y el mismo escaneo se midió entre 1.2s y 10.0s
    // según la carga. El tiempo se imprime como dato, nunca como criterio.
    expect(scanQueries).toBeLessThan(100);
    // R6-09/R6-14: el total de sentencias NO basta -- una implementación
    // que quite `limit`/`pageSize` y traiga TODOS los contratos en una
    // sola consulta también pasa `scanQueries < 100` (12 sentencias,
    // medido por el reverificador). Lo que sí la distingue: con
    // `pageSize` por defecto (2,000) y 5,000 contratos, la paginación real
    // ejecuta la consulta de página EXACTAMENTE `ceil(5000/2000) = 3`
    // veces -- una implementación sin límite la ejecuta 1 sola vez sin
    // importar cuántos contratos haya.
    expect(pagesScanned).toBe(3);

    // Segundo escaneo (dedupe en lote, no una consulta por alerta): mismo
    // criterio estructural, y no duplica ninguna alerta.
    const queriesDuringSecondScan = countTxQueries(db, { matchSql: CONTRACT_PAGE_QUERY_PATTERN });
    const startedAt2 = Date.now();
    const secondScan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: {} });
    const elapsedMs2 = Date.now() - startedAt2;
    const { total: secondScanQueries, matching: secondPagesScanned } = queriesDuringSecondScan.stop();
    console.log(`R6-03 perf: 5000 contratos, segundo escaneo (dedupe)=${elapsedMs2}ms, consultas SQL=${secondScanQueries}, paginas=${secondPagesScanned}`);
    expect(secondScan.json().alertsCreated).toBe(0);
    expect(secondScanQueries).toBeLessThan(100);
    expect(secondPagesScanned).toBe(3);

    const totalAlerts = await db.query<{ count: string }>('select count(*)::text as count from renewal_alerts where org_id = $1', [org.id]);
    expect(Number(totalAlerts.rows[0].count)).toBe(15000);
    // Timeout holgado (no es un criterio de rendimiento, es un tope para
    // que la carga de la máquina no mate el test): siembra de 5,000
    // contratos + dos escaneos completos.
  }, 180_000);

  it('R6-03: paginación por cursor -- un pageSize pequeño produce varias páginas y `nextCursor` retoma exactamente donde se quedó, sin perder ni duplicar contratos', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 7', 'c055-org-7');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await db.query(
      `with new_tenders as (
         insert into tenders (org_id, source, external_id, title, contracting_body, published_at)
         select $1, 'perf-test', 'perf-' || gs, 'Contrato de prueba ' || gs, 'Entidad ' || gs, now()
           from generate_series(1, 25) as gs
         returning id
       )
       insert into contracts (org_id, tender_id, status, end_date)
       select $1, id, 'adjudicado', current_date + 20
         from new_tenders`,
      [org.id]
    );

    // pageSize=10 sobre 25 contratos, con un `maxDurationMs` mínimo (1ms)
    // para forzar `truncated:true` tras CADA página que no sea la última
    // (la última página, con menos filas que pageSize, siempre completa
    // sin importar el límite de tiempo -- ver `scanContractsPage`): 3
    // llamadas (10 + 10 + 5 contratos), cada una retomando exactamente
    // donde se quedó la anterior vía `nextCursor`, sin perder ni duplicar
    // ningún contrato.
    let cursor: string | null = null;
    let totalEvaluated = 0;
    let totalAlerts = 0;
    let iterations = 0;
    let lastTruncated = true;
    do {
      const scanCursor: string | null = cursor;
      const scan: Awaited<ReturnType<FastifyInstance['inject']>> = await app.inject({
        method: 'POST',
        url: '/expediente/renewals/scan',
        headers,
        payload: { pageSize: 10, maxDurationMs: 1, cursor: scanCursor },
      });
      expect(scan.statusCode).toBe(200);
      totalEvaluated += scan.json().evaluatedContracts;
      totalAlerts += scan.json().alertsCreated;
      cursor = scan.json().nextCursor;
      lastTruncated = scan.json().truncated;
      iterations += 1;
    } while (cursor !== null && iterations < 10);

    expect(iterations).toBe(3); // 25 contratos / pageSize 10 -> 3 páginas.
    expect(lastTruncated).toBe(false); // la última llamada SÍ termina (nextCursor null).
    expect(totalEvaluated).toBe(25);
    expect(totalAlerts).toBe(75); // 25 contratos x 3 umbrales (90/60/30, todos cruzados a 20 días).

    const distinctAlerts = await db.query<{ count: string }>('select count(*)::text as count from renewal_alerts where org_id = $1', [org.id]);
    expect(Number(distinctAlerts.rows[0].count)).toBe(75); // sin duplicados entre páginas.
  });

  it('R6-03: POST /renewals/scan/enqueue encola un job renewal_radar_scan (opción de ejecutarlo en segundo plano) en vez de escanear de forma síncrona', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-8@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 8', 'c055-org-8');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const enqueue = await app.inject({ method: 'POST', url: '/expediente/renewals/scan/enqueue', headers, payload: { leadDaysThresholds: [45] } });
    expect(enqueue.statusCode).toBe(202);
    expect(enqueue.json().status).toBe('queued');
    const jobId = enqueue.json().jobId;

    const job = await db.query<{ kind: string; status: string; payload: any }>('select kind, status, payload from jobs where id = $1', [jobId]);
    expect(job.rows[0].kind).toBe('renewal_radar_scan');
    expect(job.rows[0].status).toBe('queued');
    expect(job.rows[0].payload.leadDaysThresholds).toEqual([45]);
    expect(job.rows[0].payload.progress).toEqual({ cursor: null, evaluatedContracts: 0, alertsCreated: 0, done: false });

    // No genera NINGUNA alerta todavía -- encolar no es lo mismo que
    // escanear (sin consumidor de este `kind` en apps/worker en esta
    // ronda, ver docstring del módulo).
    const alertsCount = await db.query<{ count: string }>('select count(*)::text as count from renewal_alerts where org_id = $1', [org.id]);
    expect(Number(alertsCount.rows[0].count)).toBe(0);
  });

  /**
   * R6-12 (docs/auditoria-2/api-ronda6-reverificacion.md, MEDIA):
   * `GET /renewals/alerts` no paginaba en absoluto -- una sola consulta
   * `select * ... order by predicted_date asc` sin `limit`. El
   * reverificador midió 60.000 alertas / 32,4 MB en una sola respuesta tras
   * un escaneo de 20.000 contratos. Este caso siembra 1.000 alertas
   * directamente (más rápido que generarlas vía `/renewals/scan`, que no es
   * lo que este test ejercita) y comprueba que el endpoint pagina: por
   * defecto no devuelve las 1.000 de una vez, y recorrer todas las páginas
   * con `nextCursor` reúne exactamente 1.000 sin duplicados ni huecos.
   */
  it('R6-12: GET /renewals/alerts pagina -- 1.000 alertas nunca llegan en una sola respuesta, y el cursor recorre todas sin duplicar ni perder ninguna', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-8@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 8', 'c055-org-8');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await db.query(
      `insert into renewal_alerts (org_id, source_kind, predicted_date, lead_days, confidence, notes, status)
       select $1, 'contract_end_date', current_date + (gs % 90), 90, 0.9, 'alerta de prueba ' || gs, 'queued'
         from generate_series(1, 1000) as gs`,
      [org.id]
    );

    const firstPage = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    // Explícito: nunca las 1.000 de un tirón, y siempre trae `nextCursor`
    // para poder seguir -- la ausencia de límite es justo lo que R6-12
    // denunció.
    expect(Array.isArray(firstBody.items)).toBe(true);
    expect(firstBody.items.length).toBeLessThan(1000);
    expect(firstBody.nextCursor).toBeTruthy();

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let iterations = 0;
    for (;;) {
      iterations += 1;
      expect(iterations).toBeLessThan(50); // cota de seguridad: nunca debería hacer falta tanta paginación para 1,000 filas.
      const url: string = cursor ? `/expediente/renewals/alerts?cursor=${encodeURIComponent(cursor)}` : '/expediente/renewals/alerts';
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode).toBe(200);
      const body: { items: Array<{ id: string }>; nextCursor: string | null } = res.json();
      for (const item of body.items) {
        expect(seenIds.has(item.id)).toBe(false); // sin duplicados entre páginas.
        seenIds.add(item.id);
      }
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(seenIds.size).toBe(1000);
  });

  /**
   * R6-14 (docs/auditoria-2/api-ronda6-reverificacion.md, BAJA):
   * `pageSize` admitía hasta 20,000 -- un llamador legítimo podía pedir una
   * sola página de 20,000 contratos (hasta 60,000 alertas candidatas
   * construidas en memoria, más 8 arreglos paralelos para el `unnest`) en
   * una sola transacción, y el conteo de sentencias de R6-09/R6-03
   * (`scanQueries < 100`) en realidad BAJA al subir `pageSize` -- el
   * criterio premiaba justo lo contrario de lo que quería acotar. Techo
   * bajado a un valor defendible (mismo orden de magnitud que el escaneo
   * de 5,000 contratos ya medido y probado en esta suite, R6-03).
   */
  it('R6-14: pageSize tiene un techo defendible -- ya NO admite 20,000 (60,000 alertas candidatas en memoria en una sola transacción)', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-10@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 10', 'c055-org-10');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const tooLarge = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: { pageSize: 20000 } });
    expect(tooLarge.statusCode).toBe(422);

    const tooLargeEnqueue = await app.inject({ method: 'POST', url: '/expediente/renewals/scan/enqueue', headers, payload: { pageSize: 20000 } });
    expect(tooLargeEnqueue.statusCode).toBe(422);

    // Un pageSize razonable (dentro del nuevo techo) sigue funcionando.
    const withinLimit = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: { pageSize: 5000 } });
    expect(withinLimit.statusCode).toBe(200);
  });

  it('viewer no puede iniciar un escaneo de renovaciones', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 5', 'c055-org-5');
    const viewer = await registerAndLogin(app, 'c055-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const attempt = await app.inject({
      method: 'POST',
      url: '/expediente/renewals/scan',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: {},
    });
    expect(attempt.statusCode).toBe(403);

    const enqueueAttempt = await app.inject({
      method: 'POST',
      url: '/expediente/renewals/scan/enqueue',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: {},
    });
    expect(enqueueAttempt.statusCode).toBe(403);
  });

  it('REQ-055 (ronda 8): PATCH del contrato acepta/persiste hasRenewalOption y renewalOptionNotes de forma independiente de endDate/contractNumber', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-11@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 11', 'c055-org-11');
    const tenderId = await createTender(app, org.id, 'c055-011');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const created = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(created.json().hasRenewalOption).toBe(false); // default -- ningún contrato nace con opción de renovación declarada.
    expect(created.json().renewalOptionNotes).toBeNull();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/contract`,
      headers,
      payload: { hasRenewalOption: true, renewalOptionNotes: 'Cláusula 12: renovable hasta por 1 año más, previa notificación 30 días antes.' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().hasRenewalOption).toBe(true);
    expect(patched.json().renewalOptionNotes).toBe('Cláusula 12: renovable hasta por 1 año más, previa notificación 30 días antes.');
    expect(patched.json().endDate).toBeNull(); // no se tocó -- el update es parcial (mismo patrón que endDate/contractNumber).

    // Un segundo PATCH que solo toca endDate NO borra lo ya guardado de renovación.
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 20);
    const patchedEndDate = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/contract`,
      headers,
      payload: { endDate: toDateOnly(soon) },
    });
    expect(patchedEndDate.json().hasRenewalOption).toBe(true);
    expect(patchedEndDate.json().renewalOptionNotes).toBe('Cláusula 12: renovable hasta por 1 año más, previa notificación 30 días antes.');
  });

  it('REQ-055 (ronda 8): GET /renewals/upcoming agrupa por urgencia en vivo, SIN requerir haber corrido /renewals/scan antes, y un contrato aparece en varios grupos simultáneamente si aplica', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-12@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 12', 'c055-org-12');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // Contrato a 20 días (cruza 90/60/30 simultáneamente), CON opción de renovación.
    const urgentTenderId = await createTender(app, org.id, 'c055-012-urgente');
    await app.inject({ method: 'POST', url: `/expediente/tenders/${urgentTenderId}/contract`, headers });
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 20);
    await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${urgentTenderId}/contract`,
      headers,
      payload: { endDate: toDateOnly(soon), hasRenewalOption: true, renewalOptionNotes: 'Renovable un año más.' },
    });

    // Contrato a 45 días (cruza solo 60/90), SIN opción de renovación.
    const midTenderId = await createTender(app, org.id, 'c055-012-medio');
    await app.inject({ method: 'POST', url: `/expediente/tenders/${midTenderId}/contract`, headers });
    const mid = new Date();
    mid.setUTCDate(mid.getUTCDate() + 45);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${midTenderId}/contract`, headers, payload: { endDate: toDateOnly(mid) } });

    // Contrato ya vencido: no debe aparecer en ningún grupo.
    const pastTenderId = await createTender(app, org.id, 'c055-012-vencido');
    await app.inject({ method: 'POST', url: `/expediente/tenders/${pastTenderId}/contract`, headers });
    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 5);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${pastTenderId}/contract`, headers, payload: { endDate: toDateOnly(past) } });

    // Nótese: NUNCA se llamó a POST /renewals/scan -- este endpoint calcula en vivo.
    const res = await app.inject({ method: 'GET', url: '/expediente/renewals/upcoming', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thresholds).toEqual([30, 60, 90]);
    expect(body.truncated).toBe(false);
    expect(body.groups).toHaveLength(3);

    const groupByLeadDays = new Map<number, any>(body.groups.map((g: any) => [g.leadDays, g]));
    expect(groupByLeadDays.get(30).urgency).toBe('urgente');
    expect(groupByLeadDays.get(60).urgency).toBe('proxima');
    expect(groupByLeadDays.get(90).urgency).toBe('seguimiento');

    // Grupo 'urgente' (30 días): SOLO el contrato a 20 días.
    const urgentIds = groupByLeadDays.get(30).items.map((i: any) => i.tenderId);
    expect(urgentIds).toEqual([urgentTenderId]);
    const urgentItem = groupByLeadDays.get(30).items[0];
    expect(urgentItem.daysUntilEnd).toBe(20);
    expect(urgentItem.hasRenewalOption).toBe(true);
    expect(urgentItem.renewalOptionNotes).toBe('Renovable un año más.');

    // Grupo 'proxima' (60 días): el de 20 días Y el de 45 días -- ambos simultáneamente.
    const midGroupIds = groupByLeadDays.get(60).items.map((i: any) => i.tenderId).sort();
    expect(midGroupIds).toEqual([midTenderId, urgentTenderId].sort());
    const midItem = groupByLeadDays.get(60).items.find((i: any) => i.tenderId === midTenderId);
    expect(midItem.hasRenewalOption).toBe(false); // nunca se marcó -- distinción explícita del requisito.
    expect(midItem.daysUntilEnd).toBe(45);

    // Grupo 'seguimiento' (90 días): también ambos.
    expect(groupByLeadDays.get(90).items.map((i: any) => i.tenderId).sort()).toEqual([midTenderId, urgentTenderId].sort());

    // El contrato vencido no aparece en NINGÚN grupo.
    for (const g of body.groups) {
      expect(g.items.some((i: any) => i.tenderId === pastTenderId)).toBe(false);
    }
  });

  it('REQ-055 (ronda 8): GET /renewals/upcoming acepta umbrales configurables por querystring y un viewer (rol de solo lectura) puede consultarlo', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-13@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 13', 'c055-org-13');
    const viewer = await registerAndLogin(app, 'c055-viewer-13@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const tenderId = await createTender(app, org.id, 'c055-013');
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers: ownerHeaders });
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 10);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers: ownerHeaders, payload: { endDate: toDateOnly(soon) } });

    // Un umbral único y personalizado (15 días): el contrato a 10 días lo cruza.
    const viewerHeaders = { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id };
    const res = await app.inject({ method: 'GET', url: '/expediente/renewals/upcoming?thresholds=15', headers: viewerHeaders });
    expect(res.statusCode).toBe(200); // el viewer SÍ puede leer -- es un endpoint de consumo de negocio, no de escaneo/escritura.
    const body = res.json();
    expect(body.thresholds).toEqual([15]);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].urgency).toBe('urgente');
    expect(body.groups[0].items.map((i: any) => i.tenderId)).toEqual([tenderId]);
    expect(body.groups[0].items[0].daysUntilEnd).toBe(10);
  });

  it('REQ-055 (ronda 8): GET /renewals/upcoming -- thresholds inválido (no numérico) responde 422, y un CSV con más de 10 valores también', async () => {
    const owner = await registerAndLogin(app, 'c055-owner-14@example.com');
    const org = await createOrgFor(app, owner, 'C055 Org 14', 'c055-org-14');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const invalidFormat = await app.inject({ method: 'GET', url: '/expediente/renewals/upcoming?thresholds=abc', headers });
    expect(invalidFormat.statusCode).toBe(422);

    const tooMany = await app.inject({
      method: 'GET',
      url: `/expediente/renewals/upcoming?thresholds=${Array.from({ length: 11 }, (_, i) => i + 1).join(',')}`,
      headers,
    });
    expect(tooMany.statusCode).toBe(422);
  });
});
