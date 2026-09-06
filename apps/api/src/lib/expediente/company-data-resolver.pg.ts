/**
 * Implementación real de `CompanyDataResolver` (`@atiende/expediente`) sobre
 * `packages/db`. `CompanyDataResolver` es una interfaz SÍNCRONA (E7 del
 * backlog: "Implementar CompanyDataResolver sobre packages/db"), así que
 * este módulo primero LEE todo lo necesario de la organización dentro de la
 * transacción con contexto de tenant activo (RLS real, ver
 * `withTenantContext`), y luego construye un
 * `InMemoryCompanyDataResolver` (reexportado por el propio paquete) sobre
 * esos datos ya cargados -- nunca hace I/O dentro de los métodos de la
 * interfaz.
 *
 * `companyId` en todo este adaptador es simplemente el `orgId`: en este
 * dominio cada organización tiene un único "expediente de empresa" (no hay
 * multi-empresa por organización).
 *
 * Reglas de mapeo documentadas (decisiones explícitas, no fabricación):
 *  - `company_profiles`: si existe la fila, se considera `"aprobado"` (no
 *    hay flujo de aprobación de perfil per se en este esquema); si no
 *    existe, `getProfile` regresa `undefined` (perfil ausente real).
 *  - `capabilities`/`experience_records`: `is_verified` -> `"aprobado"` si
 *    `true`, si no `"pendiente_aprobacion"`. Un registro de experiencia SIN
 *    `evidence_ref` se EXCLUYE del resolver (no se fabrica un
 *    `evidenceDocId` vacío): `resolveExperience` devuelve `"missing"` para
 *    ese id, consistente con REQ-164 (nunca inventar evidencia).
 *  - `company_documents`: `valid_until IS NULL` -> `"pendiente_aprobacion"`
 *    (sin vigencia documentada, nunca se asume vigente); con `valid_until`
 *    -> `"aprobado"` (el bloqueo por vencimiento a la fecha del ACTO lo
 *    aplica `CompanyDataService.resolveDocumentByType` comparando contra
 *    `asOfIso`, no aquí).
 *  - `authorized_signatories`: autorizado si `asOfIso` cae dentro de
 *    `[valid_from, valid_until]` (cuando están definidos) o si ninguno de
 *    los dos está definido (sin ventana declarada = sin restricción
 *    conocida).
 *  - `approved_rates`: `status` -> `"aprobado"`/`"pendiente_aprobacion"`/
 *    `"rechazado"`. `valid_from IS NULL` se ancla a `created_at` (una
 *    tarifa capturada sin fecha de inicio explícita se considera vigente
 *    desde que se capturó -- límite documentado, no legal, del adaptador;
 *    `packages/expediente` exige `validFrom` no nulo y lanzaría si se le
 *    pasara `null`).
 */
import type { DbExecutor } from '@atiende/db';
import {
  InMemoryCompanyDataResolver,
  type ApprovalStatus,
  type ApprovedRate,
  type CompanyCapability,
  type CompanyDocument,
  type CompanyExperienceRecord,
  type CompanyProfile,
  type CompanySigner,
} from '@atiende/expediente';
import { dateOnlyToMexicoCityIso, timestampToIso } from './dates.js';

interface RawRow {
  [key: string]: unknown;
}

export interface LoadedCompanyData {
  resolver: InMemoryCompanyDataResolver;
  /** Hash-relevant snapshot del perfil (para `ExpedienteInputs.companyProfileHash`, ver inputs.ts). */
  profileSnapshot: Record<string, unknown>;
  /** Documentos de empresa cargados, para poder construir `ExpedienteInputCompanyDocument[]` en inputs.ts sin releer la DB. */
  documents: CompanyDocument[];
}

function verifiedToApprovalStatus(isVerified: boolean): ApprovalStatus {
  return isVerified ? 'aprobado' : 'pendiente_aprobacion';
}

function rateStatusToApprovalStatus(status: string): ApprovalStatus {
  if (status === 'approved') return 'aprobado';
  if (status === 'draft') return 'pendiente_aprobacion';
  return 'rechazado'; // 'archived'
}

/**
 * Carga todos los datos de empresa de `orgId` y construye el
 * `CompanyDataResolver` real. Debe llamarse dentro de una transacción con
 * `withTenantContext`/`SET LOCAL ROLE app_role` ya aplicado (para que RLS
 * filtre correctamente), igual que cualquier otra lectura de negocio de
 * apps/api.
 */
