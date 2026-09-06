import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E7 — propuesta técnica/económica real sobre `CompanyDataResolver` real
 * (packages/db). Cobertura: A8 (tarifa no aprobada rechazada de punta a
 * punta, sin total parcial).
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'prop-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de consultoría', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

/**
 * Inserta un `requirement_items` de prueba con `required_evidence` NO
 * vacío: `TechnicalProposalBuilder.build` solo intenta resolver un mapeo
 * declarado (`RequirementFulfillmentMapping`) cuando el requisito trae
 * evidencia requerida -- con `requiredEvidence.length === 0` SIEMPRE queda
 * en la rama "PENDIENTE" (obligatorio sin evidencia mapeable), sin importar
 * si se declaró un mapeo o no (ver packages/expediente/src/technical-
 * proposal.ts). Por eso todo requisito de este archivo trae al menos un
 * elemento en `requiredEvidence`.
 */
async function insertRequirement(
  db: DbClient,
  orgId: string,
  tenderId: string,
  overrides: Partial<{ description: string; requirementKind: string; obligatoriedad: string; requiredEvidence: string[] }> = {}
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into requirement_items (id, org_id, tender_id, category, description, is_mandatory, obligatoriedad, requirement_kind, matrix_status, extracted_by, required_evidence)
     values ($1, $2, $3, $4, $5, true, $6, $7, 'pendiente', 'rule', $8)`,
    [
      id,
      orgId,
      tenderId,
      overrides.requirementKind ?? 'administrativo',
      overrides.description ?? 'Debe acreditar capacidad técnica en la materia.',
      overrides.obligatoriedad ?? 'obligatorio',
      overrides.requirementKind ?? 'administrativo',
      overrides.requiredEvidence ?? ['evidencia_generica'],
    ]
  );
  return id;
}

describe('expediente — propuesta técnica/económica (E7)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('genera la propuesta técnica real: capacidad aprobada resuelve en texto trazable; sin mapeo declarado queda PENDIENTE (nunca inventa)', async () => {
    const owner = await registerAndLogin(app, 'prop-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Prop Org 1', 'prop-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Consultores Ejemplo SA de CV', taxId: 'CEJ010101AAA' } });
    const cap = await app.inject({ method: 'POST', url: '/company/capabilities', headers, payload: { name: 'Auditoría financiera', description: '10 años de experiencia', isVerified: true } });
    expect(cap.statusCode).toBe(201);

    const reqMapped = await insertRequirement(db, org.id, tenderId, { description: 'El licitante debe acreditar capacidad de auditoría financiera.' });
    const reqUnmapped = await insertRequirement(db, org.id, tenderId, { description: 'El licitante debe acreditar otra capacidad no declarada.' });

    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [{ requirementId: reqMapped, kind: 'capability', refKey: 'Auditoría financiera' }] },
    });
    expect(generate.statusCode).toBe(200);
    const report = generate.json().generationReport.technical;
    expect(report.blockers.length).toBeGreaterThan(0); // el requisito sin mapeo declarado queda bloqueado

    const sections = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal/sections`, headers });
    const mappedSection = sections.json().find((s: any) => s.sectionKey === `technical:${reqMapped}`);
    const unmappedSection = sections.json().find((s: any) => s.sectionKey === `technical:${reqUnmapped}`);
    expect(mappedSection.content).toContain('Auditoría financiera');
    expect(mappedSection.content).not.toContain('PENDIENTE');
    expect(unmappedSection.content).toContain('PENDIENTE');
  });

  it('A8: propuesta económica con tarifa NO aprobada se rechaza de punta a punta (sin total parcial); tras aprobar la tarifa, el cálculo procede', async () => {
    const owner = await registerAndLogin(app, 'prop-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Prop Org 2', 'prop-org-2');
    const tenderId = await createTender(app, org.id, 'prop-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const rateRes = await app.inject({
      method: 'POST',
      url: '/company/rates',
      headers,
      payload: { itemCode: 'hora-consultoria', description: 'Hora de consultoría', unitPrice: 850, validFrom: '2020-01-01' },
    });
    expect(rateRes.statusCode).toBe(201);
    expect(rateRes.json().status).toBe('draft'); // propuesta, aún no aprobada

    const blockedGenerate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'hora-consultoria', quantity: 10 }] },
    });
    expect(blockedGenerate.statusCode).toBe(200);
    expect(blockedGenerate.json().economicTotals).toBeNull();
    expect(blockedGenerate.json().generationReport.economic.blockedLineItems.length).toBe(1);

    const sectionsBeforeApproval = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal/sections`, headers });
    expect(sectionsBeforeApproval.json().find((s: any) => s.sectionKey === 'economic:carta')).toBeUndefined();

    // Aprobar la tarifa (solo owner/admin) y regenerar.
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rateRes.json().id}/approve`, headers });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe('approved');

    const okGenerate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'hora-consultoria', quantity: 10 }] },
    });
    expect(okGenerate.statusCode).toBe(200);
    expect(okGenerate.json().economicTotals).not.toBeNull();
    expect(okGenerate.json().economicTotals.subtotal).toBe('8500.00');
    expect(okGenerate.json().generationReport.economic.blockedLineItems.length).toBe(0);

    const sectionsAfterApproval = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal/sections`, headers });
    const carta = sectionsAfterApproval.json().find((s: any) => s.sectionKey === 'economic:carta');
    const anexo = sectionsAfterApproval.json().find((s: any) => s.sectionKey === 'economic:anexo');
    expect(carta).toBeDefined();
    expect(anexo).toBeDefined();
    expect(carta.content).toContain('9860.00'); // total con IVA (16%) sobre el subtotal de 8500.00
    expect(anexo.content).toContain('8500.00'); // subtotal (sin IVA) en el anexo detallado
  });

  it('viewer no puede editar una sección de la propuesta; writer sí, con nueva versión', async () => {
    const owner = await registerAndLogin(app, 'prop-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Prop Org 3', 'prop-org-3');
    const tenderId = await createTender(app, org.id, 'prop-003');
    const writer = await registerAndLogin(app, 'prop-writer-3@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);
    const viewer = await registerAndLogin(app, 'prop-viewer-3@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const reqId = await insertRequirement(db, org.id, tenderId);
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/proposal/technical/generate`, headers: ownerHeaders, payload: { mappings: [] } });

    const sectionKey = `technical:${reqId}`;
    const viewerPatch = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/proposal/sections/${sectionKey}`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { content: 'Intento de viewer' },
    });
    expect(viewerPatch.statusCode).toBe(403);

    const writerPatch = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/proposal/sections/${sectionKey}`,
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
      payload: { content: 'Texto redactado manualmente por el writer, con evidencia adicional.' },
    });
    expect(writerPatch.statusCode).toBe(200);
    expect(writerPatch.json().content).toContain('redactado manualmente');
    expect(writerPatch.json().version).toBe(2);
  });

  it('coordinación packages/expediente (expediente-cierre.md): cambiar la aplicabilidad de un requisito condicional invalida explícitamente una aprobación vigente (no forma parte de ExpedienteInputs, así que el hash no cambia por sí solo)', async () => {
    const owner = await registerAndLogin(app, 'prop-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Prop Org 4', 'prop-org-4');
    const tenderId = await createTender(app, org.id, 'prop-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const reqId = await insertRequirement(db, org.id, tenderId, {
      description: 'En caso de que aplique, el licitante debe presentar manifestación adicional.',
      obligatoriedad: 'condicional',
    });

    // Primera generación: el requisito condicional se declara explícitamente
    // como NO aplicable al caso concreto.
    const gen1 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [], conditionEvaluations: { [reqId]: false } },
    });
    expect(gen1.statusCode).toBe(200);

    const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers, payload: { scope: 'expediente', scopeRef: 'expediente' } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    // Segunda generación: la MISMA convocatoria/insumos, pero ahora se
    // declara que el requisito condicional SÍ aplica -- ExpedienteInputs no
    // incluye conditionEvaluations, así que el hash de insumos sería
    // idéntico; la invalidación debe ser explícita (no vía hash).
    const gen2 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [], conditionEvaluations: { [reqId]: true } },
    });
    expect(gen2.statusCode).toBe(200);

    const afterChange = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers });
    expect(afterChange.json().fullyApproved).toBe(false);
    expect(afterChange.json().approvals.find((a: any) => a.scope === 'expediente').status).toBe('invalidada');

    // Regenerar con la MISMA declaración que la última vez no debe volver a invalidar nada adicional (no hay cambio real).
    const gen3 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [], conditionEvaluations: { [reqId]: true } },
    });
    expect(gen3.statusCode).toBe(200);
  });
});
