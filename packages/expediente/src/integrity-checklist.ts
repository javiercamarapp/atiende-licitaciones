/**
 * IntegrityChecklist (REQ-160): cubre las 7 dimensiones exigidas —
 * formatos, límites (tamaño/páginas/anexos por "botón" de carga del
 * portal), firmas requeridas, anexos obligatorios, vigencias de
 * documentos, cálculos económicos y consistencia cruzada entre
 * documentos — cada una con su propio resultado y evidencia. Nunca marca
 * una firma como realizada: solo indica "requiere firma del usuario"
 * (REQ-165/REQ-045).
 */
import type { RequirementItem } from "./requirement-matrix.js";
import type { CompanyDocument } from "./company-data.js";
import type { EconomicProposalResult } from "./economic-proposal.js";
import { isPast } from "./types.js";

export type ChecklistDimension =
  | "formatos"
  | "limites"
  | "firmas"
  | "anexos_obligatorios"
  | "vigencias"
  | "calculos_economicos"
  | "consistencia_cruzada";

export type ChecklistResultStatus = "verde" | "ambar" | "rojo";

export interface ChecklistItemResult {
  dimension: ChecklistDimension;
  status: ChecklistResultStatus;
  detail: string;
  evidence: string[];
}

export interface ChecklistReport {
  items: ChecklistItemResult[];
  overallStatus: ChecklistResultStatus;
}

export interface FileArtifact {
  filename: string;
  extension: string;
  sizeBytes: number;
  pages?: number;
}

export interface FormatLimitsConfig {
  allowedExtensions: string[];
  maxFileSizeBytes: number;
  maxPagesPerFile?: number;
  /** Número máximo de anexos/archivos que el portal oficial acepta subir (límite de "botones" de carga). */
  maxUploadSlots: number;
}

export interface SignatureRequirement {
  role: string;
  /** El usuario ya marcó (fuera del sistema) que este documento fue firmado por su cuenta; el sistema nunca produce esta marca por sí mismo. */
  userConfirmedSigned: boolean;
}

export interface IntegrityChecklistInput {
  files: FileArtifact[];
  formatLimits: FormatLimitsConfig;
  requiredSignatures: SignatureRequirement[];
  requiredAnnexes: RequirementItem[]; // type === "anexo" && obligatoriedad === "obligatorio"
  presentAnnexRefs: string[]; // topicKey o requirementId de anexos efectivamente presentes en `files`/expediente
  documentsToValidate: { document: CompanyDocument; asOfIso: string }[];
  economicResult: EconomicProposalResult | null;
  /** Totales a comparar entre "documentos" del expediente (carta vs. anexo económico, etc.) para consistencia cruzada. */
  crossDocumentTotals: { documentLabel: string; total: string }[];
}

function overallFrom(items: ChecklistItemResult[]): ChecklistResultStatus {
  if (items.some((i) => i.status === "rojo")) return "rojo";
  if (items.some((i) => i.status === "ambar")) return "ambar";
  return "verde";
}

export class IntegrityChecklist {
  run(input: IntegrityChecklistInput): ChecklistReport {
    const items: ChecklistItemResult[] = [
      this.checkFormatos(input),
      this.checkLimites(input),
      this.checkFirmas(input),
      this.checkAnexosObligatorios(input),
      this.checkVigencias(input),
      this.checkCalculosEconomicos(input),
      this.checkConsistenciaCruzada(input),
    ];
    return { items, overallStatus: overallFrom(items) };
  }

  private checkFormatos(input: IntegrityChecklistInput): ChecklistItemResult {
    const invalid = input.files.filter((f) => !input.formatLimits.allowedExtensions.includes(f.extension.toLowerCase()));
    if (invalid.length > 0) {
      return {
        dimension: "formatos",
        status: "rojo",
        detail: `${invalid.length} archivo(s) con extensión no permitida: ${invalid.map((f) => f.filename).join(", ")}.`,
        evidence: invalid.map((f) => f.filename),
      };
    }
    return { dimension: "formatos", status: "verde", detail: "Todos los archivos usan extensiones permitidas.", evidence: input.files.map((f) => f.filename) };
  }

  private checkLimites(input: IntegrityChecklistInput): ChecklistItemResult {
    const { maxFileSizeBytes, maxPagesPerFile, maxUploadSlots } = input.formatLimits;
    const problems: string[] = [];
    for (const f of input.files) {
      if (f.sizeBytes > maxFileSizeBytes) problems.push(`${f.filename} excede tamaño máximo (${f.sizeBytes} > ${maxFileSizeBytes} bytes)`);
      if (maxPagesPerFile !== undefined && f.pages !== undefined && f.pages > maxPagesPerFile) {
        problems.push(`${f.filename} excede páginas máximas (${f.pages} > ${maxPagesPerFile})`);
      }
    }
    if (input.files.length > maxUploadSlots) {
      problems.push(`${input.files.length} archivos exceden los ${maxUploadSlots} espacios de carga del portal.`);
    }
    if (problems.length > 0) {
      return { dimension: "limites", status: "rojo", detail: problems.join(" | "), evidence: problems };
    }
    return { dimension: "limites", status: "verde", detail: "Todos los archivos dentro de los límites configurados.", evidence: [] };
  }

