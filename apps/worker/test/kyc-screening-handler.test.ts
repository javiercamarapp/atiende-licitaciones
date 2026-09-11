import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import type { NegativeListConnector, NegativeListEntry, NegativeListSnapshot } from '@atiende/kyc';
import { createKycScreeningHandler } from '../src/handlers/kyc-screening.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

function makeJob(): Job<Record<string, never>> {
  return {
    id: 'job-kyc-1',
    orgId: null,
    kind: 'kyc_negative_screening',
    payload: {},
    status: 'running',
    attempts: 1,
    maxAttempts: 5,
    nextRunAt: new Date(),
    lockedAt: new Date(),
    lockedBy: 'worker-test',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCtx(): JobHandlerContext {
  const controller = new AbortController();
  return { job: makeJob(), logger: silentLogger(), signal: controller.signal };
}

/**
 * A diferencia de `createFakeSat69BConnector` de `@atiende/kyc` (que
 * SIEMPRE declara `verified: false` -- es el doble fake explícito del
 * paquete), este es un conector de prueba VERIFICADO a propósito, para
 * ejercitar la ruta feliz del handler -- mismo criterio que
 * `makeVerifiedFakeConnector` de `discover-tenders-handler.test.ts`.
 */
function makeVerifiedFakeConnector(entries: NegativeListEntry[], listAsOfDate: string | null = '2026-01-01'): NegativeListConnector {
  return {
    listId: 'sat_69b',
    liveVerification: { verified: true, note: 'verificado en la prueba' },
    async fetchSnapshot(): Promise<NegativeListSnapshot> {
      return {
        listId: 'sat_69b',
        sourceUrl: 'fake://test',
        fetchedAt: new Date(),
        listAsOfDate,
        listAsOfRaw: listAsOfDate ? `Información actualizada al ${listAsOfDate} (fake)` : null,
        entries,
        rawHash: 'fakehash',
      };
    },
  };
}

function makeNotConfiguredConnector(): NegativeListConnector {
  return {
    listId: 'sat_69b',
    liveVerification: { verified: false, note: 'nunca verificado' },
    async fetchSnapshot(): Promise<NegativeListSnapshot> {
      throw new Error('nunca debería llamarse: el handler debe rechazar antes de invocar fetchSnapshot');
    },
  };
}

describe('createKycScreeningHandler (REQ-026/REQ-111/REQ-112)', () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('rechaza (error permanente) un conector no verificado en vivo, sin llamar fetchSnapshot', async () => {
    const handler = createKycScreeningHandler({ db, connector: makeNotConfiguredConnector() });
    let caught: unknown;
    try {
      await handler(makeJob(), makeCtx());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { permanent?: unknown }).permanent).toBe(true);
  });

  it('ingiere el snapshot 69-B y deja un RFC en Definitivo con verdict suspended, otro fuera de la lista con verdict clear', async () => {
    const { orgId: orgSuspended } = await seedOrgAndUser(db, 'org-kyc-suspended');
    const { orgId: orgClear } = await seedOrgAndUser(db, 'org-kyc-clear');

    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [
      orgSuspended,
      'Empresa Suspendida SA de CV',
      'DEF010101AB1',
    ]);
    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [
      orgClear,
      'Empresa Limpia SA de CV',
      'CLR020202CD2',
    ]);

    const entries: NegativeListEntry[] = [
      { rfc: 'DEF010101AB1', nombreContribuyente: 'Empresa Suspendida SA de CV', situacion: 'Definitivo' },
    ];
    const handler = createKycScreeningHandler({ db, connector: makeVerifiedFakeConnector(entries) });
    await handler(makeJob(), makeCtx());

    const snapshots = await db.query<{ record_count: number; list_as_of_date: string }>('select record_count, list_as_of_date from sanctions_69b_snapshots');
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0].record_count).toBe(1);

    const statusSuspended = await db.query<{ verdict: string; reason: string | null }>('select verdict, reason from tenant_kyc_status where org_id = $1', [orgSuspended]);
    expect(statusSuspended.rows[0].verdict).toBe('suspended');
    expect(statusSuspended.rows[0].reason).toBe('Definitivo');

    const statusClear = await db.query<{ verdict: string }>('select verdict from tenant_kyc_status where org_id = $1', [orgClear]);
    expect(statusClear.rows[0].verdict).toBe('clear');

    const checks = await db.query<{ trigger: string; org_id: string }>('select trigger, org_id from tenant_kyc_checks');
    expect(checks.rows.every((r) => r.trigger === 'nocturno')).toBe(true);
    expect(checks.rows.map((r) => r.org_id).sort()).toEqual([orgClear, orgSuspended].sort());
  });

  it('caso negativo: un tenant sin RFC declarado no genera ningún check (nada que cruzar)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'org-kyc-sin-rfc');
    await db.query('insert into company_profiles (org_id, legal_name) values ($1, $2)', [orgId, 'Empresa sin RFC']);

    const handler = createKycScreeningHandler({ db, connector: makeVerifiedFakeConnector([]) });
    await handler(makeJob(), makeCtx());

    const checks = await db.query('select 1 from tenant_kyc_checks where org_id = $1', [orgId]);
    expect(checks.rows).toHaveLength(0);
  });

  it('fingerprint: dos organizaciones con el mismo domicilio y RFC distinto producen un candidato de interpósita persona', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'org-fp-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'org-fp-b');

    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [orgA, 'Empresa A', 'AAA010101AB1']);
    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [orgB, 'Empresa B', 'BBB020202CD2']);
    await db.query(
      `insert into locations (org_id, label, address_line, city, state, postal_code, is_primary)
       values ($1, 'Oficina', 'Av. Reforma 500', 'CDMX', 'CDMX', '06600', true)`,
      [orgA]
    );
    await db.query(
      `insert into locations (org_id, label, address_line, city, state, postal_code, is_primary)
       values ($1, 'Oficina', 'AV REFORMA 500', 'cdmx', 'cdmx', '06600', true)`,
      [orgB]
    );

    const handler = createKycScreeningHandler({ db, connector: makeVerifiedFakeConnector([]) });
    await handler(makeJob(), makeCtx());

    const matches = await db.query<{ org_id_a: string; org_id_b: string; score: string }>('select org_id_a, org_id_b, score from entity_fingerprint_matches');
    expect(matches.rows).toHaveLength(1);
    expect([matches.rows[0].org_id_a, matches.rows[0].org_id_b].sort()).toEqual([orgA, orgB].sort());
    expect(Number(matches.rows[0].score)).toBeCloseTo(0.4);
  });

  it('caso negativo de fingerprint: organizaciones sin ninguna señal en común no producen ningún candidato', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'org-fp-noneg-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'org-fp-noneg-b');
    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [orgA, 'Empresa A', 'AAA010101AB1']);
    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [orgB, 'Empresa B', 'BBB020202CD2']);

    const handler = createKycScreeningHandler({ db, connector: makeVerifiedFakeConnector([]) });
    await handler(makeJob(), makeCtx());

    const matches = await db.query('select 1 from entity_fingerprint_matches');
    expect(matches.rows).toHaveLength(0);
  });

  it('es re-ejecutable (idempotente): correr el job dos veces no falla y deja el estado final correcto (upsert)', async () => {
    const { orgId } = await seedOrgAndUser(db, 'org-kyc-idempotente');
    await db.query('insert into company_profiles (org_id, legal_name, tax_id) values ($1, $2, $3)', [orgId, 'Empresa', 'IDM010101AB1']);

    const handlerClear = createKycScreeningHandler({ db, connector: makeVerifiedFakeConnector([]) });
    await handlerClear(makeJob(), makeCtx());

    const entries: NegativeListEntry[] = [{ rfc: 'IDM010101AB1', nombreContribuyente: 'Empresa', situacion: 'Definitivo' }];
    const handlerSuspend = createKycScreeningHandler({ db, connector: makeVerifiedFakeConnector(entries) });
    await handlerSuspend(makeJob(), makeCtx());

    const status = await db.query<{ verdict: string }>('select verdict from tenant_kyc_status where org_id = $1', [orgId]);
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0].verdict).toBe('suspended');

    const snapshots = await db.query('select 1 from sanctions_69b_snapshots');
    expect(snapshots.rows).toHaveLength(2);
    const entryRow = await db.query<{ situacion: string }>('select situacion from sanctions_69b_entries where rfc = $1', ['IDM010101AB1']);
    expect(entryRow.rows).toHaveLength(1);
    expect(entryRow.rows[0].situacion).toBe('Definitivo');
  });
});
