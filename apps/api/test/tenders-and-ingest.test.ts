import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

// Una app/DB nuevas por caso: el rate limit de /auth/login (5/min por IP)
// se comparte dentro de una misma app, y varios de estos casos hacen más
// de un login; aislar por caso evita 429 espurios sin relación con lo que
// se está probando.
describe('convocatorias e ingesta interna (E3/E4)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('POST /internal/tenders/ingest sin X-Platform-Api-Key es rechazado (401/403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      payload: { records: [{ source: 'test', externalId: 'x', title: 'x', sourceVersion: 'v1' }] },
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it('A1: nueva publicación crea la convocatoria y una versión inicial', async () => {
    const owner = await registerAndLogin(app, 'tenders-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Tenders Org 1', 'tenders-org-1');

    const res = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: {
        records: [
          {
            source: 'compras-mx',
            externalId: 'A1-001',
            title: 'Adquisición de equipo de cómputo',
            sourceVersion: 'v1',
            budgetAmount: 100000,
          },
        ],
        organizationIds: [org.id],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results[0].action).toBe('created');
    expect(body.summary.created).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/tenders/${body.results[0].tenderId}`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().title).toBe('Adquisición de equipo de cómputo');

    const versions = await app.inject({
      method: 'GET',
      url: `/tenders/${body.results[0].tenderId}/versions`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(versions.json().length).toBe(1);
    expect(versions.json()[0].changeKind).toBe('publication');
  });

  it('A2: reingestar exactamente la misma versión es un no-op idempotente (0 filas nuevas)', async () => {
    const owner = await registerAndLogin(app, 'tenders-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Tenders Org 2', 'tenders-org-2');

    const record = { source: 'compras-mx', externalId: 'A2-001', title: 'Servicio de limpieza', sourceVersion: 'v1' };
    const first = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: { records: [record], organizationIds: [org.id] },
    });
    expect(first.json().results[0].action).toBe('created');
    const tenderId = first.json().results[0].tenderId;

    // Replay EXACTO (mismo source/externalId/sourceVersion).
    const replay = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: { records: [record], organizationIds: [org.id] },
    });
    expect(replay.json().results[0].action).toBe('unchanged');
    expect(replay.json().summary.created).toBe(0);
    expect(replay.json().summary.updated).toBe(0);

    const versions = await app.inject({
      method: 'GET',
      url: `/tenders/${tenderId}/versions`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    // 0 filas nuevas: sigue habiendo exactamente 1 versión, no 2.
    expect(versions.json().length).toBe(1);
  });

  it('A3: una modificación con nueva versión de origen adelanta el plazo, crea evento e invalida dependientes', async () => {
    const owner = await registerAndLogin(app, 'tenders-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Tenders Org 3', 'tenders-org-3');

    const v1 = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: {
        records: [
          {
            source: 'compras-mx',
            externalId: 'A3-001',
            title: 'Obra pública',
            sourceVersion: 'v1',
            submissionDeadline: '2026-12-01T00:00:00.000Z',
          },
        ],
        organizationIds: [org.id],
      },
    });
    const tenderId = v1.json().results[0].tenderId;

    // Crea una propuesta y un requirement_item dependientes directamente
    // (fuera del alcance de esta ronda el pipeline completo de redacción;
    // se siembra el mínimo necesario para probar la invalidación real).
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta A3') returning id",
      [org.id, tenderId]
    );

    const v2 = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: {
        records: [
          {
            source: 'compras-mx',
            externalId: 'A3-001',
            title: 'Obra pública',
            sourceVersion: 'v2',
            submissionDeadline: '2026-11-15T00:00:00.000Z', // plazo adelantado
            changeKind: 'deadline_change',
          },
        ],
        organizationIds: [org.id],
      },
    });
    expect(v2.json().results[0].action).toBe('updated');

    const changeEvents = await app.inject({
      method: 'GET',
      url: `/tenders/${tenderId}/change-events`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    // 2 eventos en total: 'publication' (v1) + 'deadline_change' (v2).
    expect(changeEvents.json().length).toBe(2);
    expect(changeEvents.json().at(-1).changeKind).toBe('deadline_change');

    const proposal = await db.query<{ invalidated_at: string | null }>('select invalidated_at from proposals where id = $1', [
      proposalRows[0].id,
    ]);
    expect(proposal.rows[0].invalidated_at).not.toBeNull();
  });

  it('lista de convocatorias no filtra entre organizaciones (aislamiento por org_id)', async () => {
    const ownerA = await registerAndLogin(app, 'tenders-owner-4a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Tenders Org 4A', 'tenders-org-4a');
    const ownerB = await registerAndLogin(app, 'tenders-owner-4b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'Tenders Org 4B', 'tenders-org-4b');

    await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: { records: [{ source: 'test', externalId: 'iso-a', title: 'Solo A', sourceVersion: 'v1' }], organizationIds: [orgA.id] },
    });

    const listA = await app.inject({
      method: 'GET',
      url: '/tenders',
      headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
    });
    const listB = await app.inject({
      method: 'GET',
      url: '/tenders',
      headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
    });
    expect(listA.json().items.some((t: any) => t.externalId === 'iso-a')).toBe(true);
    expect(listB.json().items.some((t: any) => t.externalId === 'iso-a')).toBe(false);
  });

  it('viewer no puede escribir en go/no-go pero sí lee tenders (viewer solo lee)', async () => {
    const owner = await registerAndLogin(app, 'tenders-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Tenders Org 5', 'tenders-org-5');
    const viewer = await registerAndLogin(app, 'tenders-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const ingest = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: { records: [{ source: 'test', externalId: 'viewer-1', title: 'X', sourceVersion: 'v1' }], organizationIds: [org.id] },
    });
    const tenderId = ingest.json().results[0].tenderId;

    const listAsViewer = await app.inject({
      method: 'GET',
      url: '/tenders',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
    });
    expect(listAsViewer.statusCode).toBe(200);

    const decideAsViewer = await app.inject({
      method: 'POST',
      url: `/tenders/${tenderId}/go-no-go`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { decision: 'go', reasons: ['x'] },
    });
    expect(decideAsViewer.statusCode).toBe(403);
  });

  it('GET /tenders/sources/freshness responde para cualquier usuario autenticado (sin X-Org-Id)', async () => {
    const owner = await registerAndLogin(app, 'tenders-owner-6@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/tenders/sources/freshness',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