  private checkFirmas(input: IntegrityChecklistInput): ChecklistItemResult {
    const pending = input.requiredSignatures.filter((s) => !s.userConfirmedSigned);
    if (pending.length > 0) {
      return {
        dimension: "firmas",
        status: "rojo",
        detail: `Requiere firma del usuario para: ${pending.map((s) => s.role).join(", ")}. El sistema nunca firma ni simula firma.`,
        evidence: pending.map((s) => `pendiente_firma_usuario:${s.role}`),
      };
    }
    return {
      dimension: "firmas",
      status: "verde",
      detail: "Todas las firmas requeridas fueron confirmadas como realizadas por el usuario (fuera del sistema).",
      evidence: input.requiredSignatures.map((s) => `confirmado_por_usuario:${s.role}`),
    };
  }

  private checkAnexosObligatorios(input: IntegrityChecklistInput): ChecklistItemResult {
    const missing = input.requiredAnnexes.filter(
      (req) => !input.presentAnnexRefs.includes(req.topicKey ?? req.id),
    );
    if (missing.length > 0) {
      return {
        dimension: "anexos_obligatorios",
        status: "rojo",
        detail: `Faltan ${missing.length} anexo(s) obligatorio(s): ${missing.map((m) => m.text).join(" | ")}`,
        evidence: missing.map((m) => m.id),
      };
    }
    return { dimension: "anexos_obligatorios", status: "verde", detail: "Todos los anexos obligatorios están presentes.", evidence: input.requiredAnnexes.map((r) => r.id) };
  }

  private checkVigencias(input: IntegrityChecklistInput): ChecklistItemResult {
    const expired = input.documentsToValidate.filter(({ document, asOfIso }) => document.expiresAt !== null && isPast(document.expiresAt, asOfIso));
    if (expired.length > 0) {
      return {
        dimension: "vigencias",
        status: "rojo",
        detail: `${expired.length} documento(s) vencido(s) a la fecha del acto: ${expired.map((e) => e.document.label).join(", ")}.`,
        evidence: expired.map((e) => e.document.id),
      };
    }
    return { dimension: "vigencias", status: "verde", detail: "Todos los documentos vigentes a la fecha del acto.", evidence: input.documentsToValidate.map((d) => d.document.id) };
  }

  private checkCalculosEconomicos(input: IntegrityChecklistInput): ChecklistItemResult {
    if (input.economicResult === null) {
      return { dimension: "calculos_economicos", status: "rojo", detail: "No hay propuesta económica calculada (sin datos o con conceptos bloqueados).", evidence: [] };
    }
    if (input.economicResult.blockedLineItems.length > 0) {
      return {
        dimension: "calculos_economicos",
        status: "rojo",
        detail: `${input.economicResult.blockedLineItems.length} concepto(s) económico(s) bloqueado(s): ${input.economicResult.blockedLineItems.map((b) => b.concept).join(", ")}.`,
        evidence: input.economicResult.blockedLineItems.map((b) => b.concept),
      };
    }
    if (input.economicResult.totals === null) {
      return { dimension: "calculos_economicos", status: "rojo", detail: "Totales económicos no disponibles.", evidence: [] };
    }
    return {
      dimension: "calculos_economicos",
      status: "verde",
      detail: `Total calculado: $${input.economicResult.totals.total} ${input.economicResult.totals.currency}.`,
      evidence: input.economicResult.lineItems.map((li) => li.concept),
    };
  }

  private checkConsistenciaCruzada(input: IntegrityChecklistInput): ChecklistItemResult {
    if (input.crossDocumentTotals.length < 2) {
      return { dimension: "consistencia_cruzada", status: "ambar", detail: "No hay suficientes documentos para verificar consistencia cruzada.", evidence: [] };
    }
    const distinctTotals = new Set(input.crossDocumentTotals.map((d) => d.total));
    if (distinctTotals.size > 1) {
      return {
        dimension: "consistencia_cruzada",
        status: "rojo",
        detail: `Totales inconsistentes entre documentos: ${input.crossDocumentTotals.map((d) => `${d.documentLabel}=$${d.total}`).join(", ")}.`,
        evidence: input.crossDocumentTotals.map((d) => d.documentLabel),
      };
    }
    return { dimension: "consistencia_cruzada", status: "verde", detail: "Mismo total en todos los documentos del expediente.", evidence: input.crossDocumentTotals.map((d) => d.documentLabel) };
  }
}
