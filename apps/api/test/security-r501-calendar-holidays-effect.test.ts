import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';
import { addBusinessDays } from '../src/lib/expediente/business-days.js';

/**
 * R5-01 (docs/auditoria-2/api-ronda5.md, CRÍTICA): `calendar_holidays`
 * cargado por un administrador NUNCA afectaba el cómputo real del plazo de
 * pago (`loadOfficialHolidays` serializaba la columna `date` con
 * `String(dateObject)` -- `Date.prototype.toString()`, dependiente de `TZ`
 * del proceso -- en vez de `toISOString()`, así que la clave nunca coincidía
 * con el formato "YYYY-MM-DD" que usa `addBusinessDays`). Además,
 * `calendarNote` afirmaba falsamente que el feriado "fue incluido en el
 * cómputo" incluso cuando el bug lo ignoraba por completo, o cuando el
 * feriado cargado ni siquiera caía dentro de la ventana real de este
 * cómputo concreto.
 *
 * Fijado: `loadOfficialHolidays` normaliza con `toDateOnlyString` (getters
 * UTC, determinista sin importar `TZ`), y `calendarNote` solo afirma
 * inclusión para los feriados oficiales que de verdad cayeron dentro de la
 * ventana [verifiedOn, dueDate] de ESTE cómputo.
 */
async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

async function createTender(app: FastifyInstance, orgId: string, externalId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Contrato R5-01', sourceVersion: 'v1', publishedAt: '2025-05-01T00:00:00Z' }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

async function loadHoliday(app: FastifyInstance, superadminToken: string, dateIso: string, label: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/calendar-holidays',
    headers: { authorization: `Bearer ${superadminToken}` },
    payload: {
      year: Number(dateIso.slice(0, 4)),
      date: dateIso,
      label,
      sourceUrl: 'https://www.gob.mx/buengobierno/calendario-oficial',
      sourceConsultedOn: '2026-01-01',
    },
  });
  expect(res.statusCode).toBe(201);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addCalDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
