/**
 * REQ-026 (docs/REQUISITOS.md): KYC negativo obligatorio al capturar/
 * actualizar el RFC del perfil de empresa de un tenant ("al alta"). Usa
 * `@atiende/kyc` (lógica pura de clasificación) + las funciones SECURITY
 * DEFINER de `packages/db/migrations/0099_*.sql`
 * (`app.lookup_negative_list_entry`/`app.latest_69b_snapshot_id`/
 * `app.record_tenant_kyc_check`) -- este archivo NUNCA toca directamente
 * `sanctions_69b_entries`/`tenant_kyc_checks`/`tenant_kyc_status` (esas
 * tablas son de solo superadmin/worker_role en RLS; un tenant normal solo
 * puede pasar por esas funciones, que verifican internamente que solo
 * afecte a SU PROPIA organización).
 */
import type { DbExecutor } from '@atiende/db';
import { indexEntriesByRfc, screenRfcAgainstEntries, type KycVerdict, type NegativeListEntry } from '@atiende/kyc';

export interface RfcAltaScreeningResult {
  verdict: KycVerdict;
  matchedSituacion: string | null;
}

/**
 * Cruza `rfc` contra la lista 69-B ya ingerida (job nocturno de
 * `apps/worker`, REQ-112) y deja registrado el resultado como un check de
 * tipo "alta". Si `verdict === 'suspended'` (RFC en lista 69-B Definitivo,
 * tolerancia cero), el LLAMADOR es responsable de abortar la operación que
 * disparó la captura del RFC (nunca persiste el perfil con ese RFC) -- esta
 * función solo evalúa y deja rastro, nunca decide por sí misma qué hacer
 * con el resultado.
 */
export async function screenCompanyProfileRfc(tx: DbExecutor, params: { orgId: string; rfc: string }): Promise<RfcAltaScreeningResult> {
  const lookup = await tx.query<{ situacion: string; nombre_contribuyente: string }>(
    'select * from app.lookup_negative_list_entry($1)',
    [params.rfc.trim().toUpperCase()]
  );
  const row = lookup.rows[0];
  const entries: NegativeListEntry[] = row
    ? [{ rfc: params.rfc, nombreContribuyente: row.nombre_contribuyente, situacion: row.situacion }]
    : [];
  const screening = screenRfcAgainstEntries(params.rfc, indexEntriesByRfc(entries));

  const snapshotResult = await tx.query<{ id: string | null }>('select app.latest_69b_snapshot_id() as id');
  const snapshotId = snapshotResult.rows[0]?.id ?? null;

  await tx.query('select app.record_tenant_kyc_check($1, $2, $3, $4, $5, $6)', [
    params.orgId,
    snapshotId,
    screening.normalizedRfc,
    screening.entry?.situacion ?? null,
    screening.verdict,
    'alta',
  ]);

  return { verdict: screening.verdict, matchedSituacion: screening.entry?.situacion ?? null };
}
