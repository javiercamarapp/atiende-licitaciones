/**
 * RequirementMatrix (REQ-156, docs/AMPLIACION-BACKOFFICE.md §5): a partir
 * del texto de las bases (y sus anexos/aclaraciones) por página, produce
 * `RequirementItem[]` con fuente, obligatoriedad, tipo, responsable, fecha
 * límite (America/Mexico_City), evidencia requerida y estado. Cuando dos
 * documentos se contradicen (p. ej. dos plazos distintos para el mismo
 * tema), se emite un `Conflict` explícito y escalado — nunca se elige un
 * valor en silencio (REQ-166).
 */

import { MEXICO_CITY_TZ } from "./types.js";

export type Obligatoriedad = "obligatorio" | "opcional" | "condicional";

export type RequirementType = "tecnico" | "economico" | "legal" | "administrativo" | "anexo";

export type RequirementStatus = "pendiente" | "en_progreso" | "cumplido" | "bloqueado" | "no_evaluable";

export interface RequirementSource {
  documentId: string;
  documentLabel: string;
  page: number;
  clause?: string;
}

/**
 * Clave de tema usada solo para detección de conflictos entre documentos
 * (p. ej. "plazo_entrega_proposiciones"). No forma parte del contrato
 * público mínimo del ítem (REQ-156 exige los 7 campos de gestión, no esta
 * clave), pero se conserva para trazabilidad de por qué se generó un
 * `Conflict`.
 */
export type TopicKey = string;

export interface RequirementItem {
  id: string;
  text: string;
  source: RequirementSource;
  obligatoriedad: Obligatoriedad;
  type: RequirementType;
  /** Rol responsable de cumplir el requisito (p. ej. "legal", "finanzas", "licitador"). */
  responsibleRole: string;
  /** ISO 8601 con offset explícito de America/Mexico_City, o `null` si las bases no fijan fecha para este ítem. */
  deadline: string | null;
  requiredEvidence: string[];
  status: RequirementStatus;
  extractedBy: "rule" | "llm";
  confidence?: number;
  topicKey?: TopicKey;
}

export type ConflictKind = "deadline_mismatch" | "obligatoriedad_mismatch" | "duplicate_ambiguous";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  topicKey: TopicKey;
  description: string;
  items: RequirementItem[];
  status: "abierto" | "escalado";
}

export interface TenderPageText {
  page: number;
  text: string;
}

export interface TenderDocumentText {
  documentId: string;
  documentLabel: string;
  /** Momento en que este documento (versión) se publicó/capturó — usado para saber cuál es "más nuevo" a efectos de trazabilidad, aunque un conflicto nunca se resuelve solo por antigüedad. */
  publishedAt: string;
  pages: TenderPageText[];
}

/** Cualquier extractor determinista o basado en LLM implementa esta interfaz. */
export interface RequirementExtractor {
  readonly name: string;
  readonly extractedBy: "rule" | "llm";
  extract(doc: TenderDocumentText): RequirementItem[] | Promise<RequirementItem[]>;
}

let itemCounter = 0;
export function nextRequirementId(): string {
  itemCounter += 1;
  return `req-${itemCounter}`;
}

let conflictCounter = 0;
function nextConflictId(): string {
  conflictCounter += 1;
  return `conflict-${conflictCounter}`;
}

/**
 * Extractor determinista basado en reglas/patrones. Cubre los patrones más
 * comunes de bases de licitación mexicanas: obligatoriedad léxica, tipo por
 * palabra clave, plazos con fecha explícita, y anexos.
 *
 * Este extractor es intencionalmente conservador: ante ambigüedad, clasifica
 * como `condicional`/sin fecha antes que inventar un valor.
 */
export class RuleBasedExtractor implements RequirementExtractor {
  readonly name = "rule-based-v1";
  readonly extractedBy = "rule" as const;

