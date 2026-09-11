import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient, DbExecutor } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedSuperadmin, seedTender, asActor } from './helpers.js';

/**
 * REQ-032 (BLUEPRINT L625-627, G-11): esquema de datos del detector real de
 * similitud MinHash entre tenants. Estas pruebas cubren, contra Postgres
 * real (PGlite), las 3 garantías de las que depende la lógica de negocio de
 * `@atiende/agents` `CrossTenantSimilarityDetector`:
 *
 *  1) `proposal_section_fingerprints`: un tenant normal (app_role) SOLO ve
 *     sus propias huellas (RLS estándar) -- pero `worker_role` SÍ puede
 *     leer huellas de CUALQUIER organización (necesario para comparar
 *     entre tenants), acotado únicamente por identidad de conexión.
 *  2) `proposal_similarity_flags`: NINGÚN miembro de organización (ni
 *     siquiera el owner de la organización SEÑALADA por el evento) puede
 *     leerla -- solo superadmin. Esto es intencional: evita que un tenant
 *     descubra la identidad de con qué competidor coincidió.
 *  3) Un tenant normal (app_role) nunca puede INSERTAR un evento de
 *     similitud él mismo (solo `worker_role`, el sistema) -- evita que un
 *     tenant fabrique una acusación de colusión contra un competidor.
 */

async function runAsWorkerRole<T>(db: DbClient, orgId: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role worker_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
    return fn(tx);
  });
}

