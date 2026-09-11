import { MatchingEngine } from '@atiende/sources';
import type { MatchResult, OrganizationProfile, TenderRecord, EligibilityStatus } from '@atiende/sources';
import { SEMANTIC_RELEVANCE_WEIGHT, type SemanticRelevanceResult } from './semantic.js';

/**
 * Adaptador de relevancia (REQ-006/E5): reutiliza el `MatchingEngine`
 * determinista de `@atiende/sources` (packages/sources está commiteado en
 * git, ver dispatch de ronda 2) para el score de RELEVANCIA
 * léxica/semántica. `@atiende/sources` es un paquete puro sin dependencia
 * de base de datos; aquí solo se adapta la fila de `tenders` (esquema de
 * `packages/db`) a su tipo `TenderRecord` y el perfil de empresa real
 * (company_profiles + capabilities + products_services + locations) a su
 * `OrganizationProfile`.
 *
 * TODO de unificación (documentado, no resuelto en esta ronda): el `source`
 * de `TenderRecord` es un enum cerrado (`SourceIdSchema`) pensado para los
 * conectores oficiales de `packages/sources`; el esquema de ingesta de
 * apps/api (`POST /internal/tenders/ingest`) acepta cualquier string de
 * fuente para no acoplarse de más a ese registro. Se hace un cast
 * explícito y documentado (`as TenderRecord['source']`) porque el motor de
 * scoring nunca ramifica sobre el valor exacto de `source`.
 */
const engine = new MatchingEngine();

export interface TenderRowForMatching {
  source: string;
  external_id: string;
  title: string;
  contracting_body: string | null;
  cpv_codes: string[] | null;
  budget_amount: string | number | null;
  currency: string;
  state?: string | null;
  procedure_type_raw?: string | null;
}

export function toTenderRecord(row: TenderRowForMatching): TenderRecord {
  return {
    source: row.source as TenderRecord['source'],
    externalId: row.external_id,
    title: row.title,
    contractingEntity: row.contracting_body ?? 'Entidad no especificada',
    procedureType: 'otro',
    procedureTypeRaw: row.procedure_type_raw ?? undefined,
    classifiers: (row.cpv_codes ?? []).map((code) => ({ scheme: 'CPV' as const, code })),
    budgetAmount: row.budget_amount !== null && row.budget_amount !== undefined ? Number(row.budget_amount) : undefined,
    currency: row.currency || 'MXN',
    dates: {},
    status: 'unknown',
    attachments: [],
    state: row.state ?? undefined,
    // Snapshot no aplica a un registro ya persistido en `tenders` (el raw
    // lake vive en la ingesta, no en el matching); se rellena con un valor
    // neutro porque el motor de scoring no lo utiliza.
    snapshot: { fetchedAt: new Date(), rawHash: '0'.repeat(64) },
  };
}

export interface CompanyProfileForMatching {
  keywords: string[];
  states: string[];
}

export function toOrganizationProfile(profile: CompanyProfileForMatching): OrganizationProfile {
  return {
    id: 'current-org',
    keywords: profile.keywords.length > 0 ? profile.keywords : undefined,
    states: profile.states.length > 0 ? profile.states : undefined,
  };
}

/**
 * Elegibilidad combinada (REQ-168: separada de relevancia, con evidencia
 * por criterio). Se usa un tipo PROPIO (no el `EligibilityCriterionResult`
 * cerrado de `@atiende/sources`, cuyo `requirement` solo admite
 * `budget|states|excludedKeywords`) para poder etiquetar honestamente los
 * criterios DUROS reales del perfil de empresa (documentos/restricciones/
 * registros) que ese paquete puro no puede evaluar por no tener acceso a
 * la base de datos.
 */
export interface EligibilityCriterion {
  requirement: 'budget' | 'states' | 'excludedKeywords' | 'documents_validity' | 'restrictions' | 'registrations' | 'provenance';
  status: EligibilityStatus;
  explanation: string;
}

export interface EligibilityResult {
  status: EligibilityStatus;
  criteria: EligibilityCriterion[];
}

