import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient, DbExecutor } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, asActor } from './helpers.js';

/**
 * REQ-112 (job nocturno de KYC/fingerprint, `apps/worker`): mismo criterio
 * de prueba que `worker-role-and-job-proposals.test.ts` -- verifica a nivel
 * de esquema/RLS que `worker_role` (0028) puede hacer exactamente lo que
 * `apps/worker/src/handlers/kyc-screening.ts` necesita, ni más ni menos, y
 * que las funciones SECURITY DEFINER que usa `apps/api` (REQ-026, "al
 * alta") respetan sus guardias de autorización.
 */
async function runAsWorkerRole<T>(db: DbClient, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role worker_role');
    return fn(tx);
  });
}

describe('worker_role: acceso cross-tenant mínimo para el job nocturno de KYC', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('puede leer organizations/company_profiles/locations/authorized_signatories/company_stakeholders de TODOS los tenants', async () => {
    const orgA = await seedOrg(db, 'org-worker-cross-a');
    const orgB = await seedOrg(db, 'org-worker-cross-b');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-cross-a@example.com', 'owner');
    await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query(
        `insert into company_profiles (org_id, legal_name, tax_id) values ($1, 'Empresa A', 'AAA010101AB1')`,
        [orgA.orgId]
      )
    );

    const orgs = await runAsWorkerRole(db, (tx) => tx.query('select id from organizations'));
    const orgIds = orgs.rows.map((r: any) => r.id);
    expect(orgIds).toEqual(expect.arrayContaining([orgA.orgId, orgB.orgId]));

    const profiles = await runAsWorkerRole(db, (tx) => tx.query('select org_id, tax_id from company_profiles where org_id = $1', [orgA.orgId]));
    expect(profiles.rows).toHaveLength(1);
    expect((profiles.rows[0] as any).tax_id).toBe('AAA010101AB1');
  });

  it('puede insertar/actualizar un snapshot 69-B y sus entradas (upsert)', async () => {
    const snapshot = await runAsWorkerRole(db, (tx) =>
      tx.query<{ id: string }>(
        `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
         values ('http://x', now(), '2026-01-01', 'leyenda', 1, 'hash1') returning id`
      )
    );
    const snapshotId = snapshot.rows[0].id;

    await runAsWorkerRole(db, (tx) =>
      tx.query(
        `insert into sanctions_69b_entries (rfc, nombre_contribuyente, situacion, snapshot_id, first_seen_snapshot_id)
         values ('WRK010101AB1', 'Empresa Worker', 'Definitivo', $1, $1)
         on conflict (rfc) do update set situacion = excluded.situacion, snapshot_id = excluded.snapshot_id, updated_at = now()`,
        [snapshotId]
      )
    );
    const { rows } = await runAsWorkerRole(db, (tx) => tx.query('select situacion from sanctions_69b_entries where rfc = $1', ['WRK010101AB1']));
    expect(rows[0].situacion).toBe('Definitivo');
  });

  it('un tenant normal (no worker_role, no superadmin) NO puede leer sanctions_69b_snapshots directamente', async () => {
    const org = await seedOrg(db, 'org-worker-noaccess');
    const ownerId = await seedMember(db, org.orgId, 'owner-noaccess@example.com', 'owner');
    const { rows } = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) => tx.query('select * from sanctions_69b_snapshots'));
    expect(rows).toHaveLength(0);
  });
});