  extract(doc: TenderDocumentText): RequirementItem[] {
    const items: RequirementItem[] = [];
    for (const page of doc.pages) {
      const sentences = splitSentences(page.text);
      for (const sentence of sentences) {
        const item = this.classifySentence(sentence, doc, page.page);
        if (item) items.push(item);
      }
    }
    return items;
  }

  private classifySentence(sentence: string, doc: TenderDocumentText, page: number): RequirementItem | null {
    const lower = sentence.toLowerCase();
    if (!looksLikeRequirement(lower)) return null;

    const obligatoriedad = classifyObligatoriedad(lower);
    const type = classifyType(lower);
    const responsibleRole = classifyResponsibleRole(type);
    const { deadline, topicKey: deadlineTopic } = extractDeadline(lower);
    const requiredEvidence = extractRequiredEvidence(lower, type);
    const topicKey = deadlineTopic ?? classifyTopicKey(lower, type);

    return {
      id: nextRequirementId(),
      text: sentence.trim(),
      source: { documentId: doc.documentId, documentLabel: doc.documentLabel, page, clause: extractClause(sentence) },
      obligatoriedad,
      type,
      responsibleRole,
      deadline,
      requiredEvidence,
      status: "pendiente",
      extractedBy: "rule",
      confidence: 0.7,
      topicKey,
    };
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.;\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

const REQUIREMENT_MARKERS = [
  "deberá",
  "deberán",
  "debe presentar",
  "es obligatorio",
  "obligatorio presentar",
  "se requiere",
  "requisito",
  "anexo obligatorio",
  "bajo protesta de decir verdad",
  "carta de",
  "escrito en el que manifieste",
  "fianza de",
  "garantía de",
  "podrá presentar",
  "opcionalmente",
  // Anuncios de plazo: no siempre usan léxico de obligatoriedad, pero fijan
  // una fecha crítica del procedimiento que la matriz debe capturar igual.
  "a más tardar",
  "entrega de proposiciones",
  "presentación de proposiciones",
  "acto de presentación",
  "junta de aclaraciones",
  "fecha límite",
];

function looksLikeRequirement(lower: string): boolean {
  return REQUIREMENT_MARKERS.some((marker) => lower.includes(marker));
}

function classifyObligatoriedad(lower: string): Obligatoriedad {
  if (lower.includes("podrá presentar") || lower.includes("opcionalmente") || lower.includes("de manera opcional")) {
    return "opcional";
  }
  if (lower.includes("en caso de") || lower.includes("cuando aplique") || lower.includes("si el licitante")) {
    return "condicional";
  }
  if (
    lower.includes("deberá") ||
    lower.includes("deberán") ||
    lower.includes("es obligatorio") ||
    lower.includes("obligatorio presentar") ||
    lower.includes("anexo obligatorio")
  ) {
    return "obligatorio";
  }
  return "condicional";
}

function classifyType(lower: string): RequirementType {
  if (/(fianza|garantía|precio|tarifa|cotizaci[oó]n|iva|presupuesto|econ[oó]mic)/.test(lower)) return "economico";
  if (/(escritura|poder notarial|acta constitutiva|rfc|opini[oó]n de cumplimiento|32-?d|repse|legal)/.test(lower)) {
    return "legal";
  }
  if (/(anexo)/.test(lower)) return "anexo";
  if (/(experiencia|capacidad t[eé]cnica|especificaci[oó]n t[eé]cnica|metodolog[ií]a|t[eé]cnic)/.test(lower)) {
    return "tecnico";
  }
  return "administrativo";
}

function classifyResponsibleRole(type: RequirementType): string {
  switch (type) {
    case "economico":
      return "finanzas";
    case "legal":
      return "legal";
    case "tecnico":
      return "licitador";
    case "anexo":
      return "licitador";
    default:
      return "licitador";
  }
}

function classifyTopicKey(lower: string, type: RequirementType): TopicKey | undefined {
  if (lower.includes("fianza de cumplimiento") || lower.includes("garantía de cumplimiento")) {
    return "garantia_cumplimiento";
  }
  if (lower.includes("opinión de cumplimiento") || lower.includes("32-d")) return "opinion_cumplimiento_sat";
  if (lower.includes("acta constitutiva")) return "acta_constitutiva";
  if (type === "anexo" && lower.includes("anexo")) {
    const match = lower.match(/anexo\s+([a-z0-9]+)/);
    if (match) return `anexo_${match[1]}`;
  }
  return undefined;
}

const MESES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/**
 * Extrae una fecha límite explícita del texto y la fija a las 23:59:59 en
 * America/Mexico_City (offset fijo -06:00; México eliminó el horario de
 * verano nacional desde 2022, salvo franja fronteriza no aplicable a
 * licitaciones federales). Si el texto no trae una fecha inequívoca, regresa
 * `null` — nunca se infiere una fecha por defecto (REQ-166).
 */
export function extractDeadline(lower: string): { deadline: string | null; topicKey?: TopicKey } {
  // Patrón "a más tardar el DD de <mes> de/del AAAA" o "... a las HH:MM horas"
  // (EX-EXP-06: "del" es tan común en español como "de" antes del año — se
  // aceptan ambos).
  const monthNameMatch = lower.match(/(\d{1,2}) de ([a-záéíóú]+) del? (\d{4})(?: a las (\d{1,2}):(\d{2}) horas)?/);
  if (monthNameMatch) {
    const day = Number(monthNameMatch[1]);
    const monthName = monthNameMatch[2];
    const year = Number(monthNameMatch[3]);
    const month = MESES[monthName];
    if (month) {
      const { hour, minute, second } = deadlineTimeOf(monthNameMatch[4], monthNameMatch[5]);
      const iso = buildMexicoCityIso(year, month, day, hour, minute, second);
      return { deadline: iso, topicKey: deadlineTopicKeyOf(lower) };
    }
  }

  // Patrón numérico "DD/MM/AAAA" o "DD-MM-AAAA" (EX-EXP-06): tan común como
  // el formato con nombre de mes en bases/actas reales, y antes no se
  // reconocía en absoluto — el ítem quedaba sin `deadline` ni `topicKey` y
  // no podía participar en `detectConflicts`.
  const numericMatch = lower.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?: a las (\d{1,2}):(\d{2}) horas)?/);
  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]);
    const year = Number(numericMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const { hour, minute, second } = deadlineTimeOf(numericMatch[4], numericMatch[5]);
      const iso = buildMexicoCityIso(year, month, day, hour, minute, second);
      return { deadline: iso, topicKey: deadlineTopicKeyOf(lower) };
    }
  }

  return { deadline: null };
}