export interface HardEligibilityInput {
  hasExpiredDocuments: boolean;
  expiredDocumentTypes: string[];
  hasPendingVerificationDocuments: boolean;
  hasActiveRestrictions: boolean;
  restrictionKinds: string[];
  hasAnyRegistration: boolean;
  /**
   * REQ-142 (procedencia vinculante, tolerancia cero): etiquetas legibles
   * ("documento:acta_constitutiva", "restriccion:conflicto_interes"...) de
   * cualquier fila de `company_documents`/`restrictions`/`registrations`
   * que NO tenga una entrada en `field_provenance` -- ver
   * `buildProfileAndEligibility` en `routes.ts`. Vacío si todo lo que se
   * usó en el cómputo de elegibilidad dura tiene procedencia registrada.
   */
  fieldsWithoutProvenance: string[];
}

/**
 * Elegibilidad DURA basada en datos REALES del perfil de empresa (documentos
 * vigentes, sin restricciones activas, con al menos un registro/licencia
 * capturado) -- distinta y complementaria a la elegibilidad de
 * `@atiende/sources` (presupuesto/estado/exclusiones léxicas), que no tiene
 * acceso a estas tablas por ser un paquete puro sin base de datos. REQ-166:
 * ausencia de dato nunca produce "cumple"; aquí ausencia total de
 * información de cumplimiento (ni un documento, ni un registro capturado)
 * es "no_evaluable", nunca "cumple" por omisión.
 */
export function evaluateHardEligibility(input: HardEligibilityInput): EligibilityCriterion[] {
  const criteria: EligibilityCriterion[] = [];

  if (input.hasExpiredDocuments) {
    criteria.push({
      requirement: 'documents_validity',
      status: 'no_cumple',
      explanation: `Documento(s) vencido(s): ${input.expiredDocumentTypes.join(', ')}. No cumple vigencia documental (REQ-023).`,
    });
  } else if (input.hasPendingVerificationDocuments) {
    criteria.push({
      requirement: 'documents_validity',
      status: 'no_evaluable',
      explanation: 'Hay documentos sin fecha de vigencia capturada; no es posible confirmar cumplimiento documental.',
    });
  } else {
    criteria.push({
      requirement: 'documents_validity',
      status: 'cumple',
      explanation: 'Ningún documento de empresa está vencido ni pendiente de verificación.',
    });
  }

  criteria.push({
    requirement: 'restrictions',
    status: input.hasActiveRestrictions ? 'no_cumple' : 'cumple',
    explanation: input.hasActiveRestrictions
      ? `Restricción(es) activa(s) declaradas en el perfil: ${input.restrictionKinds.join(', ')}.`
      : 'Sin restricciones activas declaradas en el perfil.',
  });

  criteria.push({
    requirement: 'registrations',
    status: input.hasAnyRegistration ? 'cumple' : 'no_evaluable',
    explanation: input.hasAnyRegistration
      ? 'La organización tiene al menos un registro/licencia capturado.'
      : 'La organización no tiene ningún registro/licencia capturado en su perfil; no es posible evaluar elegibilidad documental.',
  });

  // REQ-142: procedencia por campo VINCULANTE en matching -- un dato sin
  // `field_provenance` (owner/source/fecha de captura) NUNCA cuenta como
  // "cumple", sin importar lo que digan sus demás columnas (vigencia,
  // tipo, etc.). Bloqueo explícito, con la etiqueta de cada dato afectado.
  if (input.fieldsWithoutProvenance.length > 0) {
    criteria.push({
      requirement: 'provenance',
      status: 'no_evaluable',
      explanation: `Dato(s) sin procedencia registrada (field_provenance ausente), no utilizable(s) en matching: ${input.fieldsWithoutProvenance.join(', ')}.`,
    });
  }

  return criteria;
}

function combineStatus(statuses: EligibilityStatus[]): EligibilityStatus {
  if (statuses.length === 0) return 'no_evaluable';
  if (statuses.includes('no_cumple')) return 'no_cumple';
  if (statuses.includes('no_evaluable')) return 'no_evaluable';
  return 'cumple';
}

