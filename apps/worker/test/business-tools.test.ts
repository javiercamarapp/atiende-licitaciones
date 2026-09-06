import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { FakeProvider, type ToolExecutionContext } from '@atiende/agents';
import { buildBusinessToolRegistry } from '../src/agents/business-tools.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser } from './helpers.js';
import { applyProposal06 } from './proposal-06-helper.js';

function makeCtx(organizationId: string | null): ToolExecutionContext {
  return { organizationId, actorId: 'actor-1', actorRole: 'licitador', runId: 'run-test' };
}

describe('business-tools.ts (Ronda 6): herramientas de negocio reales del worker', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    await applyProposal06(db);
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('registra las 8 herramientas con actionKind/declaredEffects consistentes (nunca external_send/sign/portal_action/contact_third_party)', () => {
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const names = registry.list().map((t) => t.name).sort();
    expect(names).toEqual([
      'leer_bases',
      'leer_perfil_empresa',
      'listar_convocatorias',
      'programar_alerta',
      'proponer_matching',
      'proponer_requisitos_matriz',
      'proponer_seccion_propuesta',
      'resumir_cambios_convocatoria',
    ]);
    for (const tool of registry.list()) {
      expect(['read', 'write']).toContain(tool.actionKind);
      expect(tool.declaredEffects.every((e) => e === 'read_only' || e === 'internal_write')).toBe(true);
    }
  });

  it('ninguna de las 8 herramientas acepta organizationId/orgId/tenantId del modelo: el esquema los descarta silenciosamente, nunca llegan al handler', () => {
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const forbiddenInjection = { organizationId: 'org-evil', org_id: 'org-evil-2', tenantId: 'tenant-evil' };
    const sampleInputByTool: Record<string, unknown> = {
      listar_convocatorias: {},
      leer_bases: { tenderId: '00000000-0000-0000-0000-000000000001' },
      leer_perfil_empresa: {},
      proponer_matching: { tenderId: '00000000-0000-0000-0000-000000000001' },
      proponer_requisitos_matriz: { tenderId: '00000000-0000-0000-0000-000000000001' },
      proponer_seccion_propuesta: { tenderId: '00000000-0000-0000-0000-000000000001', sectionKey: 'experiencia' },
      resumir_cambios_convocatoria: { tenderId: '00000000-0000-0000-0000-000000000001' },
      programar_alerta: {
        tenderId: '00000000-0000-0000-0000-000000000001',
        kind: 'vencimiento',
        scheduledFor: new Date().toISOString(),
        message: 'x',
      },
    };
    for (const tool of registry.list()) {
      const input = { ...(sampleInputByTool[tool.name] as Record<string, unknown>), ...forbiddenInjection };
      const parsed = registry.validateInput(tool.name, input) as Record<string, unknown>;
      expect(parsed).not.toHaveProperty('organizationId');
      expect(parsed).not.toHaveProperty('org_id');
      expect(parsed).not.toHaveProperty('tenantId');
    }
  });

  it('listar_convocatorias: lee SOLO las convocatorias de la organización del contexto, nunca de otra', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'bt-listar-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'bt-listar-b');
    await db.query(`insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'a1', 'Convocatoria A')`, [orgA]);
    await db.query(`insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'b1', 'Convocatoria B')`, [orgB]);

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('listar_convocatorias');
    const output = (await tool.handler({}, makeCtx(orgA))) as { tenders: { title: string }[] };
    expect(output.tenders).toHaveLength(1);
    expect(output.tenders[0].title).toBe('Convocatoria A');
  });

  it('leer_bases: expone documentos/requisitos ya extraídos, con sourcePage/sourceExcerpt reales (no fabricados)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-leer-bases');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 't1', 'Convocatoria X') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;
    await db.query(
      `insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text, page_count) values ($1, $2, 'bases', 'ref-1', 'texto extraído real', 10)`,
      [orgId, tenderId],
    );
    await db.query(
      `insert into requirement_items (org_id, tender_id, category, description, is_mandatory, source_page, source_excerpt) values ($1, $2, 'legal', 'Presentar RFC vigente', true, 3, 'Deberá presentar RFC vigente')`,
      [orgId, tenderId],
    );

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('leer_bases');
    const output = (await tool.handler({ tenderId }, makeCtx(orgId))) as {
      documents: { hasExtractedText: boolean }[];
      requirements: { sourcePage: number | null; description: string }[];
    };
    expect(output.documents).toHaveLength(1);
    expect(output.documents[0].hasExtractedText).toBe(true);
    expect(output.requirements).toHaveLength(1);
    expect(output.requirements[0].sourcePage).toBe(3);
    expect(output.requirements[0].description).toBe('Presentar RFC vigente');
  });

  it('leer_perfil_empresa: lee perfil/capacidades/experiencia reales de la organización', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-leer-perfil');
    await db.query(`insert into company_profiles (org_id, legal_name, sector) values ($1, 'Empresa X SA de CV', 'construccion')`, [orgId]);
    await db.query(`insert into capabilities (org_id, name, is_verified) values ($1, 'obra civil', true)`, [orgId]);

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('leer_perfil_empresa');
    const output = (await tool.handler({}, makeCtx(orgId))) as {
      profile: { legalName: string } | null;
      capabilities: { name: string }[];
    };
    expect(output.profile?.legalName).toBe('Empresa X SA de CV');
    expect(output.capabilities.map((c) => c.name)).toContain('obra civil');
  });

  it('proponer_matching: score y palabras coincidentes derivados de datos reales, nunca inventados; sin capacidades -> missingProfileFields', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-matching');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, contracting_body) values ($1, 'dof', 't2', 'Obra civil de pavimentación', 'Municipio X') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_matching');

    const withoutCapabilities = (await tool.handler({ tenderId }, makeCtx(orgId))) as { score: number | null; missingProfileFields: string[] };
    expect(withoutCapabilities.missingProfileFields).toContain('capabilities');
    expect(withoutCapabilities.score).toBeNull();

    await db.query(`insert into capabilities (org_id, name) values ($1, 'obra civil')`, [orgId]);
    const withCapabilities = (await tool.handler({ tenderId }, makeCtx(orgId))) as {
      score: number | null;
      matchedKeywords: string[];
    };
    expect(withCapabilities.matchedKeywords).toContain('obra civil');
    expect(withCapabilities.score).toBe(100);
  });

  it('proponer_requisitos_matriz: extrae candidatos REALES del texto ya extraído, sin inventar número de página', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-matriz');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 't3', 'Convocatoria matriz') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;
    await db.query(
      `insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref-2', $3)`,
      [orgId, tenderId, 'El proveedor deberá entregar certificación ISO 9001 vigente. Este texto es irrelevante y corto.'],
    );

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_requisitos_matriz');
    const output = (await tool.handler({ tenderId }, makeCtx(orgId))) as {
      proposedItems: { description: string; sourcePage: null; sourcePageReason: string; isMandatory: boolean }[];
    };
    expect(output.proposedItems.length).toBeGreaterThan(0);
    expect(output.proposedItems[0].sourcePage).toBeNull();
    expect(output.proposedItems[0].sourcePageReason).toMatch(/no tiene desglose por página/);
    expect(output.proposedItems[0].isMandatory).toBe(true);
    expect(output.proposedItems[0].description).toContain('certificación ISO 9001');
  });

  it('proponer_seccion_propuesta: bloquea explícitamente si no hay evidencia aprobada (nunca inventa el dato)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-seccion-bloqueada');
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_seccion_propuesta');
    const output = (await tool.handler(
      { tenderId: '00000000-0000-0000-0000-000000000009', sectionKey: 'experiencia' },
      makeCtx(orgId),
    )) as { blocked: boolean; missingData: string[]; draft: string };
    expect(output.blocked).toBe(true);
    expect(output.missingData).toContain('experience_records.evidence_ref');
    expect(output.draft).toBe('');
  });

  it('proponer_seccion_propuesta: redacta un borrador citando experiencia REAL con evidencia', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-seccion-ok');
    await db.query(
      `insert into experience_records (org_id, title, client_name, evidence_ref) values ($1, 'Construcción de puente', 'Gobierno del Estado', 'doc-123')`,
      [orgId],
    );
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_seccion_propuesta');
    const output = (await tool.handler(
      { tenderId: '00000000-0000-0000-0000-000000000009', sectionKey: 'experiencia' },
      makeCtx(orgId),
    )) as { blocked: boolean; draft: string };
    expect(output.blocked).toBe(false);
    expect(output.draft).toContain('Construcción de puente');
  });

  it('resumir_cambios_convocatoria: resume eventos reales y cuenta invalidaciones reales', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-resumen-cambios');
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 't4', 'Convocatoria con cambios') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;
    await db.query(
      `insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'deadline_change', 'Se recorrió el plazo 5 días')`,
      [orgId, tenderId],
    );
    // El trigger app.invalidate_tender_dependents (0022) ya marca requirement_items/compliance_items/proposals
    // como invalidados al insertar tender_change_events -- pero solo si ya existían filas previas para ese tender.
    await db.query(
      `insert into requirement_items (org_id, tender_id, category, description) values ($1, $2, 'legal', 'Requisito viejo')`,
      [orgId, tenderId],
    );
    await db.query(
      `insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'amendment', 'Nueva acta de aclaraciones')`,
      [orgId, tenderId],
    );

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('resumir_cambios_convocatoria');
    const output = (await tool.handler({ tenderId }, makeCtx(orgId))) as {
      changeEvents: { changeKind: string }[];
      invalidatedCounts: { requirementItems: number };
    };
    expect(output.changeEvents.length).toBe(2);
    expect(output.invalidatedCounts.requirementItems).toBe(1);
  });

  it('programar_alerta: encola un job real (send_agent_alert) en la tabla jobs, deduplicado por (tenderId, kind, scheduledFor)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'bt-alerta');
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('programar_alerta');
    const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const input = { tenderId: '00000000-0000-0000-0000-000000000009', kind: 'vencimiento' as const, scheduledFor, message: 'vence pronto' };

    const first = (await tool.handler(input, makeCtx(orgId))) as { jobId: string; deduped: boolean };
    expect(first.deduped).toBe(false);
    const second = (await tool.handler(input, makeCtx(orgId))) as { jobId: string; deduped: boolean };
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(first.jobId);

    const { rows } = await db.query<{ kind: string }>(`select kind from jobs where id = $1`, [first.jobId]);
    expect(rows[0].kind).toBe('send_agent_alert');
  });
});