describe('funciones SECURITY DEFINER de KYC (app.lookup_negative_list_entry / app.record_tenant_kyc_check / app.latest_69b_snapshot_id)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('app.latest_69b_snapshot_id() es NULL sin ninguna corrida, y devuelve el snapshot más reciente después', async () => {
    const org = await seedOrg(db, 'org-latest-snapshot');
    const ownerId = await seedMember(db, org.orgId, 'owner-latest@example.com', 'owner');

    const before = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) => tx.query<{ id: string | null }>('select app.latest_69b_snapshot_id() as id'));
    expect(before.rows[0].id).toBeNull();

    const inserted = await runAsWorkerRole(db, (tx) =>
      tx.query<{ id: string }>(
        `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
         values ('http://x', now(), '2026-01-01', 'leyenda', 0, 'hashN') returning id`
      )
    );

    const after = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) => tx.query<{ id: string }>('select app.latest_69b_snapshot_id() as id'));
    expect(after.rows[0].id).toBe(inserted.rows[0].id);
  });

  it('app.lookup_negative_list_entry expone SOLO la fila de un RFC puntual a un tenant normal', async () => {
    const snapshot = await runAsWorkerRole(db, (tx) =>
      tx.query<{ id: string }>(
        `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
         values ('http://x', now(), '2026-01-01', 'leyenda', 1, 'hash2') returning id`
      )
    );
    await runAsWorkerRole(db, (tx) =>
      tx.query(
        `insert into sanctions_69b_entries (rfc, nombre_contribuyente, situacion, snapshot_id, first_seen_snapshot_id) values ('LOOKUP010101AB1', 'Empresa Lookup', 'Presunto', $1, $1)`,
        [snapshot.rows[0].id]
      )
    );

    const org = await seedOrg(db, 'org-lookup');
    const ownerId = await seedMember(db, org.orgId, 'owner-lookup@example.com', 'owner');

    const found = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select * from app.lookup_negative_list_entry($1)', ['LOOKUP010101AB1'])
    );
    expect(found.rows).toEqual([{ situacion: 'Presunto', nombre_contribuyente: 'Empresa Lookup' }]);

    const notFound = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select * from app.lookup_negative_list_entry($1)', ['NOEXISTE010101XX1'])
    );
    expect(notFound.rows).toEqual([]);

    // Caso negativo de seguridad: el tenant SIGUE sin poder leer la tabla completa directamente.
    const raw = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) => tx.query('select * from sanctions_69b_entries'));
    expect(raw.rows).toHaveLength(0);
  });

  it('app.record_tenant_kyc_check: un tenant puede registrar un check para SU PROPIA organización', async () => {
    const org = await seedOrg(db, 'org-record-own');
    const ownerId = await seedMember(db, org.orgId, 'owner-record-own@example.com', 'owner');

    const result = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        `select app.record_tenant_kyc_check($1, null, 'AAA010101AB1', null, 'clear', 'alta') as id`,
        [org.orgId]
      )
    );
    expect(result.rows[0].id).toBeTruthy();

    const verdict = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) => tx.query<{ v: string }>('select app.tenant_kyc_verdict($1) as v', [org.orgId]));
    expect(verdict.rows[0].v).toBe('clear');
  });

  it('adversarial: un tenant NO puede registrar un check para OTRA organización', async () => {
    const orgMine = await seedOrg(db, 'org-record-mine');
    const orgOther = await seedOrg(db, 'org-record-other');
    const ownerId = await seedMember(db, orgMine.orgId, 'owner-record-mine@example.com', 'owner');

    await expect(
      asActor(db, { orgId: orgMine.orgId, userId: ownerId }, (tx) =>
        tx.query(`select app.record_tenant_kyc_check($1, null, 'BBB020202CD2', null, 'suspended', 'alta')`, [orgOther.orgId])
      )
    ).rejects.toThrow(/no coincide con la organización activa/);

    // Confirma que NO quedó ningún efecto secundario en la organización ajena.
    const other = await asActor(db, { orgId: orgOther.orgId, userId: await seedMember(db, orgOther.orgId, 'owner-record-other@example.com', 'owner') }, (tx) =>
      tx.query<{ v: string | null }>('select app.tenant_kyc_verdict($1) as v', [orgOther.orgId])
    );
    expect(other.rows[0].v).toBeNull();
  });

  it('el job nocturno (worker_role, sin organización activa) SÍ puede registrar un check para cualquier organización', async () => {
    const org = await seedOrg(db, 'org-record-worker');

    const result = await runAsWorkerRole(db, (tx) =>
      tx.query<{ id: string }>(
        `select app.record_tenant_kyc_check($1, null, 'CCC030303EF3', 'Definitivo', 'suspended', 'nocturno') as id`,
        [org.orgId]
      )
    );
    expect(result.rows[0].id).toBeTruthy();

    const superReadCheck = await runAsWorkerRole(db, (tx) => tx.query('select verdict, trigger from tenant_kyc_checks where org_id = $1', [org.orgId]));
    expect((superReadCheck.rows[0] as any).verdict).toBe('suspended');
    expect((superReadCheck.rows[0] as any).trigger).toBe('nocturno');
  });
});
