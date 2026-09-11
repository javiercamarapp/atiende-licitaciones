import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { FakeProvider, type ToolExecutionContext } from '@atiende/agents';
import { buildBusinessToolRegistry } from '../src/agents/business-tools.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser } from './helpers.js';

function makeCtx(organizationId: string | null): ToolExecutionContext {
  return { organizationId, actorId: 'actor-1', actorRole: 'licitador', runId: 'run-test' };
}

describe('business-tools.ts (Ronda 6): herramientas de negocio reales del worker', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
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

  /**
   * WK6-01 (docs/auditoria-2/worker-agentes.md, ALTA): la auditoría
   * adversarial "Ronda K" confirmó que quitar el filtro `org_id` de
   * `fetchTender()` no hacía fallar NINGÚN test/eval existente, porque la
   * única aserción de aislamiento de `proponer_matching` miraba
   * `status === 'ok'`, nunca el CONTENIDO real (score/explanation/
   * matchedKeywords) — exactamente donde viviría una fuga cross-org. Este
   * bloque añade, para cada una de las 8 herramientas de negocio, un test
   * DIRECTO con DOS organizaciones y datos distinguibles ("SECRETO-ORGA")
   * que verifica que el resultado de orgB NUNCA contiene título/texto/
   * evidencia real de orgA, no solo que la llamada "terminó bien". Repetir
   * la prueba de mutación de `fetchTender` (ver
   * `apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh`) debe hacer
   * fallar este bloque.
   */
  describe('aislamiento cross-org (WK6-01): el resultado de orgB nunca contiene contenido real de orgA, no solo "status: ok"', () => {
    const SECRET = 'SECRETO-ORGA';

    it('listar_convocatorias: desde el contexto de orgB nunca aparece ninguna convocatoria real de orgA (contenido distinguible, no solo el conteo)', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-listar-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-listar-b');
      await db.query(
        `insert into tenders (org_id, source, external_id, title, contracting_body) values ($1, 'dof', 'wk601-l-a', $2, $3)`,
        [orgA, `${SECRET} obra civil`, `${SECRET} Municipio`],
      );
      await db.query(
        `insert into tenders (org_id, source, external_id, title, contracting_body) values ($1, 'dof', 'wk601-l-b', 'Convocatoria pública de orgB', 'Municipio B')`,
        [orgB],
      );

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('listar_convocatorias');
      const output = (await tool.handler({}, makeCtx(orgB))) as { tenders: { title: string }[] };

      expect(output.tenders).toHaveLength(1);
      expect(output.tenders[0].title).toBe('Convocatoria pública de orgB');
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('proponer_matching: tenderId real de orgA desde el contexto de orgB -> "no evaluable" explícito, sin score ni texto de orgA', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-matching-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-matching-b');
      const tenderRow = await db.query<{ id: string }>(
        `insert into tenders (org_id, source, external_id, title, contracting_body) values ($1, 'dof', 'wk601-m', $2, $3) returning id`,
        [orgA, `${SECRET} obra civil`, `${SECRET} Municipio`],
      );
      const tenderIdOfOrgA = tenderRow.rows[0].id;
      // orgB declara una capacidad que SÍ coincidiría con el título de orgA
      // si el filtro de aislamiento fallara -- la prueba es más estricta así.
      await db.query(`insert into capabilities (org_id, name) values ($1, 'obra civil')`, [orgB]);

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('proponer_matching');
      const output = (await tool.handler({ tenderId: tenderIdOfOrgA }, makeCtx(orgB))) as {
        score: number | null;
        explanation: string;
        matchedKeywords: string[];
        missingProfileFields: string[];
      };

      expect(output.score).toBeNull();
      expect(output.matchedKeywords).toEqual([]);
      expect(output.missingProfileFields).toContain('tender');
      expect(output.explanation).toMatch(/no evaluable/i);
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('leer_bases: tenderId real de orgA desde el contexto de orgB -> documentos/requisitos vacíos, nunca los de orgA', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-bases-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-bases-b');
      const tenderRow = await db.query<{ id: string }>(
        `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'wk601-b', 'Convocatoria orgA') returning id`,
        [orgA],
      );
      const tenderIdOfOrgA = tenderRow.rows[0].id;
      await db.query(
        `insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref', $3)`,
        [orgA, tenderIdOfOrgA, `${SECRET} texto de bases`],
      );
      await db.query(
        `insert into requirement_items (org_id, tender_id, category, description) values ($1, $2, 'legal', $3)`,
        [orgA, tenderIdOfOrgA, `${SECRET} requisito`],
      );

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('leer_bases');
      const output = (await tool.handler({ tenderId: tenderIdOfOrgA }, makeCtx(orgB))) as {
        documents: unknown[];
        requirements: unknown[];
      };

      expect(output.documents).toHaveLength(0);
      expect(output.requirements).toHaveLength(0);
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('leer_perfil_empresa: nunca expone el perfil/capacidades de otra organización', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-perfil-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-perfil-b');
      await db.query(`insert into company_profiles (org_id, legal_name) values ($1, $2)`, [orgA, `${SECRET} Empresa SA de CV`]);
      await db.query(`insert into capabilities (org_id, name) values ($1, $2)`, [orgA, `${SECRET} capacidad`]);
      await db.query(`insert into company_profiles (org_id, legal_name) values ($1, 'Empresa B pública SA de CV')`, [orgB]);
      await db.query(`insert into capabilities (org_id, name) values ($1, 'obra civil')`, [orgB]);

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('leer_perfil_empresa');
      const output = (await tool.handler({}, makeCtx(orgB))) as {
        profile: { legalName: string } | null;
        capabilities: { name: string }[];
      };

      expect(output.profile?.legalName).toBe('Empresa B pública SA de CV');
      expect(output.capabilities.map((c) => c.name)).toEqual(['obra civil']);
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('proponer_requisitos_matriz: tenderId real de orgA desde el contexto de orgB -> sin candidatos, nunca el texto de orgA', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-matriz-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-matriz-b');
      const tenderRow = await db.query<{ id: string }>(
        `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'wk601-mz', 'Convocatoria orgA') returning id`,
        [orgA],
      );
      const tenderIdOfOrgA = tenderRow.rows[0].id;
      await db.query(
        `insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref', $3)`,
        [orgA, tenderIdOfOrgA, `El proveedor deberá entregar ${SECRET} certificación única vigente.`],
      );

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('proponer_requisitos_matriz');
      const output = (await tool.handler({ tenderId: tenderIdOfOrgA }, makeCtx(orgB))) as {
        proposedItems: unknown[];
      };

      expect(output.proposedItems).toHaveLength(0);
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('proponer_seccion_propuesta: nunca redacta citando experiencia real de otra organización', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-seccion-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-seccion-b');
      await db.query(
        `insert into experience_records (org_id, title, client_name, evidence_ref) values ($1, $2, $3, 'doc-orgA')`,
        [orgA, `${SECRET} Construcción de puente`, `${SECRET} Cliente`],
      );

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('proponer_seccion_propuesta');
      const output = (await tool.handler(
        { tenderId: '00000000-0000-0000-0000-000000000009', sectionKey: 'experiencia' },
        makeCtx(orgB),
      )) as { blocked: boolean; missingData: string[]; draft: string };

      // orgB no tiene su propia experience_records: bloqueado explícito,
      // NUNCA redacta citando la evidencia real de orgA.
      expect(output.blocked).toBe(true);
      expect(output.missingData).toContain('experience_records.evidence_ref');
      expect(output.draft).toBe('');
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('resumir_cambios_convocatoria: tenderId real de orgA desde el contexto de orgB -> sin eventos, nunca el resumen de orgA', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-cambios-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-cambios-b');
      const tenderRow = await db.query<{ id: string }>(
        `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'wk601-cc', 'Convocatoria orgA') returning id`,
        [orgA],
      );
      const tenderIdOfOrgA = tenderRow.rows[0].id;
      await db.query(
        `insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'amendment', $3)`,
        [orgA, tenderIdOfOrgA, `${SECRET} cambio de bases`],
      );

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('resumir_cambios_convocatoria');
      const output = (await tool.handler({ tenderId: tenderIdOfOrgA }, makeCtx(orgB))) as {
        changeEvents: unknown[];
        invalidatedCounts: { requirementItems: number; complianceItems: number; proposals: number };
      };

      expect(output.changeEvents).toHaveLength(0);
      expect(output.invalidatedCounts).toEqual({ requirementItems: 0, complianceItems: 0, proposals: 0 });
      expect(JSON.stringify(output)).not.toContain(SECRET);
    });

    it('programar_alerta: el job encolado siempre queda scoped a la organización REAL del contexto (ctx.organizationId), nunca a un tenderId ajeno pasado como input', async () => {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk601-alerta-a');
      const { orgId: orgB } = await seedOrgAndUser(db, 'wk601-alerta-b');
      const tenderRow = await db.query<{ id: string }>(
        `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'wk601-al', 'Convocatoria orgA') returning id`,
        [orgA],
      );
      const tenderIdOfOrgA = tenderRow.rows[0].id;

      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('programar_alerta');
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      const output = (await tool.handler(
        { tenderId: tenderIdOfOrgA, kind: 'vencimiento' as const, scheduledFor, message: 'vence pronto' },
        makeCtx(orgB),
      )) as { jobId: string };

      const { rows } = await db.query<{ org_id: string }>(`select org_id from jobs where id = $1`, [output.jobId]);
      expect(rows[0].org_id).toBe(orgB);
      expect(rows[0].org_id).not.toBe(orgA);
    });
  });
});

describe('REQ-032 (MinHash/LSH real, BLUEPRINT L625-627 G-11): proponer_seccion_propuesta detecta similitud entre tenants', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('CASO POSITIVO: dos tenants con la MISMA experiencia (mismo texto -> mismo borrador con FakeProvider determinista) -> el SEGUNDO se marca (collusionRisk.flagged), se regenera, y se registra un evento de cumplimiento visible SOLO para superadmin', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'req032-wt-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'req032-wt-b');
    // Texto de experiencia IDÉNTICO (y realistamente largo -- 3 registros,
    // no una frase corta) en ambas organizaciones: el escenario real que
    // REQ-032 debe detectar ("plantilla compartida" entre tenants, aunque
    // nunca hablaron entre sí a través del sistema). La longitud importa:
    // con un texto de un puñado de palabras, el propio narrativo corto que
    // añade FakeProvider (determinista, hash del prompt) al regenerar basta
    // para diluir el Jaccard estimado por debajo del umbral incluso cuando
    // el resto es idéntico -- correcto para MinHash (documentos cortos son
    // sensibles a un solo shingle distinto), pero no representativo de una
    // sección real de propuesta técnica (varias oraciones). Con 3 registros
    // (~45 palabras de "Experiencia citada") el bloque compartido domina la
    // firma y la similitud se mantiene sobre el umbral incluso tras la
    // regeneración -- verificado, no asumido (ver también el caso negativo
    // de abajo con texto igual de largo pero genuinamente distinto).
    for (const orgId of [orgA, orgB]) {
      await db.query(
        `insert into experience_records (org_id, title, client_name, evidence_ref) values
           ($1, 'Construcción de puente vehicular de dos carriles sobre el río principal del municipio', 'Gobierno del Estado', 'doc-123'),
           ($1, 'Rehabilitación integral de la red de drenaje pluvial en la zona centro de la ciudad', 'Ayuntamiento Municipal', 'doc-456'),
           ($1, 'Construcción de módulo de servicios administrativos para dependencia de gobierno estatal', 'Secretaría de Obras Públicas', 'doc-789')`,
        [orgId],
      );
    }
    const tenderA = '00000000-0000-0000-0000-0000000000a1';
    const tenderB = '00000000-0000-0000-0000-0000000000b1';

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_seccion_propuesta');

    const outputA = (await tool.handler({ tenderId: tenderA, sectionKey: 'experiencia' }, makeCtx(orgA))) as {
      blocked: boolean;
      draft: string;
      collusionRisk: { flagged: boolean; similarityScore: number; regenerated: boolean };
    };
    // Primer tenant en registrar esta huella: nada con qué compararse todavía.
    expect(outputA.blocked).toBe(false);
    expect(outputA.collusionRisk.flagged).toBe(false);
    expect(outputA.collusionRisk.regenerated).toBe(false);

    const outputB = (await tool.handler({ tenderId: tenderB, sectionKey: 'experiencia' }, makeCtx(orgB))) as {
      blocked: boolean;
      draft: string;
      collusionRisk: { flagged: boolean; similarityScore: number; regenerated: boolean };
    };
    expect(outputB.blocked).toBe(false);
    expect(outputB.collusionRisk.flagged).toBe(true);
    expect(outputB.collusionRisk.similarityScore).toBeGreaterThanOrEqual(0.75);
    expect(outputB.collusionRisk.regenerated).toBe(true);

    // El evento de cumplimiento quedó registrado -- UNA vez por cada pasada
    // que siguió marcada (la primera, y la regenerada: en este caso el
    // regenerado SIGUE por encima del umbral, así que hay 2: una con
    // `regenerated=false` -- la detección original -- y otra con
    // `regenerated=true` -- documenta que ni regenerar bastó, para que
    // cumplimiento vea el intento completo, no solo el primer aviso).
    // Verificado directamente, como propietario de las migraciones -- sin
    // pasar por RLS -- que es exactamente lo que
    // packages/db/test/req032-similarity-fingerprints.test.ts ya prueba
    // que NINGÚN tenant, ni siquiera el señalado, puede leer.
    const flags = await db.query<{ org_id: string; matched_org_id: string; regenerated: boolean }>(
      'select org_id, matched_org_id, regenerated from proposal_similarity_flags order by regenerated asc',
    );
    expect(flags.rows).toHaveLength(2);
    expect(flags.rows.every((r) => r.org_id === orgB && r.matched_org_id === orgA)).toBe(true);
    expect(flags.rows.map((r) => r.regenerated)).toEqual([false, true]);
  });

  it('CASO NEGATIVO (adversarial): dos tenants con experiencia genuinamente distinta -> nunca se marcan, nunca se regenera, sin evento de cumplimiento', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'req032-wt-neg-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'req032-wt-neg-b');
    await db.query(
      `insert into experience_records (org_id, title, client_name, evidence_ref) values ($1, 'Pavimentación asfáltica en ocho municipios de Jalisco', 'Secretaría de Comunicaciones de Jalisco', 'doc-jal-1')`,
      [orgA],
    );
    await db.query(
      `insert into experience_records (org_id, title, client_name, evidence_ref) values ($1, 'Instalación de subestación eléctrica industrial', 'Parque Industrial del Bajío', 'doc-bajio-1')`,
      [orgB],
    );

    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_seccion_propuesta');

    await tool.handler({ tenderId: '00000000-0000-0000-0000-0000000000c1', sectionKey: 'experiencia' }, makeCtx(orgA));
    const outputB = (await tool.handler(
      { tenderId: '00000000-0000-0000-0000-0000000000c2', sectionKey: 'experiencia' },
      makeCtx(orgB),
    )) as { collusionRisk: { flagged: boolean; regenerated: boolean } };

    expect(outputB.collusionRisk.flagged).toBe(false);
    expect(outputB.collusionRisk.regenerated).toBe(false);

    const flags = await db.query('select id from proposal_similarity_flags');
    expect(flags.rows).toHaveLength(0);
  });

  it('una sección BLOQUEADA por falta de evidencia nunca se evalúa ni se marca por similitud (collusionRisk neutro, sin llegar a generar huella)', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'req032-wt-blocked');
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_seccion_propuesta');

    const output = (await tool.handler(
      { tenderId: '00000000-0000-0000-0000-0000000000d1', sectionKey: 'experiencia' },
      makeCtx(orgA),
    )) as { blocked: boolean; collusionRisk: { flagged: boolean; similarityScore: number; regenerated: boolean } };

    expect(output.blocked).toBe(true);
    expect(output.collusionRisk).toEqual({ flagged: false, similarityScore: 0, regenerated: false });

    const fingerprints = await db.query('select id from proposal_section_fingerprints');
    expect(fingerprints.rows).toHaveLength(0);
  });

  it('el mismo tenant reutilizando su propia experiencia en OTRA convocatoria nunca se marca contra sí mismo (no es "entre tenants")', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'req032-wt-self');
    await db.query(
      `insert into experience_records (org_id, title, client_name, evidence_ref) values ($1, 'Construcción de puente vehicular', 'Gobierno del Estado', 'doc-123')`,
      [orgA],
    );
    const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
    const tool = registry.get('proponer_seccion_propuesta');

    await tool.handler({ tenderId: '00000000-0000-0000-0000-0000000000e1', sectionKey: 'experiencia' }, makeCtx(orgA));
    const second = (await tool.handler(
      { tenderId: '00000000-0000-0000-0000-0000000000e2', sectionKey: 'experiencia' },
      makeCtx(orgA),
    )) as { collusionRisk: { flagged: boolean } };

    expect(second.collusionRisk.flagged).toBe(false);
  });
});
