import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedTender, asActor } from './helpers.js';

/**
 * REQ-035 ("Cada dato renderizado en la propuesta lleva procedencia
 * (`proposal_facts` con fuente, doc_id, página)", tolerancia cero).
 *
 * Estas pruebas cubren la tabla a nivel de esquema (constraints reales, no
 * solo validación en la capa de aplicación -- ver 0099_req035_proposal_
 * facts.sql). El aislamiento multi-tenant genérico (RLS) para esta tabla ya
 * está cubierto por `rls-isolation.test.ts` vía `DOMAIN_TABLES`.
 *
 * El caso de uso real de escritura (wiring desde `TechnicalProposalBuilder`/
 * `EconomicProposalBuilder`) se prueba de punta a punta en
 * `apps/api/test/expediente-proposal.test.ts`, que es donde existen
 * `SourceRef` reales producidos por el pipeline de generación.
 */
describe('REQ-035: tabla proposal_facts -- procedencia obligatoria a nivel de esquema', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedProposal(slug: string) {
    const org = await seedOrg(db, slug);
    const ownerId = await seedMember(db, org.orgId, `owner-${slug}@example.com`, 'owner');
    const tenderId = await seedTender(db, org.orgId, `ext-${slug}`);
    const proposal = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>("insert into proposals (org_id, tender_id, title) values ($1, $2, 'P') returning id", [
        org.orgId,
        tenderId,
      ])
    );
    return { org, ownerId, proposalId: proposal.rows[0].id };
  }

  it('un hecho de tipo "clause" (cita de las bases) SÍ requiere página -- sin ella, Postgres rechaza la fila', async () => {
    const { org, ownerId, proposalId } = await seedProposal('facts-clause-sin-pagina');

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
           values ($1, $2, 'technical:req-1:0', 'technical:req-1', 'texto', 'clause', 'bases.pdf')`,
          [org.orgId, proposalId]
        )
      )
    ).rejects.toThrow(/chk_proposal_facts_page_matches_kind/);
  });

  it('un hecho de tipo "company_data" (dato interno ya aprobado) NUNCA debe declarar página -- se rechaza si la trae', async () => {
    const { org, ownerId, proposalId } = await seedProposal('facts-company-data-con-pagina');

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id, page)
           values ($1, $2, 'technical:req-1:0', 'technical:req-1', 'texto', 'company_data', 'capacidad-123', 5)`,
          [org.orgId, proposalId]
        )
      )
    ).rejects.toThrow(/chk_proposal_facts_page_matches_kind/);
  });

  it('"campo sin sources = bug": un doc_id vacío o solo espacios se rechaza a nivel de esquema, nunca se persiste un hecho sin fuente real', async () => {
    const { org, ownerId, proposalId } = await seedProposal('facts-doc-id-vacio');

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
           values ($1, $2, 'technical:req-1:0', 'technical:req-1', 'texto', 'company_data', '   ')`,
          [org.orgId, proposalId]
        )
      )
    ).rejects.toThrow(/chk_proposal_facts_doc_id_not_blank/);

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
           values ($1, $2, 'technical:req-1:1', 'technical:req-1', 'texto', 'company_data', null)`,
          [org.orgId, proposalId]
        )
      )
    ).rejects.toThrow(/null value in column "doc_id"/);
  });

  it('un hecho con fuente completa y válida (clause con página, company_data sin página) se persiste correctamente', async () => {
    const { org, ownerId, proposalId } = await seedProposal('facts-validos');

    const clauseFact = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string; page: number }>(
        `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id, page, clause)
         values ($1, $2, 'technical:req-1:0', 'technical:req-1', 'Debe acreditar 5 años de experiencia.', 'clause', 'bases.pdf', 12, 'Anexo 3')
         returning id, page`,
        [org.orgId, proposalId]
      )
    );
    expect(clauseFact.rows[0].page).toBe(12);

    const companyDataFact = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string; page: number | null }>(
        `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id, captured_at)
         values ($1, $2, 'economic:hora-consultoria', 'economic:anexo', '8500.00', 'company_data', 'rate-uuid-123', '2026-01-01')
         returning id, page`,
        [org.orgId, proposalId]
      )
    );
    expect(companyDataFact.rows[0].page).toBeNull();
  });

  it('regenerar el mismo hecho (mismo fact_key) reemplaza la fila anterior -- unique(org_id, proposal_id, fact_key) fuerza upsert, no duplicados', async () => {
    const { org, ownerId, proposalId } = await seedProposal('facts-regeneracion');

    await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
         values ($1, $2, 'economic:hora-consultoria', 'economic:anexo', '8500.00', 'company_data', 'rate-v1')`,
        [org.orgId, proposalId]
      )
    );

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
           values ($1, $2, 'economic:hora-consultoria', 'economic:anexo', '9000.00', 'company_data', 'rate-v2')`,
          [org.orgId, proposalId]
        )
      )
    ).rejects.toThrow(/duplicate key value/);

    const upserted = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ rendered_value: string; doc_id: string }>(
        `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
         values ($1, $2, 'economic:hora-consultoria', 'economic:anexo', '9000.00', 'company_data', 'rate-v2')
         on conflict (org_id, proposal_id, fact_key) do update set rendered_value = excluded.rendered_value, doc_id = excluded.doc_id
         returning rendered_value, doc_id`,
        [org.orgId, proposalId]
      )
    );
    expect(upserted.rows[0].rendered_value).toBe('9000.00');
    expect(upserted.rows[0].doc_id).toBe('rate-v2');

    const all = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select id from proposal_facts where org_id = $1 and proposal_id = $2', [org.orgId, proposalId])
    );
    expect(all.rows.length).toBe(1);
  });

  it('viewer no puede insertar un hecho (rol de solo lectura); writer sí', async () => {
    const { org, proposalId } = await seedProposal('facts-rol-viewer');
    const viewerId = await seedMember(db, org.orgId, 'viewer-facts@example.com', 'viewer');
    const writerId = await seedMember(db, org.orgId, 'writer-facts@example.com', 'writer');

    await expect(
      asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
        tx.query(
          `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
           values ($1, $2, 'economic:x', 'economic:anexo', '1', 'company_data', 'rate-1')`,
          [org.orgId, proposalId]
        )
      )
    ).rejects.toThrow(/row-level security/i);

    const writerOk = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query<{ id: string }>(
        `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id)
         values ($1, $2, 'economic:x', 'economic:anexo', '1', 'company_data', 'rate-1') returning id`,
        [org.orgId, proposalId]
      )
    );
    expect(writerOk.rows.length).toBe(1);
  });
});