describe('REQ-032: proposal_section_fingerprints -- RLS real', () => {
  let db: DbClient;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('un tenant normal (app_role) solo ve SU PROPIA huella, nunca la de otro tenant', async () => {
    const orgA = await seedOrg(db, 'req032-a');
    const orgB = await seedOrg(db, 'req032-b');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a@req032.test', 'owner');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-req032');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-req032');

    await db.query(
      `insert into proposal_section_fingerprints (org_id, tender_id, section_key, algorithm_version, signature, band_hashes, shingle_count)
       values ($1, $2, 'experiencia', 1, '{1,2,3}', '{"0:1"}', 3)`,
      [orgA.orgId, tenderA],
    );
    await db.query(
      `insert into proposal_section_fingerprints (org_id, tender_id, section_key, algorithm_version, signature, band_hashes, shingle_count)
       values ($1, $2, 'experiencia', 1, '{4,5,6}', '{"0:1"}', 3)`,
      [orgB.orgId, tenderB],
    );

    const seen = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query('select org_id from proposal_section_fingerprints'),
    );
    expect(seen.rows).toHaveLength(1);
    expect((seen.rows[0] as { org_id: string }).org_id).toBe(orgA.orgId);
  });

  it('worker_role SÍ puede leer huellas de OTRA organización (necesario para comparar entre tenants) -- solo huellas, nunca contenido (la tabla no tiene columna de texto)', async () => {
    const orgA = await seedOrg(db, 'req032-worker-a');
    const orgB = await seedOrg(db, 'req032-worker-b');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-worker');

    await db.query(
      `insert into proposal_section_fingerprints (org_id, tender_id, section_key, algorithm_version, signature, band_hashes, shingle_count)
       values ($1, $2, 'experiencia', 1, '{9,9,9}', '{"0:999"}', 3)`,
      [orgA.orgId, tenderA],
    );

    // orgB (worker_role actuando "como" orgB) busca candidatos que compartan la banda "0:999" -- debe ENCONTRAR la fila de orgA.
    const candidates = await runAsWorkerRole(db, orgB.orgId, (tx) =>
      tx.query<{ org_id: string; signature: number[] }>(
        `select org_id, signature from proposal_section_fingerprints where org_id <> $1 and band_hashes && $2::text[]`,
        [orgB.orgId, ['0:999']],
      ),
    );
    expect(candidates.rows).toHaveLength(1);
    expect(candidates.rows[0].org_id).toBe(orgA.orgId);
    // La fila devuelta jamás trae una columna de texto/contenido -- la tabla física no la tiene (verificado también a nivel de esquema abajo).
    expect(Object.keys(candidates.rows[0]).sort()).toEqual(['org_id', 'signature']);
  });

  it('la tabla de huellas NUNCA tiene una columna de texto libre (garantía estructural de "sin cruzar contenido")', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns where table_name = 'proposal_section_fingerprints'`,
    );
    const textColumns = rows.filter((r) => r.data_type === 'text' && r.column_name !== 'section_key');
    // `section_key` es una clave corta interna ("experiencia", "legal", ...), no contenido de la propuesta.
    expect(textColumns).toEqual([]);
  });

  it('worker_role NO puede insertar una huella a nombre de una organización distinta a app.current_org_id (defensa en profundidad)', async () => {
    const orgA = await seedOrg(db, 'req032-defense-a');
    const orgB = await seedOrg(db, 'req032-defense-b');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-defense-b');

    await expect(
      runAsWorkerRole(db, orgA.orgId, (tx) =>
        tx.query(
          `insert into proposal_section_fingerprints (org_id, tender_id, section_key, algorithm_version, signature, band_hashes, shingle_count)
           values ($1, $2, 'experiencia', 1, '{1}', '{"0:1"}', 1)`,
          [orgB.orgId, tenderB],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('REQ-032: proposal_similarity_flags -- visibilidad EXCLUSIVA de superadmin', () => {
  let db: DbClient;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('ni el owner de la organización SEÑALADA ni el de la organización CON LA QUE COINCIDIÓ pueden ver el evento -- solo superadmin', async () => {
    const orgFlagged = await seedOrg(db, 'req032-flagged');
    const orgMatched = await seedOrg(db, 'req032-matched');
    const tenderFlagged = await seedTender(db, orgFlagged.orgId, 'ext-flagged');
    const tenderMatched = await seedTender(db, orgMatched.orgId, 'ext-matched');
    const ownerFlagged = await seedMember(db, orgFlagged.orgId, 'owner-flagged@req032.test', 'owner');
    const ownerMatched = await seedMember(db, orgMatched.orgId, 'owner-matched@req032.test', 'owner');
    const superadmin = await seedSuperadmin(db, 'superadmin@req032.test');

    await runAsWorkerRole(db, orgFlagged.orgId, (tx) =>
      tx.query(
        `insert into proposal_similarity_flags (org_id, tender_id, section_key, similarity, matched_org_id, matched_tender_id, matched_section_key, regenerated)
         values ($1, $2, 'experiencia', 0.91, $3, $4, 'experiencia', true)`,
        [orgFlagged.orgId, tenderFlagged, orgMatched.orgId, tenderMatched],
      ),
    );

    const seenByFlagged = await asActor(db, { orgId: orgFlagged.orgId, userId: ownerFlagged }, (tx) =>
      tx.query('select id from proposal_similarity_flags'),
    );
    expect(seenByFlagged.rows).toHaveLength(0);

    const seenByMatched = await asActor(db, { orgId: orgMatched.orgId, userId: ownerMatched }, (tx) =>
      tx.query('select id from proposal_similarity_flags'),
    );
    expect(seenByMatched.rows).toHaveLength(0);

    const seenBySuperadmin = await asActor(db, { userId: superadmin }, (tx) => tx.query('select id, matched_org_id from proposal_similarity_flags'));
    expect(seenBySuperadmin.rows).toHaveLength(1);
  });

  it('ATAQUE: un tenant normal (app_role) no puede INSERTAR su propio evento de similitud (evita fabricar una acusación de colusión contra un competidor)', async () => {
    const orgA = await seedOrg(db, 'req032-attack-a');
    const orgB = await seedOrg(db, 'req032-attack-b');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-attack-a@req032.test', 'owner');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-attack-a');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-attack-b');

    await expect(
      asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
        tx.query(
          `insert into proposal_similarity_flags (org_id, tender_id, section_key, similarity, matched_org_id, matched_tender_id, matched_section_key, regenerated)
           values ($1, $2, 'experiencia', 0.99, $3, $4, 'experiencia', false)`,
          [orgA.orgId, tenderA, orgB.orgId, tenderB],
        ),
      ),
    ).rejects.toThrow();
  });

  it('append-only: nadie (ni superadmin) puede UPDATE/DELETE un evento ya registrado vía RLS', async () => {
    const orgFlagged = await seedOrg(db, 'req032-append-only');
    const orgMatched = await seedOrg(db, 'req032-append-only-matched');
    const tenderFlagged = await seedTender(db, orgFlagged.orgId, 'ext-append-flagged');
    const tenderMatched = await seedTender(db, orgMatched.orgId, 'ext-append-matched');
    const superadmin = await seedSuperadmin(db, 'superadmin-append@req032.test');

    const inserted = await runAsWorkerRole(db, orgFlagged.orgId, (tx) =>
      tx.query<{ id: string }>(
        `insert into proposal_similarity_flags (org_id, tender_id, section_key, similarity, matched_org_id, matched_tender_id, matched_section_key, regenerated)
         values ($1, $2, 'experiencia', 0.8, $3, $4, 'experiencia', false) returning id`,
        [orgFlagged.orgId, tenderFlagged, orgMatched.orgId, tenderMatched],
      ),
    );
    const flagId = inserted.rows[0].id;

    // Sin política de UPDATE/DELETE (ni ALL) definida sobre esta tabla,
    // Postgres las trata como no-op silencioso (0 filas afectadas) -- ni
    // siquiera superadmin, que SÍ puede verla, puede modificarla o
    // borrarla. Verificado contra Postgres real (PGlite), no asumido.
    const upd = await asActor(db, { userId: superadmin }, (tx) =>
      tx.query('update proposal_similarity_flags set regenerated = true where id = $1', [flagId]),
    );
    expect(upd.rowCount).toBe(0);

    const del = await asActor(db, { userId: superadmin }, (tx) => tx.query('delete from proposal_similarity_flags where id = $1', [flagId]));
    expect(del.rowCount).toBe(0);

    const stillThere = await asActor(db, { userId: superadmin }, (tx) =>
      tx.query<{ regenerated: boolean }>('select regenerated from proposal_similarity_flags where id = $1', [flagId]),
    );
    expect(stillThere.rows).toHaveLength(1);
    expect(stillThere.rows[0].regenerated).toBe(false);
  });
});