/** Hora/minuto/segundo de un plazo: si el texto trae hora explícita se usa tal cual (segundo 0); si no, se fija a las 23:59:59 (fin del día), nunca inferida a medias. */
function deadlineTimeOf(hourGroup?: string, minuteGroup?: string): { hour: number; minute: number; second: number } {
  if (hourGroup) return { hour: Number(hourGroup), minute: Number(minuteGroup), second: 0 };
  return { hour: 23, minute: 59, second: 59 };
}

function deadlineTopicKeyOf(lower: string): TopicKey | undefined {
  if (lower.includes("entrega de proposiciones") || lower.includes("presentación de proposiciones") || lower.includes("acto de presentación")) {
    return "plazo_entrega_proposiciones";
  }
  if (lower.includes("junta de aclaraciones")) return "plazo_junta_aclaraciones";
  if (lower.includes("fallo")) return "plazo_fallo";
  return undefined;
}

/** Construye un ISO 8601 con el offset fijo -06:00 de America/Mexico_City. */
export function buildMexicoCityIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}-06:00`;
}

function extractClause(sentence: string): string | undefined {
  const match = sentence.match(/(cl[aá]usula|numeral|punto|anexo)\s+([a-z0-9.]+)/i);
  return match ? `${match[1]} ${match[2]}` : undefined;
}

function extractRequiredEvidence(lower: string, type: RequirementType): string[] {
  const evidence: string[] = [];
  if (lower.includes("fianza") || lower.includes("garantía")) evidence.push("póliza_de_fianza");
  if (lower.includes("opinión de cumplimiento") || lower.includes("32-d")) evidence.push("opinión_32d_sat");
  if (lower.includes("acta constitutiva")) evidence.push("acta_constitutiva");
  if (lower.includes("poder notarial")) evidence.push("poder_notarial");
  if (type === "anexo") {
    const match = lower.match(/anexo\s+([a-z0-9]+)/);
    if (match) evidence.push(`anexo_${match[1]}_firmado`);
  }
  if (evidence.length === 0 && type === "economico") evidence.push("cotización_o_tarifa_aprobada");
  return evidence;
}

export interface RequirementMatrixResult {
  items: RequirementItem[];
  conflicts: Conflict[];
}

/**
 * Ensambla la matriz combinando uno o más extractores sobre uno o más
 * documentos (bases + anexos + aclaraciones), y detecta conflictos entre
 * documentos para el mismo `topicKey` (p. ej. dos plazos distintos de
 * entrega). Los conflictos se marcan `escalado`: ningún ítem se descarta ni
 * se "gana" en silencio.
 */
export class RequirementMatrixBuilder {
  constructor(private readonly extractors: RequirementExtractor[]) {}

  async build(docs: TenderDocumentText[]): Promise<RequirementMatrixResult> {
    const items: RequirementItem[] = [];
    for (const doc of docs) {
      for (const extractor of this.extractors) {
        const extracted = await extractor.extract(doc);
        items.push(...extracted);
      }
    }
    const conflicts = detectConflicts(items);
    // Los ítems involucrados en un conflicto de plazo quedan explícitamente
    // "bloqueados" hasta que un humano lo resuelva y escale — nunca se
    // asume ninguno de los dos plazos.
    const blockedIds = new Set(conflicts.flatMap((c) => c.items.map((i) => i.id)));
    const resolvedItems = items.map((item) =>
      blockedIds.has(item.id) && item.deadline !== null ? { ...item, status: "bloqueado" as RequirementStatus } : item,
    );
    return { items: resolvedItems, conflicts };
  }
}

function detectConflicts(items: RequirementItem[]): Conflict[] {
  const byTopic = new Map<TopicKey, RequirementItem[]>();
  for (const item of items) {
    if (!item.topicKey) continue;
    const list = byTopic.get(item.topicKey) ?? [];
    list.push(item);
    byTopic.set(item.topicKey, list);
  }

  const conflicts: Conflict[] = [];
  for (const [topicKey, group] of byTopic) {
    if (group.length < 2) continue;

    const distinctDeadlines = new Set(group.filter((i) => i.deadline !== null).map((i) => i.deadline));
    if (distinctDeadlines.size > 1) {
      conflicts.push({
        id: nextConflictId(),
        kind: "deadline_mismatch",
        topicKey,
        description: `Se encontraron ${distinctDeadlines.size} fechas límite distintas para "${topicKey}" en documentos distintos. Requiere escalado humano; ninguna se aplica automáticamente.`,
        items: group,
        status: "escalado",
      });
      continue;
    }

    const distinctObligatoriedad = new Set(group.map((i) => i.obligatoriedad));
    if (distinctObligatoriedad.size > 1) {
      conflicts.push({
        id: nextConflictId(),
        kind: "obligatoriedad_mismatch",
        topicKey,
        description: `Obligatoriedad contradictoria para "${topicKey}" entre documentos (${Array.from(distinctObligatoriedad).join(", ")}).`,
        items: group,
        status: "escalado",
      });
    }
  }
  return conflicts;
}

/** Utilidad de solo pruebas: resetea contadores globales para IDs deterministas entre tests. */
export function resetRequirementCounters(): void {
  itemCounter = 0;
  conflictCounter = 0;
}

export { MEXICO_CITY_TZ };