export async function loadCompanyDataResolver(tx: DbExecutor, orgId: string, asOfIso: string): Promise<LoadedCompanyData> {
  const companyId = orgId;

  const [profileRes, capabilitiesRes, experienceRes, documentsRes, signatoriesRes, ratesRes, provenanceRes] = await Promise.all([
    tx.query<RawRow>('select * from company_profiles where org_id = $1', [orgId]),
    tx.query<RawRow>('select * from capabilities where org_id = $1', [orgId]),
    tx.query<RawRow>('select * from experience_records where org_id = $1', [orgId]),
    tx.query<RawRow>('select * from company_documents where org_id = $1', [orgId]),
    tx.query<RawRow>('select * from authorized_signatories where org_id = $1', [orgId]),
    tx.query<RawRow>('select * from approved_rates where org_id = $1', [orgId]),
    // REQ-142 (procedencia vinculante): se carga TODA la procedencia de la
    // organización de una sola vez -- abajo se usa `hasProvenance(entity,
    // id)` para decidir si cada fila es UTILIZABLE en el expediente. Un
    // dato de empresa SIN procedencia registrada (owner/source/updated_at
    // en `field_provenance`) nunca se trata como "aprobado", sin importar
    // qué digan sus demás columnas -- se BLOQUEA explícitamente (mapeado a
    // `approvalStatus: 'rechazado'`, el mismo canal de bloqueo que ya usa
    // `packages/expediente` para cualquier otro motivo de rechazo).
    tx.query<{ entity: string; entity_id: string }>('select distinct entity, entity_id from field_provenance where org_id = $1', [orgId]),
  ]);

  const provenanceKeys = new Set(provenanceRes.rows.map((r) => `${r.entity}:${r.entity_id}`));
  const hasProvenance = (entity: string, entityId: string): boolean => provenanceKeys.has(`${entity}:${entityId}`);

  const profileRow = profileRes.rows[0];
  const profiles: CompanyProfile[] = profileRow
    ? [
        {
          companyId,
          legalName: String(profileRow.legal_name),
          rfc: (profileRow.tax_id as string | null) ?? '',
          // REQ-142: el perfil principal registra procedencia POR CAMPO
          // (`recordFieldProvenance` con `field` = nombre de columna, ver
          // `modules/company/routes.ts` PUT /profile) -- basta con que
          // exista AL MENOS una fila de procedencia para esta fila del
          // perfil (perfil creado por un flujo que sí la registra); un
          // perfil insertado por una vía que nunca declaró procedencia de
          // ningún campo (p. ej. una carga directa a la base de datos que
          // se salte la API) se bloquea explícitamente.
          approvalStatus: hasProvenance('company_profiles', String(profileRow.id)) ? 'aprobado' : 'rechazado',
        },
      ]
    : [];

  const capabilities: CompanyCapability[] = capabilitiesRes.rows.map((r) => ({
    id: String(r.id),
    companyId,
    name: String(r.name),
    description: (r.description as string | null) ?? '',
    evidenceDocId: (r.evidence_ref as string | null) ?? undefined,
    approvalStatus: hasProvenance('capabilities', String(r.id)) ? verifiedToApprovalStatus(Boolean(r.is_verified)) : 'rechazado',
  }));

  // REQ-164: sin evidence_ref no hay forma trazable de dar por buena la
  // experiencia -- se excluye del resolver (nunca se fabrica un
  // evidenceDocId vacío para que "resuelva OK").
  const experience: CompanyExperienceRecord[] = experienceRes.rows
    .filter((r) => r.evidence_ref !== null && r.evidence_ref !== undefined)
    .map((r) => ({
      id: String(r.id),
      companyId,
      description: String(r.title),
      evidenceDocId: String(r.evidence_ref),
      // REQ-142: experiencia sin procedencia -> bloqueo explícito, igual
      // que sin evidencia (REQ-164) -- ambos son formas de "dato no
      // confiable", con canales de rechazo independientes.
      approvalStatus: hasProvenance('experience_records', String(r.id)) ? verifiedToApprovalStatus(Boolean(r.is_verified)) : 'rechazado',
    }));

  const documents: CompanyDocument[] = documentsRes.rows.map((r) => ({
    id: String(r.id),
    companyId,
    type: String(r.document_type),
    label: String(r.document_type),
    issuedAt: timestampToIso(r.created_at as string | Date) ?? asOfIso,
    expiresAt: dateOnlyToMexicoCityIso(r.valid_until as string | Date | null, 'end'),
    approvalStatus: !hasProvenance('company_documents', String(r.id))
      ? 'rechazado'
      : r.valid_until === null || r.valid_until === undefined
        ? 'pendiente_aprobacion'
        : 'aprobado',
  }));

  const signers: CompanySigner[] = signatoriesRes.rows.map((r) => {
    const from = dateOnlyToMexicoCityIso(r.valid_from as string | Date | null, 'start');
    const until = dateOnlyToMexicoCityIso(r.valid_until as string | Date | null, 'end');
    const asOfMs = new Date(asOfIso).getTime();
    const withinWindow = (from === null || new Date(from).getTime() <= asOfMs) && (until === null || asOfMs <= new Date(until).getTime());
    return {
      id: String(r.id),
      companyId,
      name: String(r.full_name),
      role: (r.role_title as string | null) ?? 'firmante',
      // REQ-142: un firmante SIN procedencia nunca cuenta como autorizado,
      // sin importar la ventana de vigencia -- mismo criterio de "dato no
      // utilizable sin procedencia" aplicado al único campo booleano que
      // expone `CompanySigner` (no tiene `approvalStatus`).
      authorized: withinWindow && hasProvenance('authorized_signatories', String(r.id)),
    };
  });

  const rates: ApprovedRate[] = ratesRes.rows.map((r) => {
    const validFrom = dateOnlyToMexicoCityIso(r.valid_from as string | Date | null, 'start') ?? (timestampToIso(r.created_at as string | Date) as string);
    return {
      id: String(r.id),
      companyId,
      concept: String(r.item_code),
      unit: String(r.unit),
      unitPrice: String(r.unit_price),
      currency: (r.currency as ApprovedRate['currency']) ?? 'MXN',
      // REQ-142: tarifa sin procedencia -> bloqueo explícito, sin importar `status`.
      approvalStatus: hasProvenance('approved_rates', String(r.id)) ? rateStatusToApprovalStatus(String(r.status)) : 'rechazado',
      validFrom,
      validUntil: dateOnlyToMexicoCityIso(r.valid_until as string | Date | null, 'end'),
    };
  });

  const resolver = new InMemoryCompanyDataResolver({ profiles, capabilities, experience, documents, signers, rates });

  return {
    resolver,
    profileSnapshot: profileRow ? { ...profileRow, id: String(profileRow.id) } : {},
    documents,
  };
}
