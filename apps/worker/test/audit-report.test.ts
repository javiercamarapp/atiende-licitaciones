import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { computeAuditReport } from '../src/agents/audit-report.js';
import { createMigratedDb, seedOrgAndUser } from './helpers.js';

const FIXED_NOW = () => new Date('2026-09-10T12:00:00Z');

/**
 * REQ-070, nodo "Auditor" (`computeAuditReport`, `audit-report.ts`): cada
 * caso aquí usa datos REALES insertados en Postgres (PGlite), nunca un
 * resultado fabricado — el reporte se calcula sobre lo que de verdad está
 * persistido. Cubre el criterio positivo (matriz completa + secciones
 * citadas -> sin bloqueos) y cada bloqueo negativo por separado.
 */
describe('computeAuditReport (REQ-070, nodo Auditor): reporte determinista, nunca fabricado', () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('convocatoria inexistente en la organización activa: bloqueo explícito, nada más', async () => {
    const { orgId } = await seedOrgAndUser(db, 'audit-no-tender');
    const report = await computeAuditReport(db, orgId, '00000000-0000-0000-0000-000000000000', FIXED_NOW);
    expect(report.blocking).toEqual(['convocatoria_no_encontrada: no existe una convocatoria con este id en la organización activa']);
    expect(report.warnings).toEqual([]);
  });

  it('sin requisitos obligatorios activos: bloqueo "matriz_de_requisitos_vacia"', async () => {
    const { orgId } = await seedOrgAndUser(db, 'audit-sin-matriz');
    const tender = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'a1', 'Convocatoria') returning id`,
      [orgId],
    );
    const report = await computeAuditReport(db, orgId, tender.rows[0].id, FIXED_NOW);
    expect(report.blocking).toContain('matriz_de_requisitos_vacia: no hay requisitos obligatorios activos (requirement_items) para auditar');
  });

  it('con requisitos obligatorios pero sin ninguna propuesta creada: bloqueo "sin_expediente"', async () => {
    const { orgId } = await seedOrgAndUser(db, 'audit-sin-expediente');
    const tender = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'a1', 'Convocatoria') returning id`,
      [orgId],
    );
    const tenderId = tender.rows[0].id;
    await db.query(
      `insert into requirement_items (org_id, tender_id, category, description, is_mandatory) values ($1, $2, 'legal', 'Acta constitutiva', true)`,
      [orgId, tenderId],
    );
    const report = await computeAuditReport(db, orgId, tenderId, FIXED_NOW);
    expect(report.blocking).toContain('sin_expediente: no existe todavía una propuesta (proposals) para esta convocatoria');
  });

  async function seedTenderWithMandatoryRequirement(slug: string): Promise<{ orgId: string; tenderId: string; requirementId: string; proposalId: string }> {
    const { orgId } = await seedOrgAndUser(db, slug);
    const tender = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'a1', 'Convocatoria') returning id`,
      [orgId],
    );
    const tenderId = tender.rows[0].id;
    const requirement = await db.query<{ id: string }>(
      `insert into requirement_items (org_id, tender_id, category, description, is_mandatory) values ($1, $2, 'legal', 'Acta constitutiva', true) returning id`,
      [orgId, tenderId],
    );
    const proposal = await db.query<{ id: string }>(
      `insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta v1') returning id`,
      [orgId, tenderId],
    );
    return { orgId, tenderId, requirementId: requirement.rows[0].id, proposalId: proposal.rows[0].id };
  }

  it('propuesta creada pero sin sección para el requisito obligatorio: bloqueo "requisito_sin_seccion:<id>"', async () => {
    const { orgId, tenderId, requirementId } = await seedTenderWithMandatoryRequirement('audit-sin-seccion');
    const report = await computeAuditReport(db, orgId, tenderId, FIXED_NOW);
    expect(report.blocking).toContain(`requisito_sin_seccion:${requirementId}`);
  });

  it('sección existe pero su contenido sigue "PENDIENTE:": bloqueo "seccion_pendiente:<key>"', async () => {
    const { orgId, tenderId, requirementId, proposalId } = await seedTenderWithMandatoryRequirement('audit-seccion-pendiente');
    const key = `technical:${requirementId}`;
    await db.query(
      `insert into proposal_sections (org_id, proposal_id, section_key, title, content, sources) values ($1, $2, $3, 'Sección', 'PENDIENTE: falta redactar', '[]'::jsonb)`,
      [orgId, proposalId, key],
    );
    const report = await computeAuditReport(db, orgId, tenderId, FIXED_NOW);
    expect(report.blocking).toContain(`seccion_pendiente:${key}`);
    expect(report.blocking).not.toContain(`requisito_sin_seccion:${requirementId}`);
  });

  it('sección redactada pero sin ninguna fuente citada: bloqueo "seccion_sin_fuente:<key>" (nunca se acepta un texto sin cita real)', async () => {
    const { orgId, tenderId, requirementId, proposalId } = await seedTenderWithMandatoryRequirement('audit-seccion-sin-fuente');
    const key = `technical:${requirementId}`;
    await db.query(
      `insert into proposal_sections (org_id, proposal_id, section_key, title, content, sources) values ($1, $2, $3, 'Sección', 'Texto redactado real.', '[]'::jsonb)`,
      [orgId, proposalId, key],
    );
    const report = await computeAuditReport(db, orgId, tenderId, FIXED_NOW);
    expect(report.blocking).toContain(`seccion_sin_fuente:${key}`);
  });

  it('matriz completa + sección redactada y citada, sin carta/anexo económico: sin bloqueos, con advertencia real de "propuesta_economica_pendiente"', async () => {
    const { orgId, tenderId, requirementId, proposalId } = await seedTenderWithMandatoryRequirement('audit-verde-con-warning');
    const key = `technical:${requirementId}`;
    await db.query(
      `insert into proposal_sections (org_id, proposal_id, section_key, title, content, sources) values ($1, $2, $3, 'Sección', 'Texto redactado real.', $4::jsonb)`,
      [orgId, proposalId, key, JSON.stringify([{ docId: 'requirement_items', page: null }])],
    );
    const report = await computeAuditReport(db, orgId, tenderId, FIXED_NOW);
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toContain('propuesta_economica_pendiente: aún no se generó la carta y/o el anexo económico de esta propuesta');
  });

  it('matriz completa + sección citada + carta y anexo económico: sin bloqueos NI advertencias — auditoría limpia real', async () => {
    const { orgId, tenderId, requirementId, proposalId } = await seedTenderWithMandatoryRequirement('audit-verde-completo');
    const key = `technical:${requirementId}`;
    const sources = JSON.stringify([{ docId: 'requirement_items', page: null }]);
    await db.query(
      `insert into proposal_sections (org_id, proposal_id, section_key, title, content, sources) values ($1, $2, $3, 'Sección', 'Texto redactado real.', $4::jsonb)`,
      [orgId, proposalId, key, sources],
    );
    await db.query(
      `insert into proposal_sections (org_id, proposal_id, section_key, title, content, sources) values ($1, $2, 'economic:carta', 'Carta económica', 'Monto total: $100.', $3::jsonb)`,
      [orgId, proposalId, sources],
    );
    await db.query(
      `insert into proposal_sections (org_id, proposal_id, section_key, title, content, sources) values ($1, $2, 'economic:anexo', 'Anexo económico', 'Desglose: $100.', $3::jsonb)`,
      [orgId, proposalId, sources],
    );
    const report = await computeAuditReport(db, orgId, tenderId, FIXED_NOW);
    expect(report.blocking).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.checkedAt).toBe(FIXED_NOW().toISOString());
  });

  it('nunca cruza organizaciones: los datos reales de orgA no afectan la auditoría de orgB para el mismo tenderId inexistente en orgB', async () => {
    const { orgId: orgA, tenderId } = await seedTenderWithMandatoryRequirement('audit-cross-org-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'audit-cross-org-b');
    const reportB = await computeAuditReport(db, orgB, tenderId, FIXED_NOW);
    expect(reportB.blocking).toEqual(['convocatoria_no_encontrada: no existe una convocatoria con este id en la organización activa']);
    // orgA sigue bloqueada por falta de sección (no afectada por la consulta cruzada de orgB).
    const reportA = await computeAuditReport(db, orgA, tenderId, FIXED_NOW);
    expect(reportA.blocking.length).toBeGreaterThan(0);
  });
});
