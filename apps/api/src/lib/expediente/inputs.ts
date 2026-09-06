/**
 * Construye el `ExpedienteInputs` (conjunto CERRADO y OBLIGATORIO, ver
 * packages/expediente/src/proposal-version.ts) a partir del estado REAL en
 * `packages/db` y calcula su hash con `computeInputsHash` -- la ÚNICA
 * función soportada por el paquete puro para producir el hash de alcance
 * "expediente".
 *
 * IMPORTANTE (coordinación con packages/expediente, EX-EXP-17): este módulo
 * es el ÚNICO punto de la API que arma `ExpedienteInputs` y llama a
 * `computeInputsHash`/`sealInputs`. Desde EX-EXP-17, `ApprovalWorkflow.
 * approve()`/`revalidateAgainstCurrentHash`/`PackageAssembler.buildManifest`
 * ya NO aceptan un `string` plano: exigen un `HashedInputs` sellado
 * (`sealInputs(inputs)`, símbolo privado no falsificable desde fuera de
 * `packages/expediente`). Nunca se persiste un hash "de confianza" que
 * luego se reutilice tal cual para decidir una aprobación o el estado
 * `ready` del paquete: cada vez que hace falta "el actual", se vuelve a
 * llamar `getCurrentSealedInputs` sobre el estado vivo de la base de datos
 * (nunca sobre un valor leído de `proposals.inputs_hash`, que es solo de
 * VISUALIZACIÓN/consulta). Para REPRODUCIR una aprobación histórica
 * (`lib/expediente/approval-store.pg.ts`), hace falta el `ExpedienteInputs`
 * completo con el que se selló en su momento -- por eso
 * `proposal_approval_events.inputs_snapshot` (migración 0034) guarda el
 * objeto completo, no solo su hash: `sealInputs` no puede reconstruir un
 * `HashedInputs` válido a partir de un hash suelto.
 */
import type { DbExecutor } from '@atiende/db';
import {
  computeInputsHash,
  sealInputs,
  sha256Hex,
  type ExpedienteInputCompanyDocument,
  type ExpedienteInputRate,
  type ExpedienteInputTemplate,
  type ExpedienteInputs,
  type HashedInputs,
} from '@atiende/expediente';
import { dateOnlyToMexicoCityIso, timestampToIso } from './dates.js';

/** Plantillas fijas usadas para redactar carta/anexo económico en esta ronda (sin motor de plantillas configurable todavía). */
const FIXED_TEMPLATES: ExpedienteInputTemplate[] = [
  { templateId: 'carta_economica_v1', hash: sha256Hex('carta_economica_v1') },
  { templateId: 'anexo_economico_v1', hash: sha256Hex('anexo_economico_v1') },
  { templateId: 'manifiesto_v1', hash: sha256Hex('manifiesto_v1') },
];

interface RawRow {
  [key: string]: unknown;
}

export interface BuildExpedienteInputsParams {
  orgId: string;
  tenderId: string;
  /** ids de `company_documents` efectivamente referenciados por la propuesta técnica (no todo el catálogo). */
  usedCompanyDocumentIds: string[];
  /** `item_code` de `approved_rates` efectivamente referenciados por la propuesta económica. */
  usedRateConcepts: string[];
}

async function buildTenderVersionHash(tx: DbExecutor, orgId: string, tenderId: string): Promise<string> {
  const latest = await tx.query<RawRow>(
    'select id, source_version, change_kind, effective_at, payload from tender_versions where org_id = $1 and tender_id = $2 order by effective_at desc, created_at desc limit 1',
    [orgId, tenderId]
  );
  if (latest.rows.length > 0) {
    const v = latest.rows[0];
    return sha256Hex({ versionId: v.id, sourceVersion: v.source_version, changeKind: v.change_kind, effectiveAt: timestampToIso(v.effective_at as string | Date) });
  }
  // Convocatoria sin ninguna versión registrada todavía (caso límite, p. ej.
  // datos de prueba): se hashea el snapshot actual de `tenders` para que el
  // insumo exista igual (nunca se omite del conjunto cerrado).
  const tender = await tx.query<RawRow>('select id, title, submission_deadline, status, updated_at from tenders where org_id = $1 and id = $2', [orgId, tenderId]);
  return sha256Hex({ fallback: 'tender_snapshot', row: tender.rows[0] ?? null });
}

