import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedUser, seedTender, asActor } from './helpers.js';

/**
 * Ronda 6 (E11, apps/api), REQ-057/058: aislamiento multi-tenant (RLS) de
 * las tablas nuevas de esta ronda para REQ-051..055 (0065/0067/0068/0069/
 * 0070): `contracts`, `contract_status_history`, `contract_documents`,
 * `contract_extracted_fields`, `inconformidad_drafts`, `fallo_autopsies`,
 * `company_lessons_learned`, `renewal_alerts`. Cada tabla tiene al menos
 * una prueba NEGATIVA (tolerancia cero, REQ-057): un actor de otra
 * organización, o sin membresía alguna, nunca ve ni modifica una fila
 * ajena.
 */
describe('ronda 6 — aislamiento multi-tenant de las tablas de post-adjudicación avanzada', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('contracts: un owner de la organización A no ve ni transiciona el contrato de la organización B; un usuario sin membresía tampoco', async () => {
    const orgA = await seedOrg(db, 'r6-org-a-contracts');
    const orgB = await seedOrg(db, 'r6-org-b-contracts');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-contracts@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-contracts@example.com', 'owner');
    const outsider = await seedUser(db, 'outsider-contracts@example.com');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-contracts');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-contracts');

    const { rows: rowsA } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id, status) values ($1, $2, $3) returning id', [orgA.orgId, tenderA, 'adjudicado']);
    const { rows: rowsB } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id, status) values ($1, $2, $3) returning id', [orgB.orgId, tenderB, 'adjudicado']);

    const seenByA = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from contracts where id in ($1, $2)', [rowsA[0].id, rowsB[0].id]));
    expect(seenByA.rows.map((r) => r.id)).toEqual([rowsA[0].id]);

    const updateAttempt = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query("update contracts set status = 'rescindido' where id = $1", [rowsB[0].id]));
    expect(updateAttempt.rowCount).toBe(0);

    // Sin membresía en NINGUNA organización -- `app.current_org_id()` no resuelve una org real, RLS deniega todo.
    await expect(asActor(db, { orgId: orgA.orgId, userId: outsider }, (tx) => tx.query('select id from contracts where id = $1', [rowsA[0].id]))).resolves.toMatchObject({
      rows: [],
    });
  });

  it('contract_status_history: aislado por organización, y es INMUTABLE incluso para el propio dueño (sin política de UPDATE/DELETE)', async () => {
    const orgA = await seedOrg(db, 'r6-org-a-transitions');
    const orgB = await seedOrg(db, 'r6-org-b-transitions');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-transitions@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-transitions@example.com', 'owner');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-transitions');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-transitions');
    const { rows: contractA } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id) values ($1, $2) returning id', [orgA.orgId, tenderA]);
    const { rows: contractB } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id) values ($1, $2) returning id', [orgB.orgId, tenderB]);

    const { rows: transitionB } = await db.query<{ id: string }>(
      "insert into contract_status_history (org_id, contract_id, from_status, to_status, reason) values ($1, $2, 'adjudicado', 'contrato_firmado_declarado', 'firma') returning id",
      [orgB.orgId, contractB[0].id]
    );

    const seenByA = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from contract_status_history where id = $1', [transitionB[0].id]));
    expect(seenByA.rows).toEqual([]);

    // Inmutabilidad: incluso dentro de la organización dueña, ni UPDATE ni DELETE tienen política -- RLS deniega ambos.
    const ownTransition = await db.query<{ id: string }>(
      "insert into contract_status_history (org_id, contract_id, from_status, to_status, reason) values ($1, $2, 'adjudicado', 'contrato_firmado_declarado', 'firma') returning id",
      [orgA.orgId, contractA[0].id]
    );
    const updateAttempt = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query("update contract_status_history set reason = 'manipulado' where id = $1", [ownTransition.rows[0].id]));
    expect(updateAttempt.rowCount).toBe(0);
    const deleteAttempt = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('delete from contract_status_history where id = $1', [ownTransition.rows[0].id]));
    expect(deleteAttempt.rowCount).toBe(0);
  });

  it('contract_documents y contract_extracted_fields: aislados por organización', async () => {
    const orgA = await seedOrg(db, 'r6-org-a-docs');
    const orgB = await seedOrg(db, 'r6-org-b-docs');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-docs@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-docs@example.com', 'owner');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-docs');
    const { rows: contractB } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id) values ($1, $2) returning id', [orgB.orgId, tenderB]);
    const { rows: docB } = await db.query<{ id: string }>(
      "insert into contract_documents (org_id, contract_id, storage_ref, file_hash, text_extraction_status) values ($1, $2, 'ref', 'hash', 'extracted') returning id",
      [orgB.orgId, contractB[0].id]
    );
    const { rows: fieldB } = await db.query<{ id: string }>(
      "insert into contract_extracted_fields (org_id, contract_document_id, field_key, extracted_value, confidence) values ($1, $2, 'numero_contrato', 'X-1', 0.8) returning id",
      [orgB.orgId, docB[0].id]
    );

    const seenDocs = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from contract_documents where id = $1', [docB[0].id]));
    expect(seenDocs.rows).toEqual([]);
    const seenFields = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from contract_extracted_fields where id = $1', [fieldB[0].id]));
    expect(seenFields.rows).toEqual([]);
    const confirmAttempt = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query("update contract_extracted_fields set status = 'confirmado' where id = $1", [fieldB[0].id])
    );
    expect(confirmAttempt.rowCount).toBe(0);
  });

  it('inconformidad_drafts: aislado por organización y el contenido es inmutable incluso para el propio dueño', async () => {
    const orgA = await seedOrg(db, 'r6-org-a-inconformidad');
    const orgB = await seedOrg(db, 'r6-org-b-inconformidad');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-inconformidad@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-inconformidad@example.com', 'owner');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-inconformidad');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-inconformidad');

    const insertDraft = (orgId: string, tenderId: string) =>
      db.query<{ id: string }>(
        `insert into inconformidad_drafts
           (org_id, tender_id, version, content_hash, hechos, agravios, fundamentos, fallo_notified_on, dias_habiles, fecha_limite, fundamento_legal_plazo, viability, viability_recommendation, disclaimer)
         values ($1, $2, 1, 'hash', '{h1}', '{a1}', '[]'::jsonb, '2026-01-05', 6, '2026-01-13', 'Art. 95', 'alta', 'ok', 'BORRADOR') returning id`,
        [orgId, tenderId]
      );
    const draftA = await insertDraft(orgA.orgId, tenderA);
    const draftB = await insertDraft(orgB.orgId, tenderB);

    const seenByA = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from inconformidad_drafts where id in ($1, $2)', [draftA.rows[0].id, draftB.rows[0].id]));
    expect(seenByA.rows.map((r) => r.id)).toEqual([draftA.rows[0].id]);

    const crossReview = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query("update inconformidad_drafts set status = 'revisado' where id = $1", [draftB.rows[0].id]));
    expect(crossReview.rowCount).toBe(0);

    // Inmutabilidad del contenido (trigger, migración 0068): ni siquiera el propio dueño puede editar `hechos`.
    await expect(
      asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('update inconformidad_drafts set hechos = $1 where id = $2', [['manipulado'], draftA.rows[0].id]))
    ).rejects.toThrow();
  });

  it('fallo_autopsies y company_lessons_learned: aislados por organización', async () => {
    const orgA = await seedOrg(db, 'r6-org-a-autopsy');
    const orgB = await seedOrg(db, 'r6-org-b-autopsy');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-autopsy@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-autopsy@example.com', 'owner');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-autopsy');
    const { rows: autopsyB } = await db.query<{ id: string }>(
      "insert into fallo_autopsies (org_id, tender_id, disqualification_reason, winner_name) values ($1, $2, 'no disponible', 'no disponible') returning id",
      [orgB.orgId, tenderB]
    );
    const { rows: lessonB } = await db.query<{ id: string }>(
      "insert into company_lessons_learned (org_id, fallo_autopsy_id, tender_id, lesson_text) values ($1, $2, $3, 'lección B') returning id",
      [orgB.orgId, autopsyB[0].id, tenderB]
    );

    const seenAutopsy = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from fallo_autopsies where id = $1', [autopsyB[0].id]));
    expect(seenAutopsy.rows).toEqual([]);
    const seenLesson = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from company_lessons_learned where id = $1', [lessonB[0].id]));
    expect(seenLesson.rows).toEqual([]);
  });

  it('renewal_alerts: aislado por organización', async () => {
    const orgA = await seedOrg(db, 'r6-org-a-renewals');
    const orgB = await seedOrg(db, 'r6-org-b-renewals');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-renewals@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-renewals@example.com', 'owner');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-renewals');
    const { rows: contractB } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id, end_date) values ($1, $2, current_date + 10) returning id', [orgB.orgId, tenderB]);
    const { rows: alertB } = await db.query<{ id: string }>(
      "insert into renewal_alerts (org_id, contract_id, tender_id, source_kind, predicted_date, lead_days, confidence, notes) values ($1, $2, $3, 'contract_end_date', current_date + 10, 30, 0.9, 'nota') returning id",
      [orgB.orgId, contractB[0].id, tenderB]
    );

    const seenByA = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select id from renewal_alerts where id = $1', [alertB[0].id]));
    expect(seenByA.rows).toEqual([]);
  });

  it('viewer puede LEER contratos/inconformidades/autopsias/alertas de su organización pero no puede escribir', async () => {
    const org = await seedOrg(db, 'r6-org-viewer');
    const viewer = await seedMember(db, org.orgId, 'viewer-r6@example.com', 'viewer');
    const tender = await seedTender(db, org.orgId, 'ext-viewer-r6');
    const { rows: contract } = await db.query<{ id: string }>('insert into contracts (org_id, tender_id) values ($1, $2) returning id', [org.orgId, tender]);

    const read = await asActor(db, { orgId: org.orgId, userId: viewer }, (tx) => tx.query('select id from contracts where id = $1', [contract[0].id]));
    expect(read.rows.map((r) => r.id)).toEqual([contract[0].id]);

    const write = await asActor(db, { orgId: org.orgId, userId: viewer }, (tx) => tx.query("update contracts set status = 'rescindido' where id = $1", [contract[0].id]));
    expect(write.rowCount).toBe(0);
  });
});
