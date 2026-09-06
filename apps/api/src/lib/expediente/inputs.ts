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

/**
 * AE-08 (docs/auditoria-2/api-expediente.md, MEDIA): esta función solo
 * cubría `company_profiles` -- `capabilities`, `experience_records` y
 * `authorized_signatories` alimentan el contenido real de la propuesta
 * técnica generada (`CompanyDataService`/`TechnicalProposalBuilder`,
 * `lib/expediente/company-data-resolver.pg.ts`) pero NUNCA formaban parte
 * del insumo sellado: un cambio posterior a la aprobación en el estado de
 * verificación/evidencia de una capacidad, experiencia o firmante ya usado
 * no disparaba ninguna invalidación (ni por hash, ni por `recordChange`
 * explícito). Se amplía a TODAS las categorías reales del perfil de
 * empresa (capabilities, experience, products_services, locations,
 * registrations, signatories, restrictions), no solo las tres señaladas
 * por el hallazgo -- son datos declarados por el mismo actor y del mismo
 * "conjunto cerrado" conceptual (packages/expediente exige un conjunto
 * cerrado/obligatorio, EX-EXP-01/EX-EXP-11), así que dejarlas fuera
 * repetiría el mismo defecto de fondo por una puerta distinta.
 *
 * `company_documents`/`approved_rates` NO se duplican aquí: ya tienen su
 * propio campo dedicado en `ExpedienteInputs` (`companyDocuments`/`rates`,
 * ver `buildExpedienteInputs` más abajo), con el patrón deliberado de
 * "solo lo REALMENTE usado por esta propuesta" (`usedCompanyDocumentIds`/
 * `usedRateConcepts`) -- incluir aquí TODOS los documentos/tarifas de la
 * organización (usados o no) invalidaría la aprobación ante un cambio
 * irrelevante para este expediente en particular.
 *
 * Cada lista se ordena por `id` en SQL: `sha256Hex`/`stableStringify`
 * ordena claves de objeto de forma determinista pero NO reordena arreglos
 * (ver packages/expediente/src/types.ts) -- sin este `order by`, el mismo
 * conjunto de filas devuelto en otro orden produciría un hash distinto sin
 * que nada haya cambiado realmente.
 */
async function buildCompanyProfileHash(tx: DbExecutor, orgId: string): Promise<string> {
  const [profile, capabilities, experience, products, locations, registrations, signatories, restrictions] = await Promise.all([
    tx.query<RawRow>(
      'select legal_name, trade_name, tax_id, description, sector, founded_year, employee_count, annual_revenue, website, updated_at from company_profiles where org_id = $1',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, name, category, description, is_verified, evidence_ref, updated_at from capabilities where org_id = $1 order by id asc',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, title, client_name, description, contract_value, currency, start_date, end_date, is_verified, evidence_ref, updated_at from experience_records where org_id = $1 order by id asc',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, name, category, description, updated_at from products_services where org_id = $1 order by id asc',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, label, address_line, city, state, country, postal_code, is_primary, updated_at from locations where org_id = $1 order by id asc',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, kind, value, issuing_authority, valid_from, valid_until, updated_at from registrations where org_id = $1 order by id asc',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, full_name, role_title, id_document_ref, valid_from, valid_until, updated_at from authorized_signatories where org_id = $1 order by id asc',
      [orgId]
    ),
    tx.query<RawRow>(
      'select id, kind, description, valid_until, updated_at from restrictions where org_id = $1 order by id asc',
      [orgId]
    ),
  ]);
  return sha256Hex({
    profile: profile.rows[0] ?? null,
    capabilities: capabilities.rows,
    experience: experience.rows,
    productsServices: products.rows,
    locations: locations.rows,
    registrations: registrations.rows,
    signatories: signatories.rows,
    restrictions: restrictions.rows,
  });
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