/**
 * Igual que `MatchCriterionResult` de `@atiende/sources`, pero con `criterion`
 * ampliado para admitir `"semantic_similarity"` (REQ-006): el motor léxico
 * puro de `packages/sources` no conoce ese criterio -- lo añade
 * `blendRelevance` aquí, en la capa que sí tiene acceso a embeddings/BD.
 */
export type RelevanceCriterion = Omit<MatchResult['criteria'][number], 'criterion'> & {
  criterion: MatchResult['criteria'][number]['criterion'] | 'semantic_similarity';
};

export interface FullMatchResult {
  tenderKey: string;
  relevance: { score: number; criteria: RelevanceCriterion[] };
  eligibility: EligibilityResult;
  missingProfileFields: string[];
}

/**
 * REQ-006 (matching híbrido): combina la relevancia léxica/de reglas
 * (`base.score`, de `packages/sources`, sin tocar) con la relevancia
 * semántica (embeddings/pgvector, `apps/api/src/modules/matching/semantic.ts`)
 * cuando esta última está disponible. `semantic === null` (perfil o
 * convocatoria sin texto utilizable) deja el comportamiento IDÉNTICO al de
 * antes de esta ronda: 100% léxico, sin rescalar ni añadir criterios --
 * nunca se inventa una señal semántica que no se pudo calcular.
 *
 * Cuando sí hay semántica, cada criterio léxico existente se reescala por
 * `1 - SEMANTIC_RELEVANCE_WEIGHT` (conserva sus proporciones relativas) y se
 * añade UN criterio nuevo "semantic_similarity" con el resto del peso, de
 * modo que `sum(criteria[].score) === relevance.score` se mantiene como
 * invariante explicable (REQ-168: cada punto del score tiene un criterio
 * visible que lo respalda).
 */
export function blendRelevance(
  lexical: { score: number; criteria: MatchResult['criteria'] },
  semantic: SemanticRelevanceResult | null
): { score: number; criteria: RelevanceCriterion[] } {
  if (!semantic) return lexical;

  const lexicalWeight = 1 - SEMANTIC_RELEVANCE_WEIGHT;
  const rescaledLexical: RelevanceCriterion[] = lexical.criteria.map((c) => ({
    ...c,
    score: round2(c.score * lexicalWeight),
    maxScore: round2(c.maxScore * lexicalWeight),
  }));
  const semanticMaxScore = round2(100 * SEMANTIC_RELEVANCE_WEIGHT);
  const semanticScore = round2((semantic.score0to100 / 100) * semanticMaxScore);
  const semanticCriterion: RelevanceCriterion = {
    criterion: 'semantic_similarity',
    score: semanticScore,
    maxScore: semanticMaxScore,
    explanation:
      `Similitud semántica (embeddings, modelo "${semantic.model}") entre el perfil de la organización y el ` +
      `texto de la convocatoria (título, entidad, clasificadores y anexos técnicos disponibles): coseno ` +
      `${round2(semantic.cosine)} sobre escala 0-100 -> ${round2(semantic.score0to100)}.`,
  };
  const criteria = [...rescaledLexical, semanticCriterion];
  const score = round2(criteria.reduce((sum, c) => sum + c.score, 0));
  return { score: clamp(score, 0, 100), criteria };
}

export function computeMatch(
  record: TenderRecord,
  profile: OrganizationProfile,
  hardCriteria: EligibilityCriterion[],
  missingProfileFields: string[],
  semantic: SemanticRelevanceResult | null = null
): FullMatchResult {
  const base = engine.score(record, profile);
  const combinedCriteria: EligibilityCriterion[] = [...base.eligibility.criteria, ...hardCriteria];
  const relevance = blendRelevance({ score: base.score, criteria: base.criteria }, semantic);
  return {
    tenderKey: base.tenderKey,
    relevance,
    eligibility: {
      status: combineStatus(combinedCriteria.map((c) => c.status)),
      criteria: combinedCriteria,
    },
    missingProfileFields,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
