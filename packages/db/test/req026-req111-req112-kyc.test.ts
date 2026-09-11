import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedSuperadmin, asActor } from './helpers.js';

/**
 * REQ-026/REQ-111/REQ-112 (docs/REQUISITOS.md): esquema de plataforma para
 * KYC negativo (lista 69-B) y fingerprint de interpósita persona
 * (migraciones 0099/0100). Cubre exactamente la propiedad de seguridad que
 * el diseño declara: NINGÚN tenant (ni siquiera su propio owner) puede leer
 * su expediente de compliance crudo -- solo `app.tenant_kyc_verdict()`
 * (SECURITY DEFINER) expone lo mínimo necesario para que `apps/api` decida
 * bloquear acceso.
 */
describe('esquema KYC negativo / fingerprint de interpósita persona (0099/0100)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('superadmin puede insertar un snapshot + entradas de la lista 69-B y leerlas de vuelta', async () => {
    const superadminId = await seedSuperadmin(db, 'super-69b@example.com');

    const snapshotResult = await asActor(db, { userId: superadminId }, (tx) =>
      tx.query<{ id: string }>(
        `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
         values ($1, now(), $2, $3, $4, $5) returning id`,
        ['http://omawww.sat.gob.mx/cifras_sat/Documents/Listado_Completo_69-B.csv', '2025-12-31', 'Información actualizada al 31 de diciembre de 2025', 1, 'deadbeef']
      )
    );
    const snapshotId = snapshotResult.rows[0].id;
    expect(snapshotId).toBeTruthy();

    await asActor(db, { userId: superadminId }, (tx) =>
      tx.query(
        `insert into sanctions_69b_entries (rfc, nombre_contribuyente, situacion, snapshot_id, first_seen_snapshot_id)
         values ($1, $2, $3, $4, $4)`,
        ['AAC0608103B5', 'ADITIVOS ALTERNOS DEL CENTRO S.A. DE C.V.', 'Definitivo', snapshotId]
      )
    );

    const { rows } = await asActor(db, { userId: superadminId }, (tx) =>
      tx.query('select * from sanctions_69b_entries where rfc = $1', ['AAC0608103B5'])
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).situacion).toBe('Definitivo');
  });

  it('un miembro normal (incluso owner) NUNCA puede leer sanctions_69b_entries directamente -- solo superadmin', async () => {
    const org = await seedOrg(db, 'org-kyc-noaccess');
    const ownerId = await seedMember(db, org.orgId, 'owner-kyc@example.com', 'owner');

    const { rows } = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select * from sanctions_69b_entries')
    );
    // RLS de solo-SELECT-con-USING oculta filas en vez de lanzar: 0 filas
    // visibles, nunca un error que delate que la tabla tiene contenido.
    expect(rows).toHaveLength(0);

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into sanctions_69b_entries (rfc, nombre_contribuyente, situacion, snapshot_id, first_seen_snapshot_id)
           values ('X', 'Y', 'Definitivo', gen_random_uuid(), gen_random_uuid())`
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('tenant_kyc_status: el propio owner de la organización NO puede leer su expediente crudo, pero app.tenant_kyc_verdict() sí expone el veredicto', async () => {
    const superadminId = await seedSuperadmin(db, 'super-status@example.com');
    const org = await seedOrg(db, 'org-kyc-status');
    const ownerId = await seedMember(db, org.orgId, 'owner-status@example.com', 'owner');

    // Antes de cualquier corrida de KYC: la función devuelve NULL (estado
    // explícito "nunca verificado"), NUNCA 'clear' por omisión.
    const before = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ verdict: string | null }>('select app.tenant_kyc_verdict($1) as verdict', [org.orgId])
    );
    expect(before.rows[0].verdict).toBeNull();

    await asActor(db, { userId: superadminId }, (tx) =>
      tx.query(
        `insert into tenant_kyc_status (org_id, verdict, reason) values ($1, 'suspended', 'RFC en lista 69-B Definitivo')`,
        [org.orgId]
      )
    );

    // El owner de la propia organización SIGUE sin poder leer la fila cruda...
    const rawRead = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select * from tenant_kyc_status where org_id = $1', [org.orgId])
    );
    expect(rawRead.rows).toHaveLength(0);

    // ...pero la función SECURITY DEFINER sí le expone el veredicto vigente
    // (lo mínimo que `apps/api` necesita para bloquear el acceso del tenant).
    const after = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ verdict: string | null }>('select app.tenant_kyc_verdict($1) as verdict', [org.orgId])
    );
    expect(after.rows[0].verdict).toBe('suspended');
  });

  it('entity_fingerprint_matches: rechaza pares desordenados y auto-pares; permite exactamente un registro por par', async () => {
    const superadminId = await seedSuperadmin(db, 'super-fp@example.com');
    const orgA = await seedOrg(db, 'org-fp-a');
    const orgB = await seedOrg(db, 'org-fp-b');
    const [first, second] = [orgA.orgId, orgB.orgId].sort();

    await expect(
      asActor(db, { userId: superadminId }, (tx) =>
        tx.query(
          `insert into entity_fingerprint_matches (org_id_a, org_id_b, score, matched_fields) values ($1, $1, 0.5, '[]'::jsonb)`,
          [first]
        )
      )
    ).rejects.toThrow(/entity_fingerprint_matches_distinct_orgs/);

    await expect(
      asActor(db, { userId: superadminId }, (tx) =>
        tx.query(
          `insert into entity_fingerprint_matches (org_id_a, org_id_b, score, matched_fields) values ($1, $2, 0.5, '[]'::jsonb)`,
          [second, first]
        )
      )
    ).rejects.toThrow(/entity_fingerprint_matches_ordered_pair/);

    await asActor(db, { userId: superadminId }, (tx) =>
      tx.query(
        `insert into entity_fingerprint_matches (org_id_a, org_id_b, score, matched_fields) values ($1, $2, 0.4, '[{"field":"domicilio","value":"x"}]'::jsonb)`,
        [first, second]
      )
    );

    await expect(
      asActor(db, { userId: superadminId }, (tx) =>
        tx.query(
          `insert into entity_fingerprint_matches (org_id_a, org_id_b, score, matched_fields) values ($1, $2, 0.9, '[]'::jsonb)`,
          [first, second]
        )
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe('company_stakeholders (0100, REQ-111 -- socios/accionistas)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('owner/admin puede registrar un socio; viewer no puede escribir (RLS estándar de perfil de empresa)', async () => {
    const org = await seedOrg(db, 'org-stakeholders');
    const ownerId = await seedMember(db, org.orgId, 'owner-sh@example.com', 'owner');
    const viewerId = await seedMember(db, org.orgId, 'viewer-sh@example.com', 'viewer');

    const inserted = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        `insert into company_stakeholders (org_id, kind, full_name, rfc, participation_pct)
         values ($1, 'socio', 'Pedro Gómez', 'GOMP700101XY9', 50.00) returning id`,
        [org.orgId]
      )
    );
    expect(inserted.rows).toHaveLength(1);

    await expect(
      asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
        tx.query(
          `insert into company_stakeholders (org_id, kind, full_name) values ($1, 'socio', 'Otro Socio')`,
          [org.orgId]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('aislamiento entre tenants: la organización B nunca ve los socios de la organización A', async () => {
    const orgA = await seedOrg(db, 'org-stakeholders-a');
    const orgB = await seedOrg(db, 'org-stakeholders-b');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-sh-a@example.com', 'owner');
    const ownerB = await seedMember(db, orgB.orgId, 'owner-sh-b@example.com', 'owner');

    await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query(`insert into company_stakeholders (org_id, kind, full_name) values ($1, 'socio', 'Secreto de A')`, [orgA.orgId])
    );

    const seenFromB = await asActor(db, { orgId: orgB.orgId, userId: ownerB }, (tx) =>
      tx.query('select * from company_stakeholders')
    );
    expect(seenFromB.rows).toHaveLength(0);
  });
});
