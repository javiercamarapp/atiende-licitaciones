import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

/**
 * R5-06 (docs/auditoria-2/api-ronda5.md, BAJA): `sourceUrl` de
 * `calendar_holidays` aceptaba cualquier esquema de URL
 * (`javascript:...`, `data:...`, `ftp://...`) -- `z.string().url()` no
 * restringe el esquema. Fijado con un `.refine` que exige http(s).
 *
 * R5-07 (docs/auditoria-2/api-ronda5.md, BAJA): una fecha calendario
 * inexistente ("2026-02-30") solo se validaba por PATRÓN, no por
 * existencia real -- reventaba en Postgres con 500 en vez de 422. Fijado
 * con `realCalendarDateString` (lib/schema-helpers.ts).
 */
describe('R5-06/R5-07: validación de entrada de POST /admin/calendar-holidays', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function superadminHeaders(email: string): Promise<Record<string, string>> {
    const user = await registerAndLogin(app, email);
    await makeSuperadmin(db, user.id);
    return { authorization: `Bearer ${user.accessToken}` };
  }

  it('R5-06: sourceUrl con esquema javascript: es rechazado con 422 (no solo formato de URL genérico)', async () => {
    const headers = await superadminHeaders('r506-admin-1@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2026, date: '2026-12-25', label: 'Navidad', sourceUrl: 'javascript:alert(1)', sourceConsultedOn: '2026-09-06' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('R5-06: sourceUrl con esquema data: también es rechazado', async () => {
    const headers = await superadminHeaders('r506-admin-2@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2026, date: '2026-12-25', label: 'Navidad', sourceUrl: 'data:text/html,<script>alert(1)</script>', sourceConsultedOn: '2026-09-06' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('R5-06: sourceUrl http/https sigue siendo aceptado (no se rompe el caso legítimo)', async () => {
    const headers = await superadminHeaders('r506-admin-3@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2026, date: '2026-12-25', label: 'Navidad', sourceUrl: 'https://www.gob.mx/buengobierno/calendario-2026', sourceConsultedOn: '2026-09-06' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('R5-07: una fecha calendario inexistente (2026-02-30) responde 422 explícito, no 500', async () => {
    const headers = await superadminHeaders('r507-admin-1@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2026, date: '2026-02-30', label: 'Fecha inválida', sourceUrl: 'https://www.gob.mx/calendario', sourceConsultedOn: '2026-09-06' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('R5-07: sourceConsultedOn inexistente (2026-13-01) también responde 422 explícito', async () => {
    const headers = await superadminHeaders('r507-admin-2@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2026, date: '2026-12-25', label: 'Navidad', sourceUrl: 'https://www.gob.mx/calendario', sourceConsultedOn: '2026-13-01' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('R5-07: una fecha calendario real válida (incluyendo año bisiesto, 2024-02-29) sigue siendo aceptada', async () => {
    const headers = await superadminHeaders('r507-admin-3@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/admin/calendar-holidays',
      headers,
      payload: { year: 2024, date: '2024-02-29', label: 'Día bisiesto de prueba', sourceUrl: 'https://www.gob.mx/calendario', sourceConsultedOn: '2026-09-06' },
    });
    expect(res.statusCode).toBe(201);
  });
});
