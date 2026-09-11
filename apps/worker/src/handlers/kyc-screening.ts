/**
 * REQ-112 (docs/REQUISITOS.md): job nocturno de KYC negativo (cruce contra
 * la lista 69-B ya ingerida en esta misma corrida) + REQ-111 (fingerprint
 * de interpósita persona entre TODOS los tenants). Corre como PLATAFORMA
 * (sin organización activa, `org_id: null` en `jobs`) -- una sola corrida
 * evalúa a TODOS los tenants a la vez, a diferencia de `discover_tenders`
 * (por fuente) o `run_agent` (por organización).
 *
 * Persistencia bajo `worker_role` (packages/db/migrations/0028/0099/0100/
 * 0101): lectura cross-tenant de `organizations`/`company_profiles`/
 * `locations`/`authorized_signatories`/`company_stakeholders` (nunca
 * escritura) + lectura/escritura de las 5 tablas de compliance nuevas.
 * `@atiende/kyc` (lógica pura: parseo, clasificación de riesgo, fingerprint)
 * nunca toca la base de datos directamente -- este archivo es el ÚNICO
 * borde que la conecta con Postgres, siguiendo el mismo criterio que
 * `handlers/discover-tenders.ts` hace con `@atiende/sources`.
 */
import type { DbClient, DbExecutor } from '@atiende/db';
import {
  buildEntityFingerprint,
  findInterpositaPersonaCandidates,
  indexEntriesByRfc,
  screenRfcAgainstEntries,
  type EntityFingerprintInput,
  type NegativeListConnector,
} from '@atiende/kyc';
import type { Job, JobHandler, JobHandlerContext } from '../queue/types.js';

export type KycScreeningPayload = Record<string, never>;

export interface CreateKycScreeningHandlerDeps {
  db: DbClient;
  connector: NegativeListConnector;
}

/**
 * Mismo criterio que `NotConfiguredError` de `handlers/discover-tenders.ts`
 * (WK-10): un conector sin `liveVerification.verified` es un error
 * PERMANENTE (no cambia con un reintento) -- se marca `permanent` para que
 * `isPermanentJobError` (`queue/errors.ts`) dead-letre de inmediato en vez
 * de agotar el ciclo completo de backoff.
 */
class KycConnectorNotConfiguredError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'KycConnectorNotConfiguredError';
  }
}

async function runAsWorkerRole<T>(db: DbClient, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role worker_role');
    return fn(tx);
  });
}

interface LocationRow {
  org_id: string;
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  is_primary: boolean;
}

/**
 * Un domicilio por organización, o `null` si no se puede determinar cuál
 * usar (mismo criterio documentado en `EntityFingerprintInput.domicilio` de
 * `@atiende/kyc`: la primaria si hay exactamente una marcada, o la única si
 * solo hay una en total -- nunca se adivina entre varias sin marcar).
 */
function pickDomicilio(locations: LocationRow[]): LocationRow | null {
  const primary = locations.filter((l) => l.is_primary);
  if (primary.length === 1) return primary[0];
  if (locations.length === 1) return locations[0];
  return null;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const arr = map.get(k) ?? [];
    arr.push(row);
    map.set(k, arr);
  }
  return map;
}

/** Construye un `EntityFingerprintInput` por organización a partir de las señales de identidad YA disponibles en el repo (RFC/domicilio/representantes/socios). */
export async function buildFingerprintInputs(tx: DbExecutor): Promise<EntityFingerprintInput[]> {
  const [orgs, profiles, locations, signatories, stakeholders] = await Promise.all([
    tx.query<{ id: string; name: string }>('select id, name from organizations'),
    tx.query<{ org_id: string; tax_id: string | null }>('select org_id, tax_id from company_profiles'),
    tx.query<LocationRow>('select org_id, address_line, city, state, postal_code, is_primary from locations'),
    tx.query<{ org_id: string; full_name: string; id_document_ref: string | null }>(
      'select org_id, full_name, id_document_ref from authorized_signatories'
    ),
    tx.query<{ org_id: string; full_name: string; rfc: string | null }>('select org_id, full_name, rfc from company_stakeholders'),
  ]);

  const taxIdByOrg = new Map(profiles.rows.map((p) => [p.org_id, p.tax_id] as const));
  const locationsByOrg = groupBy(locations.rows, (l) => l.org_id);
  const signatoriesByOrg = groupBy(signatories.rows, (s) => s.org_id);
  const stakeholdersByOrg = groupBy(stakeholders.rows, (s) => s.org_id);

  return orgs.rows.map((org): EntityFingerprintInput => {
    const domicilio = pickDomicilio(locationsByOrg.get(org.id) ?? []);
    return {
      orgId: org.id,
      orgName: org.name,
      rfc: taxIdByOrg.get(org.id) ?? null,
      domicilio: domicilio
        ? { addressLine: domicilio.address_line, city: domicilio.city, state: domicilio.state, postalCode: domicilio.postal_code }
        : null,
      representantes: (signatoriesByOrg.get(org.id) ?? []).map((s) => ({ fullName: s.full_name, idDocumentRef: s.id_document_ref })),
      socios: (stakeholdersByOrg.get(org.id) ?? []).map((s) => ({ fullName: s.full_name, rfc: s.rfc })),
    };
  });
}

