import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-053 — redactor de inconformidades: borrador estructurado (hechos,
 * agravios, fundamentos citando LAASSP Art. 95/Art. 49 con jurisdicción y
 * fecha DOF, pruebas, plazo calculado con el motor de plazos: 6 días
 * hábiles / 10 con tratados), marcado "borrador -- requiere revisión de
 * abogado"; sin envío; versionado con hash; step-up para "marcar como
 * revisado".
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'c053-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Licitación impugnada', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — redactor de inconformidades (REQ-053)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('genera un borrador con fundamentos (Art. 95/Art. 49, jurisdicción y fecha DOF), plazo a 6 días hábiles, y marca "borrador -- requiere revisión de abogado"', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 1', 'c053-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // 2026-01-05 es lunes; +6 días hábiles (sin feriados) cae el 2026-01-13 (martes).
    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: {
        falloNotifiedOn: '2026-01-05',
        bajoTratados: false,
        hechos: ['Se publicó el fallo el 2026-01-05.', 'La propuesta propia fue desechada por un requisito no esencial.'],
        agravios: ['El fallo no motiva ni funda el desechamiento conforme al Art. 49.'],
        pruebas: ['Copia del fallo notificado.'],
      },
    });
    expect(create.statusCode).toBe(201);
    const draft = create.json();
    expect(draft.status).toBe('borrador');
    expect(draft.version).toBe(1);
    expect(draft.disclaimer).toContain('BORRADOR');
    expect(draft.disclaimer.toLowerCase()).toContain('revisión de abogado');
    expect(draft.plazo.fechaLimite).toContain('2026-01-13');
    expect(draft.plazo.diasHabiles).toBe(6);
    expect(draft.plazo.fundamentoLegal).toContain('Art. 95');

    expect(draft.fundamentos.length).toBe(2);
    const art95 = draft.fundamentos.find((f: any) => f.articulo === 'Art. 95');
    expect(art95.ley).toBe('LAASSP nueva');
    expect(art95.jurisdiccion).toBe('Federal');
    expect(art95.fechaDof).toBe('2025-04-16');
    const art49 = draft.fundamentos.find((f: any) => f.articulo === 'Art. 49');
    expect(art49).toBeTruthy();
    expect(art49.fechaDof).toBe('2025-04-16');

    // Guardrail anti-frivolidad: 1 agravio, 1 prueba -> viabilidad alta.
    expect(draft.viability).toBe('alta');
    expect(draft.contentHash).toBeTruthy();

    const list = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/inconformidad`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(1);
  });

  it('bajoTratados=true calcula el plazo a 10 días hábiles en vez de 6', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 2', 'c053-org-2');
    const tenderId = await createTender(app, org.id, 'c053-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // 2026-01-05 es lunes; +10 días hábiles (sin feriados) cae el 2026-01-19 (lunes).
    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: {
        falloNotifiedOn: '2026-01-05',
        bajoTratados: true,
        hechos: ['Licitación pública internacional bajo cobertura de tratados.'],
        agravios: ['El fallo favorece a un proveedor extranjero sin motivación suficiente.'],
        pruebas: [],
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().plazo.diasHabiles).toBe(10);
    expect(create.json().plazo.fechaLimite).toContain('2026-01-19');

    // Guardrail anti-frivolidad: 0 pruebas -> viabilidad baja, con recomendación explícita.
    expect(create.json().viability).toBe('baja');
    expect(create.json().viabilityRecommendation.toLowerCase()).toContain('prueba');
  });

  it('cada generación crea una VERSIÓN nueva (nunca edita una existente); el contenido es inmutable a nivel de base de datos', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 3', 'c053-org-3');
    const tenderId = await createTender(app, org.id, 'c053-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const v1 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: { falloNotifiedOn: '2026-01-05', hechos: ['hecho 1'], agravios: ['agravio 1'], pruebas: [] },
    });
    const v2 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: { falloNotifiedOn: '2026-01-06', hechos: ['hecho 1 corregido'], agravios: ['agravio 1', 'agravio 2'], pruebas: ['prueba 1'] },
    });
    expect(v1.json().version).toBe(1);
    expect(v2.json().version).toBe(2);
    expect(v1.json().contentHash).not.toBe(v2.json().contentHash);

    // Intentar mutar el contenido directamente en la base -- el trigger de inmutabilidad lo rechaza.
    await expect(db.query('update inconformidad_drafts set hechos = $1 where id = $2', [['hecho manipulado'], v1.json().id])).rejects.toThrow();
  });

  it('marcar como revisado exige step-up y rol reviewer/admin/owner; ya revisado -> 409; sin step-up -> 403', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 4', 'c053-org-4');
    const tenderId = await createTender(app, org.id, 'c053-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const draft = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: { falloNotifiedOn: '2026-01-05', hechos: ['hecho'], agravios: ['agravio'], pruebas: ['prueba'] },
    });
    const draftId = draft.json().id;

    const withoutStepUp = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/inconformidad/${draftId}/mark-reviewed`, headers });
    expect(withoutStepUp.statusCode).toBe(403);

    const scope = { orgId: org.id, purpose: 'expediente.inconformidad_review' as const };
    const { backupCodes, stepUpToken } = await enrollTwoFactorFull(app, owner.accessToken, scope);
    const reviewed = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad/${draftId}/mark-reviewed`,
      headers: { ...headers, 'x-step-up': stepUpToken },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().status).toBe('revisado');
    expect(reviewed.json().reviewedBy).toBe(owner.id);

    const secondToken = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], scope);
    const alreadyReviewed = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad/${draftId}/mark-reviewed`,
      headers: { ...headers, 'x-step-up': secondToken },
    });
    expect(alreadyReviewed.statusCode).toBe(409);
  });

  it('R6-07: con un feriado oficial CARGADO dentro de la ventana, el plazo de 6 días hábiles lo excluye correctamente (no solo sábado/domingo)', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 6', 'c053-org-6');
    const tenderId = await createTender(app, org.id, 'c053-006');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // Carga directa de un feriado oficial "federal" (equivalente a lo que
    // haría un superadmin vía POST /admin/calendar-holidays, ver
    // apps/api/test/admin-calendar-holidays.test.ts) -- 2026-01-08 es
    // jueves, un día hábil ordinario dentro de la ventana de cómputo de
    // este caso.
    await db.query(
      `insert into calendar_holidays (jurisdiction, year, holiday_date, label, source_url, source_consulted_on)
       values ('federal', 2026, '2026-01-08', 'Feriado de prueba (R6-07)', 'https://www.gob.mx/ejemplo', '2026-01-01')`
    );

    // Sin el feriado: 2026-01-05 (lunes) + 6 días hábiles = 2026-01-13
    // (martes), ver el primer caso de este archivo. CON el feriado del
    // 2026-01-08 (jueves) excluido además de sábado/domingo, el cómputo
    // debe correrse un día hábil más: 2026-01-14 (miércoles).
    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: {
        falloNotifiedOn: '2026-01-05',
        bajoTratados: false,
        hechos: ['Se publicó el fallo el 2026-01-05.'],
        agravios: ['El fallo no motiva ni funda el desechamiento conforme al Art. 49.'],
        pruebas: ['Copia del fallo notificado.'],
      },
    });
    expect(create.statusCode).toBe(201);
    const draft = create.json();
    expect(draft.plazo.diasHabiles).toBe(6);
    expect(draft.plazo.fechaLimite).toContain('2026-01-14');
    expect(draft.plazo.fechaLimite).not.toContain('2026-01-13');
  });

  it('R6-08: guardrail anti-frivolidad clasifica "media" cuando hay menos pruebas que agravios (sin bloquear la generación)', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 7', 'c053-org-7');
    const tenderId = await createTender(app, org.id, 'c053-007');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // 2 agravios, 1 prueba: pruebas.length (1) < agravios.length (2) ->
    // rama "media" de assessViability (ni "baja", 0 pruebas; ni "alta",
    // una prueba por cada agravio).
    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: {
        falloNotifiedOn: '2026-01-05',
        bajoTratados: false,
        hechos: ['Se publicó el fallo el 2026-01-05.'],
        agravios: ['El fallo no motiva ni funda el desechamiento conforme al Art. 49.', 'El acta de fallo omite la evaluación técnica de la propuesta.'],
        pruebas: ['Copia del fallo notificado.'],
      },
    });
    expect(create.statusCode).toBe(201); // NUNCA bloquea, solo clasifica/advierte.
    const draft = create.json();
    expect(draft.viability).toBe('media');
    expect(draft.viabilityRecommendation).toContain('1 prueba');
    expect(draft.viabilityRecommendation).toContain('2 agravio');
  });

  it('viewer no puede generar un borrador de inconformidad', async () => {
    const owner = await registerAndLogin(app, 'c053-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'C053 Org 5', 'c053-org-5');
    const tenderId = await createTender(app, org.id, 'c053-005');
    const viewer = await registerAndLogin(app, 'c053-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const attempt = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { falloNotifiedOn: '2026-01-05', hechos: ['hecho'], agravios: ['agravio'], pruebas: [] },
    });
    expect(attempt.statusCode).toBe(403);
  });
});
