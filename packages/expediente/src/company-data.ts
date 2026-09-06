/**
 * CompanyDataResolver (REQ-157/REQ-158/REQ-164, docs/AMPLIACION-BACKOFFICE.md
 * §6): interfaz a datos REALES aprobados de la empresa. Reglas duras:
 *  - dato ausente → `MissingData` explícito (nunca se infiere ni se usa un
 *    valor por defecto).
 *  - documento vencido a la fecha del acto (no a "hoy") → bloqueo.
 *  - tarifa no aprobada o vencida → bloqueo.
 * Ningún método de este módulo puede devolver un valor inventado: cuando no
 * hay dato o está bloqueado, el resultado lo dice explícitamente y el
 * llamador (TechnicalProposalBuilder/EconomicProposalBuilder) debe
 * propagarlo como bloqueo, nunca rellenarlo.
 */
import { assertExplicitOffset, isPast } from "./types.js";

export type ApprovalStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";

export interface CompanyProfile {
  companyId: string;
  legalName: string;
  rfc: string;
  approvalStatus: ApprovalStatus;
}

export interface CompanyCapability {
  id: string;
  companyId: string;
  name: string;
  description: string;
  evidenceDocId?: string;
  approvalStatus: ApprovalStatus;
}

export interface CompanyExperienceRecord {
  id: string;
  companyId: string;
  description: string;
  evidenceDocId: string;
  approvalStatus: ApprovalStatus;
}

export interface CompanyDocument {
  id: string;
  companyId: string;
  type: string;
  label: string;
  issuedAt: string;
  /** `null` = sin vigencia definida (documento indefinido); NO significa "siempre vigente" para tipos que la ley exige con vigencia. */
  expiresAt: string | null;
  approvalStatus: ApprovalStatus;
}

export interface CompanySigner {
  id: string;
  companyId: string;
  name: string;
  role: string;
  authorized: boolean;
}

export interface ApprovedRate {
  id: string;
  companyId: string;
  concept: string;
  unit: string;
  /** Precio unitario como cadena decimal, p. ej. "1234.56". */
  unitPrice: string;
  currency: "MXN";
  approvalStatus: ApprovalStatus;
  validFrom: string;
  validUntil: string | null;
}

/**
 * Interfaz de persistencia de datos de empresa. `apps/api` la implementará
 * contra `packages/db`; aquí solo hay una implementación en memoria para
 * pruebas.
 */
export interface CompanyDataResolver {
  getProfile(companyId: string): CompanyProfile | undefined;
  getCapabilities(companyId: string): CompanyCapability[];
  getExperience(companyId: string): CompanyExperienceRecord[];
  getDocuments(companyId: string): CompanyDocument[];
  getSigners(companyId: string): CompanySigner[];
  getApprovedRates(companyId: string): ApprovedRate[];
}

export class InMemoryCompanyDataResolver implements CompanyDataResolver {
  constructor(
    private readonly data: {
      profiles?: CompanyProfile[];
      capabilities?: CompanyCapability[];
      experience?: CompanyExperienceRecord[];
      documents?: CompanyDocument[];
      signers?: CompanySigner[];
      rates?: ApprovedRate[];
    },
  ) {}

  getProfile(companyId: string): CompanyProfile | undefined {
    return this.data.profiles?.find((p) => p.companyId === companyId);
  }
  getCapabilities(companyId: string): CompanyCapability[] {
    return (this.data.capabilities ?? []).filter((c) => c.companyId === companyId);
  }
  getExperience(companyId: string): CompanyExperienceRecord[] {
    return (this.data.experience ?? []).filter((e) => e.companyId === companyId);
  }
  getDocuments(companyId: string): CompanyDocument[] {
    return (this.data.documents ?? []).filter((d) => d.companyId === companyId);
  }
  getSigners(companyId: string): CompanySigner[] {
    return (this.data.signers ?? []).filter((s) => s.companyId === companyId);
  }
  getApprovedRates(companyId: string): ApprovedRate[] {
    return (this.data.rates ?? []).filter((r) => r.companyId === companyId);
  }
}

export type BlockingReasonCode =
  | "dato_ausente"
  | "documento_vencido"
  | "documento_no_aprobado"
  | "tarifa_no_aprobada"
  | "tarifa_vencida"
  | "tarifa_aun_no_vigente"
  | "firmante_no_autorizado"
  | "capacidad_no_aprobada"
  | "experiencia_no_aprobada";

export interface FieldResolutionOk<T> {
  status: "ok";
  field: string;
  value: T;
  sourceRef: { docId: string; capturedAt: string };
}

export interface FieldResolutionMissing {
  status: "missing";
  field: string;
}

export interface FieldResolutionBlocked {
  status: "blocked";
  field: string;
  reason: BlockingReasonCode;
  detail: string;
}

export type FieldResolution<T> = FieldResolutionOk<T> | FieldResolutionMissing | FieldResolutionBlocked;

export function isResolved<T>(r: FieldResolution<T>): r is FieldResolutionOk<T> {
  return r.status === "ok";
}

