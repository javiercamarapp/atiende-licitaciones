import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

/**
 * E11/REQ-050/056: calendario oficial de días inhábiles. GET es de lectura
 * abierta (cualquier usuario autenticado -- el motor de plazos lo consume
 * para CUALQUIER organización), POST/carga es solo superadmin y exige
 * fuente verificable (sourceUrl + sourceConsultedOn), nunca una fecha "de
 * memoria" -- ver apps/api/docs/e11-cobertura.md.
 */
describe('GET/POST /admin/calendar-holidays', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('la tabla empieza vacía; un usuario normal puede leerla (vacía) pero no puede cargar un feriado', async () => {
    const user = await registerAndLogin(app, 'cal-user-1@example.com');

    const empty = await app.inject({ method: 'GET', url: '/admin/calendar-holidays', headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: {
        year: 2026,
        date: '2026-12-25',
        label: 'Navidad',
        sourceUrl: 'https://www.gob.mx/buengobierno/calendario-2026',
        sourceConsultedOn: '2026-09-06',
      },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('superadmin puede cargar un feriado con fuente verificable; el rechazo sin sourceUrl es explícito (422)', async () => {
    const superadminUser = await registerAndLogin(app, 'cal-admin-1@example.com');
    await makeSuperadmin(db, superadminUser.id);
    const headers = { authorization: `Bearer ${superadminUser.accessToken}` };

    const missingSource = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2026, date: '2026-12-25', label: 'Navidad' },
    });
    expect(missingSource.statusCode).toBe(422);

    const created = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: {
        year: 2026,
        date: '2026-12-25',
        label: 'Navidad',
        sourceUrl: 'https://www.gob.mx/buengobierno/calendario-2026',
        sourceConsultedOn: '2026-09-06',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().jurisdiction).toBe('federal');

    const list = await app.inject({ method: 'GET', url: '/admin/calendar-holidays?year=2026', headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(1);
    expect(list.json()[0].label).toBe('Navidad');

    const auditRow = await db.query("select action, entity from audit_log where entity = 'calendar_holidays'");
    expect(auditRow.rows.length).toBeGreaterThan(0);
  });
});