export function createKycScreeningHandler(deps: CreateKycScreeningHandlerDeps): JobHandler<KycScreeningPayload> {
  const { db, connector } = deps;

  return async (_job: Job<KycScreeningPayload>, ctx: JobHandlerContext): Promise<void> => {
    const { logger } = ctx;

    if (!connector.liveVerification.verified) {
      throw new KycConnectorNotConfiguredError(
        `kyc_negative_screening: el conector de la lista "${connector.listId}" no está verificado en vivo (liveVerification.verified=false) -- ver ${connector.liveVerification.note}`
      );
    }

    // 1. Ingesta del snapshot 69-B real + upsert de sus entradas.
    const snapshot = await connector.fetchSnapshot();
    if (snapshot.listAsOfParseError) {
      logger.warn({ error: snapshot.listAsOfParseError }, 'kyc_negative_screening: no se pudo parsear la fecha de corte del CSV (listAsOfDate queda null)');
    }

    const snapshotId = await runAsWorkerRole(db, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [snapshot.sourceUrl, snapshot.fetchedAt.toISOString(), snapshot.listAsOfDate, snapshot.listAsOfRaw, snapshot.entries.length, snapshot.rawHash]
      );
      const id = inserted.rows[0].id;
      for (const entry of snapshot.entries) {
        await tx.query(
          `insert into sanctions_69b_entries (rfc, nombre_contribuyente, situacion, snapshot_id, first_seen_snapshot_id)
           values ($1, $2, $3, $4, $4)
           on conflict (rfc) do update set
             nombre_contribuyente = excluded.nombre_contribuyente, situacion = excluded.situacion, snapshot_id = excluded.snapshot_id, updated_at = now()`,
          [entry.rfc, entry.nombreContribuyente, entry.situacion, id]
        );
      }
      return id;
    });
    logger.info(
      { snapshot_id: snapshotId, entries: snapshot.entries.length, list_as_of_date: snapshot.listAsOfDate },
      'kyc_negative_screening: snapshot 69-B ingerido'
    );

    // 2. Cruce por RFC de todos los tenants con RFC declarado.
    const entriesIndex = indexEntriesByRfc(snapshot.entries);
    const profiles = await runAsWorkerRole(db, (tx) =>
      tx.query<{ org_id: string; tax_id: string | null }>('select org_id, tax_id from company_profiles')
    );

    let suspended = 0;
    let flagged = 0;
    for (const profile of profiles.rows) {
      if (!profile.tax_id) continue;
      const screening = screenRfcAgainstEntries(profile.tax_id, entriesIndex);
      if (screening.verdict === 'suspended') suspended += 1;
      else if (screening.verdict === 'flagged') flagged += 1;
      await runAsWorkerRole(db, (tx) =>
        tx.query('select app.record_tenant_kyc_check($1, $2, $3, $4, $5, $6)', [
          profile.org_id,
          snapshotId,
          screening.normalizedRfc,
          screening.entry?.situacion ?? null,
          screening.verdict,
          'nocturno',
        ])
      );
    }
    if (suspended > 0 || flagged > 0) {
      // "Alerta" (REQ-112): este log estructurado, más las filas de
      // `tenant_kyc_status`/`entity_fingerprint_matches` consultables por
      // `apps/api` (`GET /admin/kyc/*`, ver módulo admin) -- mismo criterio
      // ya usado en `apps/api/src/modules/admin/routes.ts` para
      // `isStale`/frescura de fuentes: un valor computado y expuesto a
      // superadmin, no una notificación push nueva que este repo no tiene.
      logger.warn({ suspended, flagged, tenants_screened: profiles.rows.length }, 'kyc_negative_screening: coincidencias contra la lista 69-B');
    }

    // 3. Fingerprint de interpósita persona entre TODOS los tenants (REQ-111).
    const fingerprintInputs = await runAsWorkerRole(db, (tx) => buildFingerprintInputs(tx));
    const fingerprints = fingerprintInputs.map(buildEntityFingerprint);
    const candidates = findInterpositaPersonaCandidates(fingerprints);

    for (const candidate of candidates) {
      await runAsWorkerRole(db, (tx) =>
        tx.query(
          `insert into entity_fingerprint_matches (org_id_a, org_id_b, score, matched_fields)
           values ($1, $2, $3, $4::jsonb)
           on conflict (org_id_a, org_id_b) do update set
             score = excluded.score, matched_fields = excluded.matched_fields, detected_at = now(), status = 'open'`,
          [candidate.orgIdA, candidate.orgIdB, candidate.score, JSON.stringify(candidate.matchedFields)]
        )
      );
    }
    if (candidates.length > 0) {
      logger.warn({ candidates: candidates.length }, 'kyc_negative_screening: candidatos de interpósita persona detectados');
    }

    logger.info(
      { tenants_screened: profiles.rows.length, fingerprint_candidates: candidates.length, snapshot_id: snapshotId },
      'kyc_negative_screening: corrida completa'
    );
  };
}