/**
 * Servicio que aplica las reglas duras de REQ-157/REQ-158/REQ-164 sobre un
 * `CompanyDataResolver`. `asOfIso` es la fecha del acto relevante (p. ej.
 * fecha límite de entrega de proposiciones) contra la que se evalúa
 * vigencia — nunca "hoy", salvo que el llamador pase "hoy" explícitamente.
 */
export class CompanyDataService {
  constructor(private readonly resolver: CompanyDataResolver) {}

  resolveDocumentByType(companyId: string, type: string, asOfIso: string): FieldResolution<CompanyDocument> {
    assertExplicitOffset(asOfIso, `asOfIso al resolver documento "${type}"`);
    const field = `documento:${type}`;
    const doc = this.resolver.getDocuments(companyId).find((d) => d.type === type);
    if (!doc) return { status: "missing", field };
    if (doc.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "documento_no_aprobado", detail: `Documento "${type}" en estado "${doc.approvalStatus}", no "aprobado".` };
    }
    if (doc.expiresAt !== null && isPast(doc.expiresAt, asOfIso)) {
      return { status: "blocked", field, reason: "documento_vencido", detail: `Documento "${type}" venció el ${doc.expiresAt}, antes de la fecha del acto (${asOfIso}).` };
    }
    return { status: "ok", field, value: doc, sourceRef: { docId: doc.id, capturedAt: doc.issuedAt } };
  }

  resolveApprovedRate(companyId: string, concept: string, asOfIso: string): FieldResolution<ApprovedRate> {
    assertExplicitOffset(asOfIso, `asOfIso al resolver tarifa "${concept}"`);
    const field = `tarifa:${concept}`;
    const rate = this.resolver.getApprovedRates(companyId).find((r) => r.concept === concept);
    if (!rate) return { status: "missing", field };
    // REQ-160/EX-EXP-07: `ApprovedRate.currency` es "MXN" solo a nivel de
    // TIPOS de TypeScript; un adaptador real con JSON no tipado (p. ej.
    // Postgres) podría colar otro valor sin que nada lo note. Se lanza un
    // error explícito en vez de usar silenciosamente una tarifa en una
    // moneda distinta.
    if ((rate.currency as string) !== "MXN") {
      throw new Error(`Tarifa "${concept}" tiene moneda "${rate.currency}", se esperaba "MXN". Verifique el adaptador de datos.`);
    }
    if (rate.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "tarifa_no_aprobada", detail: `Tarifa "${concept}" en estado "${rate.approvalStatus}", no "aprobado".` };
    }
    assertExplicitOffset(rate.validFrom, `tarifa "${concept}".validFrom`);
    if (new Date(rate.validFrom).getTime() > new Date(asOfIso).getTime()) {
      return { status: "blocked", field, reason: "tarifa_aun_no_vigente", detail: `Tarifa "${concept}" vigente desde ${rate.validFrom}, posterior a la fecha del acto (${asOfIso}).` };
    }
    if (rate.validUntil !== null && isPast(rate.validUntil, asOfIso)) {
      return { status: "blocked", field, reason: "tarifa_vencida", detail: `Tarifa "${concept}" venció el ${rate.validUntil}, antes de la fecha del acto (${asOfIso}).` };
    }
    return { status: "ok", field, value: rate, sourceRef: { docId: rate.id, capturedAt: rate.validFrom } };
  }

  resolveCapability(companyId: string, name: string): FieldResolution<CompanyCapability> {
    const field = `capacidad:${name}`;
    const capability = this.resolver.getCapabilities(companyId).find((c) => c.name === name);
    if (!capability) return { status: "missing", field };
    if (capability.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "capacidad_no_aprobada", detail: `Capacidad "${name}" en estado "${capability.approvalStatus}".` };
    }
    return { status: "ok", field, value: capability, sourceRef: { docId: capability.evidenceDocId ?? capability.id, capturedAt: capability.id } };
  }

  resolveExperience(companyId: string, experienceId: string): FieldResolution<CompanyExperienceRecord> {
    const field = `experiencia:${experienceId}`;
    const record = this.resolver.getExperience(companyId).find((e) => e.id === experienceId);
    if (!record) return { status: "missing", field };
    if (record.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "experiencia_no_aprobada", detail: `Experiencia "${experienceId}" en estado "${record.approvalStatus}".` };
    }
    return { status: "ok", field, value: record, sourceRef: { docId: record.evidenceDocId, capturedAt: record.id } };
  }

  resolveAuthorizedSigner(companyId: string, role: string): FieldResolution<CompanySigner> {
    const field = `firmante:${role}`;
    const signer = this.resolver.getSigners(companyId).find((s) => s.role === role);
    if (!signer) return { status: "missing", field };
    if (!signer.authorized) {
      return { status: "blocked", field, reason: "firmante_no_autorizado", detail: `Firmante "${signer.name}" no está autorizado para el rol "${role}".` };
    }
    return { status: "ok", field, value: signer, sourceRef: { docId: signer.id, capturedAt: signer.id } };
  }
}
