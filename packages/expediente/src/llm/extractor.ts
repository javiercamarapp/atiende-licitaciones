/**
 * Hook de extractor LLM para RequirementMatrix. Complementa (no reemplaza)
 * al `RuleBasedExtractor`: por ejemplo, para requisitos redactados en
 * prosa libre que no calzan en los patrones deterministas. apps/api podrá
 * conectar aquí un cliente real (p. ej. sobre `@atiende/agents`); en este
 * paquete solo se define la interfaz y un `FakeLlmExtractor` determinista
 * para pruebas, sin llamadas de red.
 */
import type { RequirementExtractor, RequirementItem, TenderDocumentText } from "../requirement-matrix.js";
import { nextRequirementId } from "../requirement-matrix.js";

/** Resultado crudo que produciría un modelo de lenguaje para un requisito candidato. */
export interface LlmRequirementCandidate {
  text: string;
  page: number;
  clause?: string;
  obligatoriedad: RequirementItem["obligatoriedad"];
  type: RequirementItem["type"];
  responsibleRole: string;
  deadline: string | null;
  requiredEvidence: string[];
  confidence: number;
  topicKey?: string;
}

export interface LlmExtractorClient {
  /** Debe ser puramente funcional respecto del `doc` dado (mismo doc → mismos candidatos), para reproducibilidad en tests y auditoría. */
  extractCandidates(doc: TenderDocumentText): Promise<LlmRequirementCandidate[]>;
}

/** Adapta un `LlmExtractorClient` a la interfaz `RequirementExtractor` de la matriz. */
export class LlmRequirementExtractor implements RequirementExtractor {
  readonly name = "llm-extractor";
  readonly extractedBy = "llm" as const;

  constructor(private readonly client: LlmExtractorClient) {}

  async extract(doc: TenderDocumentText): Promise<RequirementItem[]> {
    const candidates = await this.client.extractCandidates(doc);
    return candidates.map((candidate) => ({
      id: nextRequirementId(),
      text: candidate.text,
      source: { documentId: doc.documentId, documentLabel: doc.documentLabel, page: candidate.page, clause: candidate.clause },
      obligatoriedad: candidate.obligatoriedad,
      type: candidate.type,
      responsibleRole: candidate.responsibleRole,
      deadline: candidate.deadline,
      requiredEvidence: candidate.requiredEvidence,
      status: "pendiente",
      extractedBy: "llm",
      confidence: candidate.confidence,
      topicKey: candidate.topicKey,
    }));
  }
}

/**
 * Extractor LLM falso para pruebas: devuelve candidatos fijados por el
 * caller (por `documentId`), sin red ni no-determinismo. Sirve para probar
 * el `RequirementMatrixBuilder` con un extractor LLM real "conectado" sin
 * depender de un proveedor externo en la suite de este paquete.
 */
export class FakeLlmExtractorClient implements LlmExtractorClient {
  constructor(private readonly candidatesByDocument: Record<string, LlmRequirementCandidate[]>) {}

  async extractCandidates(doc: TenderDocumentText): Promise<LlmRequirementCandidate[]> {
    return this.candidatesByDocument[doc.documentId] ?? [];
  }
}