function isWeekendIso(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
function nextWeekend(iso: string): string {
  let d = iso;
  while (!isWeekendIso(d)) d = addCalDays(d, 1);
  return d;
}
/** Elige `count` fechas hábiles (lunes-viernes) crecientes a partir de `startOffset` días después de `verifiedOn`, dentro de una ventana de ~24 días naturales (suficiente para 17 días hábiles). */
function pickWeekdayHolidays(verifiedOn: string, count: number, startOffset = 3): string[] {
  const picked: string[] = [];
  let offset = startOffset;
  while (picked.length < count) {
    const candidate = addCalDays(verifiedOn, offset);
    if (!isWeekendIso(candidate)) picked.push(candidate);
    offset += 1;
  }
  return picked;
}

async function createFollowup(app: FastifyInstance, headers: Record<string, string>, tenderId: string, verifiedOn: string, label: string): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: 'POST',
    url: `/expediente/tenders/${tenderId}/post-award`,
    headers,
    payload: { kind: 'pago', label, invoiceVerifiedOn: verifiedOn },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('R5-01: calendar_holidays SÍ excluye el día real del cómputo del plazo de pago', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('feriado oficial DENTRO de la ventana: el dueDate real se corre y calendarNote lo afirma honestamente', async () => {
    const owner = await registerAndLogin(app, 'r501-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'R501 Org 1', 'r501-org-1');
    const superadmin = await registerAndLogin(app, 'r501-admin-1@example.com');
    await makeSuperadmin(db, superadmin.id);
    const tenderId = await createTender(app, org.id, 'r501-001');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const verifiedOn = '2026-01-05';
    const baseline = addBusinessDays(verifiedOn, 17, []);

    const [holiday] = pickWeekdayHolidays(verifiedOn, 1, 5);
    await loadHoliday(app, superadmin.accessToken, holiday, 'Feriado de prueba R5-01');

    const expected = addBusinessDays(verifiedOn, 17, [holiday]);
    expect(expected).not.toBe(baseline); // el feriado sí debe mover la fecha

    const { statusCode, body } = await createFollowup(app, headers, tenderId, verifiedOn, 'Pago 1');
    expect(statusCode).toBe(201);
    expect(String(body.dueDate).slice(0, 10)).toBe(expected);
    expect(body.calendarNote).toContain('1 día(s) inhábil(es) oficial(es)');
    expect(body.calendarNote).toContain('excluido(s) del plazo');
  });

  it('feriado oficial FUERA de la ventana: el dueDate NO cambia y calendarNote no afirma inclusión', async () => {
    const owner = await registerAndLogin(app, 'r501-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'R501 Org 2', 'r501-org-2');
    const superadmin = await registerAndLogin(app, 'r501-admin-2@example.com');
    await makeSuperadmin(db, superadmin.id);
    const tenderId = await createTender(app, org.id, 'r501-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const verifiedOn = '2026-01-05';
    const baseline = addBusinessDays(verifiedOn, 17, []);

    // 200 días naturales después está muy fuera de la ventana de ~24 días de 17 hábiles.
    const farHoliday = addCalDays(verifiedOn, 200);
    await loadHoliday(app, superadmin.accessToken, farHoliday, 'Feriado fuera de ventana');

    const { statusCode, body } = await createFollowup(app, headers, tenderId, verifiedOn, 'Pago 1');
    expect(statusCode).toBe(201);
    expect(String(body.dueDate).slice(0, 10)).toBe(baseline);
    expect(body.calendarNote).toContain('1 día(s) inhábil(es) oficial(es)');
    expect(body.calendarNote).toContain('ninguno cayó dentro de la ventana');
    expect(body.calendarNote).not.toContain('excluido(s) del plazo');
  });

  it('feriado oficial que cae en FIN DE SEMANA: no duplica el descuento (dueDate igual al baseline solo-fin-de-semana)', async () => {
    const owner = await registerAndLogin(app, 'r501-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'R501 Org 3', 'r501-org-3');
    const superadmin = await registerAndLogin(app, 'r501-admin-3@example.com');
    await makeSuperadmin(db, superadmin.id);
    const tenderId = await createTender(app, org.id, 'r501-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const verifiedOn = '2026-01-05';
    const baseline = addBusinessDays(verifiedOn, 17, []);

    // Un feriado que cae en fin de semana, dentro de la ventana.
    const weekendHoliday = nextWeekend(addCalDays(verifiedOn, 3));
    await loadHoliday(app, superadmin.accessToken, weekendHoliday, 'Feriado en fin de semana');

    const expected = addBusinessDays(verifiedOn, 17, [weekendHoliday]);
    expect(expected).toBe(baseline); // ya estaba excluido por ser fin de semana -- ningún día extra

    const { statusCode, body } = await createFollowup(app, headers, tenderId, verifiedOn, 'Pago 1');
    expect(statusCode).toBe(201);
    expect(String(body.dueDate).slice(0, 10)).toBe(baseline);
  });

  it('aceptación/verificación en FIN DE SEMANA: el cómputo del plazo sigue siendo correcto (regresión de anclaje de fecha)', async () => {
    const owner = await registerAndLogin(app, 'r501-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'R501 Org 4', 'r501-org-4');
    const tenderId = await createTender(app, org.id, 'r501-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const verifiedOnWeekend = nextWeekend('2026-01-01');
    const expected = addBusinessDays(verifiedOnWeekend, 17, []);

    const { statusCode, body } = await createFollowup(app, headers, tenderId, verifiedOnWeekend, 'Pago fin de semana');
    expect(statusCode).toBe(201);
    expect(String(body.dueDate).slice(0, 10)).toBe(expected);
  });

  it('propiedad: con N feriados oficiales distintos dentro de la ventana, el dueDate real coincide con el cálculo independiente para N=0,1,2,3 (monótono creciente)', async () => {
    const owner = await registerAndLogin(app, 'r501-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'R501 Org 5', 'r501-org-5');
    const superadmin = await registerAndLogin(app, 'r501-admin-5@example.com');
    await makeSuperadmin(db, superadmin.id);
    const tenderId = await createTender(app, org.id, 'r501-005');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const verifiedOn = '2026-01-05';
    const holidays = pickWeekdayHolidays(verifiedOn, 3, 4);
    const loaded: string[] = [];
    const dueDates: string[] = [];

    for (let n = 0; n <= holidays.length; n++) {
      if (n > 0) {
        await loadHoliday(app, superadmin.accessToken, holidays[n - 1], `Feriado ${n}`);
        loaded.push(holidays[n - 1]);
      }
      const expected = addBusinessDays(verifiedOn, 17, loaded);
      const { statusCode, body } = await createFollowup(app, headers, tenderId, verifiedOn, `Pago N=${n}`);
      expect(statusCode).toBe(201);
      expect(String(body.dueDate).slice(0, 10)).toBe(expected);
      dueDates.push(body.dueDate);
    }

    // Estrictamente creciente: cada feriado adicional dentro de la ventana corre la fecha, nunca la deja igual ni la retrocede.
    for (let i = 1; i < dueDates.length; i++) {
      expect(dueDates[i] > dueDates[i - 1]).toBe(true);
    }
  });
});
