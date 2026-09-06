import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-142 (procedencia por campo vinculante, tolerancia cero): un dato de
 * empresa SIN `field_provenance` (owner/source/updated_at) nunca es
 * utilizable en matching ni en el expediente, sin importar sus demás
 * columnas (`is_verified`, `status`, vigencia...). Reproduce el escenario
 * real: una fila insertada por una vía que NO pasa por la API (p. ej. una
 * carga directa a la base de datos, o una integración futura que olvide
 * llamar `recordFieldProvenance`) queda BLOQUEADA explícitamente, tanto en
 * la generación de la propuesta técnica (expediente) como en el matching.
 */
async function createTender(app: FastifyInstance, orgId: string, externalId = 'prov-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de auditoría', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

async function insertRequirement(db: DbClient, orgId: string, tenderId: string, description: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into requirement_items (id, org_id, tender_id, category, description, is_mandatory, obligatoriedad, requirement_kind, matrix_status, extracted_by, required_evidence)
     values ($1, $2, $3, 'administrativo', $4, true, 'obligatorio', 'administrativo', 'pendiente', 'rule', $5)`,
    [id, orgId, tenderId, description, ['evidencia_generica']]
  );
  return id;
}

describe('REQ-142 — procedencia vinculante (matching + expediente)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('expediente: una capacidad insertada SIN pasar por la API (sin field_provenance) bloquea el requisito; la misma capacidad creada vía API (con procedencia) sí resuelve', async () => {
    const owner = await registerAndLogin(app, 'prov-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Prov Org 1', 'prov-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Consultores Ejemplo SA de CV', taxId: 'CEJ010101AAA' } });

    // Capacidad insertada DIRECTAMENTE (bypass de la API): nunca pasa por
    // `recordFieldProvenance`, así que no existe fila en `field_provenance`
    // para ella -- reproduce "dato sin procedencia".
    const capIdSinProvenance = randomUUID();
    await db.query(
      "insert into capabilities (id, org_id, name, description, is_verified) values ($1, $2, 'Auditoría financiera', '10 años de experiencia', true)",
      [capIdSinProvenance, org.id]
    );

    const reqSinProvenance = await insertRequirement(db, org.id, tenderId, 'El licitante debe acreditar capacidad de auditoría financiera.');

    const generateSinProvenance = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [{ requirementId: reqSinProvenance, kind: 'capability', refKey: 'Auditoría financiera' }] },
    });
    expect(generateSinProvenance.statusCode).toBe(200);
    const blockersSinProvenance = generateSinProvenance.json().generationReport.technical.blockers as Array<{ requirementId: string; detail: string }>;
    expect(blockersSinProvenance.some((b) => b.requirementId === reqSinProvenance)).toBe(true);
    const sectionsSinProvenance = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal/sections`, headers });
    const sectionSinProvenance = sectionsSinProvenance.json().find((s: { sectionKey: string }) => s.sectionKey === `technical:${reqSinProvenance}`);
    expect(sectionSinProvenance.content).toContain('PENDIENTE');

    // La MISMA capacidad, creada vía la API normal (SÍ registra
    // procedencia): el requisito ahora sí resuelve.
    const capConProvenance = await app.inject({
      method: 'POST',
      url: '/company/capabilities',
      headers,
      payload: { name: 'Auditoría fiscal', description: '10 años de experiencia', isVerified: true },
    });
    expect(capConProvenance.statusCode).toBe(201);

    const reqConProvenance = await insertRequirement(db, org.id, tenderId, 'El licitante debe acreditar capacidad de auditoría fiscal.');
    const generateConProvenance = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [{ requirementId: reqConProvenance, kind: 'capability', refKey: 'Auditoría fiscal' }] },
    });
    expect(generateConProvenance.statusCode).toBe(200);
    const blockersConProvenance = generateConProvenance.json().generationReport.technical.blockers as Array<{ requirementId: string }>;
    expect(blockersConProvenance.some((b) => b.requirementId === reqConProvenance)).toBe(false);
    const sectionsConProvenance = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal/sections`, headers });
    const sectionConProvenance = sectionsConProvenance.json().find((s: { sectionKey: string }) => s.sectionKey === `technical:${reqConProvenance}`);
    expect(sectionConProvenance.content).not.toContain('PENDIENTE');
    expect(sectionConProvenance.content).toContain('Auditoría fiscal');
  });

  it('matching: un documento de empresa SIN procedencia genera un criterio de elegibilidad "no_evaluable" con bloqueo explícito por falta de procedencia', async () => {
    const owner = await registerAndLogin(app, 'prov-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Prov Org 2', 'prov-org-2');
    const tenderId = await createTender(app, org.id, 'prov-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // Documento insertado DIRECTAMENTE (sin `field_provenance`), con
    // vigencia futura -- si el matching solo mirara `valid_until` lo
    // consideraría "cumple"; con procedencia vinculante debe bloquearse.
    const docId = randomUUID();
    await db.query(
      "insert into company_documents (id, org_id, document_type, storage_ref, valid_until) values ($1, $2, 'acta_constitutiva', 'ref-sin-procedencia', '2099-01-01')",
      [docId, org.id]
    );

    const match = await app.inject({ method: 'GET', url: `/matching/tenders/${tenderId}`, headers });
    expect(match.statusCode).toBe(200);
    const provenanceCriterion = match.json().eligibility.criteria.find((c: { requirement: string }) => c.requirement === 'provenance');
    expect(provenanceCriterion).toBeDefined();
    expect(provenanceCriterion.status).toBe('no_evaluable');
    expect(provenanceCriterion.explanation).toContain('sin procedencia');
    expect(match.json().eligibility.status).not.toBe('cumple');
  });
});