async function buildCompanyProfileHash(tx: DbExecutor, orgId: string): Promise<string> {
  const profile = await tx.query<RawRow>('select legal_name, trade_name, tax_id, description, sector, updated_at from company_profiles where org_id = $1', [orgId]);
  return sha256Hex({ profile: profile.rows[0] ?? null });
}

async function buildCompanyDocumentInputs(tx: DbExecutor, orgId: string, documentIds: string[]): Promise<ExpedienteInputCompanyDocument[]> {
  if (documentIds.length === 0) return [];
  const res = await tx.query<RawRow>('select id, document_type, file_hash, valid_until from company_documents where org_id = $1 and id = any($2::uuid[])', [orgId, documentIds]);
  return res.rows.map((r) => ({
    documentId: String(r.id),
    hash: (r.file_hash as string | null) ?? sha256Hex({ documentType: r.document_type, validUntil: r.valid_until }),
    vigenteHasta: dateOnlyToMexicoCityIso(r.valid_until as string | Date | null, 'end'),
  }));
}

async function buildRateInputs(tx: DbExecutor, orgId: string, concepts: string[]): Promise<ExpedienteInputRate[]> {
  if (concepts.length === 0) return [];
  const res = await tx.query<RawRow>('select item_code, unit_price, currency, status, valid_from, valid_until from approved_rates where org_id = $1 and item_code = any($2::text[])', [
    orgId,
    concepts,
  ]);
  return res.rows.map((r) => ({
    concept: String(r.item_code),
    hash: sha256Hex({ unitPrice: r.unit_price, currency: r.currency, status: r.status, validFrom: r.valid_from, validUntil: r.valid_until }),
  }));
}

export async function buildExpedienteInputs(tx: DbExecutor, params: BuildExpedienteInputsParams): Promise<ExpedienteInputs> {
  const [tenderVersionHash, companyProfileHash, companyDocuments, rates] = await Promise.all([
    buildTenderVersionHash(tx, params.orgId, params.tenderId),
    buildCompanyProfileHash(tx, params.orgId),
    buildCompanyDocumentInputs(tx, params.orgId, params.usedCompanyDocumentIds),
    buildRateInputs(tx, params.orgId, params.usedRateConcepts),
  ]);

  return {
    tenderVersionHash,
    companyProfileHash,
    companyDocuments,
    rates,
    templates: FIXED_TEMPLATES,
  };
}

/**
 * Recalcula SIEMPRE desde el estado vivo de la base de datos y devuelve el
 * `HashedInputs` sellado (EX-EXP-17) de alcance "expediente" -- el único
 * valor que debe pasarse a `ApprovalWorkflow.approve()`/
 * `isFullyApprovedForCurrentHash()`/`PackageAssembler.buildManifest()`.
 * Nunca se debe sustituir esta llamada por un valor leído de
 * `proposals.inputs_hash` (texto plano, solo de visualización).
 */
export async function getCurrentSealedInputs(tx: DbExecutor, params: BuildExpedienteInputsParams): Promise<HashedInputs> {
  const inputs = await buildExpedienteInputs(tx, params);
  return sealInputs(inputs);
}

/** Solo para mostrar/guardar en `proposals.inputs_hash` (texto de consulta) -- nunca para volver a alimentar `approve()`/`buildManifest()`. */
export async function getCurrentInputsHashForDisplay(tx: DbExecutor, params: BuildExpedienteInputsParams): Promise<string> {
  const inputs = await buildExpedienteInputs(tx, params);
  return computeInputsHash(inputs);
}
