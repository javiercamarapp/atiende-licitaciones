/**
 * REQ-052 — extracción determinista (SIN LLM) de campos estructurados del
 * contrato firmado, sobre el texto ya obtenido por `extractDocumentText`
 * (mismo motor que las bases, E6: PDF con capa de texto o texto plano; un
 * PDF escaneado nunca llega aquí -- ver `contract.routes.ts`, que solo
 * invoca este extractor cuando `status === 'extracted'`).
 *
 * Reglas deterministas (regex), igual precedente que `RuleBasedExtractor`
 * de `@atiende/expediente` para la matriz de requisitos de bases: cada
 * campo detectado trae página (heurística, ver abajo), cláusula (si se
 * encuentra un marcador "CLÁUSULA N" antes de la coincidencia) y una
 * confianza explícita -- NUNCA se inventa un campo que el texto no
 * contiene. Un contrato real puede no mencionar alguno de estos campos con
 * el vocabulario esperado; en ese caso simplemente no aparece en el
 * resultado (mejor "no detectado" que un valor inventado).
 *
 * AE (anti-alucinación, REQ-052 explícito): "el usuario confirma o
 * corrige; nunca se dan por válidos sin confirmación" -- este módulo NUNCA
 * marca un campo como confirmado; todo lo que produce entra a
 * `contract_extracted_fields` con `status = 'sugerido'` (ver
 * `contract.routes.ts`).
 *
 * R6-01/R6-02 (docs/auditoria-2/api-ronda6.md): antes de esta ronda,
 * `sourcePage` era una aproximación PROPORCIONAL (posición del texto /
 * longitud total * número de páginas), porque `pdf-parse` no conservaba los
 * saltos de página reales. Ahora `extractDocumentText` (`pdfjs-dist`)
 * devuelve el texto SEPARADO por página real; este módulo recibe ese
 * arreglo (`pages`) y reporta la página EXACTA donde cayó cada coincidencia
 * -- nunca una aproximación. Con texto plano (una única página virtual),
 * `sourcePage` sigue siendo `1` (no `null`: hay una página real, la única
 * que existe) para mantener el contrato de "nunca se inventa una página sin
 * base real" sin degradar el campo cuando sí hay una página concreta.
 */

export type ContractFieldKey =
  | 'numero_contrato'
  | 'monto_total'
  | 'plazo_entrega'
  | 'garantia_cumplimiento'
  | 'pena_convencional'
  | 'deductiva'
  | 'forma_pago'
  | 'administrador_contrato'
  | 'cesion_cobro';

export interface ExtractedContractField {
  fieldKey: ContractFieldKey;
  /** Fragmento de texto crudo detectado (valor o cláusula completa, recortada a un tamaño razonable para lectura humana). */
  value: string;
  sourcePage: number | null;
  sourceClause: string | null;
  /** 0-1: mayor cuando se capturó un valor específico (monto, fecha, nombre); menor cuando solo se detectó la mención del tema sin un valor aislable. */
  confidence: number;
}

interface FieldRule {
  fieldKey: ContractFieldKey;
  /** Debe traer al menos un grupo de captura útil, o se usa el match completo como valor. */
  pattern: RegExp;
  /** Confianza cuando el patrón captura un valor específico (grupo 1 no vacío y "corto", p. ej. un monto o folio). */
  highConfidence: number;
  /** Confianza cuando solo se detecta la mención del tema (oración completa, sin valor aislable claro). */
  lowConfidence: number;
  /** Máximo de caracteres a conservar del valor detectado (evita persistir párrafos completos). */
  maxValueLength: number;
}

// Cada regla busca EL PRIMER acierto razonable en el documento -- un
// contrato real solo debería declarar un monto total, un plazo de entrega,
// etc. una vez en la cláusula correspondiente; si aparece más de una vez
// (p. ej. resumen + cláusula), la primera coincidencia suele ser la más
// relevante (encabezado/declaraciones) o la propia cláusula, ambas válidas
// como evidencia citable.
const FIELD_RULES: readonly FieldRule[] = [
  {
    fieldKey: 'numero_contrato',
    pattern: /contrato\s+(?:n[uú]mero|n[uú]m\.?|no\.?)\s*[:-]?\s*([A-Za-z0-9][A-Za-z0-9/.-]{2,40})/i,
    highConfidence: 0.75,
    lowConfidence: 0.4,
    maxValueLength: 60,
  },
  {
    fieldKey: 'monto_total',
    pattern: /monto\s+total[^\n\d$]{0,30}\$?\s?([\d][\d,]*(?:\.\d{2})?)\s*(?:\(([^)]{1,80})\))?\s*(?:m\.?n\.?|mxn|pesos)?/i,
    highConfidence: 0.8,
    lowConfidence: 0.45,
    maxValueLength: 120,
  },
  {
    fieldKey: 'plazo_entrega',
    pattern: /plazo\s+de\s+entrega[^.]{0,200}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 220,
  },
  {
    fieldKey: 'garantia_cumplimiento',
    pattern: /garant[ií]a\s+de\s+cumplimiento[^.]{0,220}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 240,
  },
  {
    fieldKey: 'pena_convencional',
    pattern: /pena(?:s)?\s+convencional(?:es)?[^.]{0,220}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 240,
  },
  {
    fieldKey: 'deductiva',
    pattern: /deductiva(?:s)?[^.]{0,220}\./i,
    highConfidence: 0.55,
    lowConfidence: 0.35,
    maxValueLength: 240,
  },
  {
    fieldKey: 'forma_pago',
    pattern: /forma\s+de\s+pago[^.]{0,220}\./i,
    highConfidence: 0.55,
    lowConfidence: 0.35,
    maxValueLength: 240,
  },
  {
    fieldKey: 'administrador_contrato',
    pattern: /administrador(?:a)?\s+del\s+contrato[^\n.]{0,150}/i,
    highConfidence: 0.6,
    lowConfidence: 0.35,
    maxValueLength: 180,
  },
  {
    fieldKey: 'cesion_cobro',
    pattern: /cesi[oó]n\s+de\s+derechos\s+de\s+cobro[^.]{0,220}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 240,
  },
];

const CLAUSE_MARKER = /cl[aá]usula\s+([a-z0-9]+)/i;

/** Busca hacia atrás desde `index` la última mención "CLÁUSULA N" -- null si no hay ninguna antes de esa posición. */
function findNearestClause(text: string, index: number): string | null {
  const before = text.slice(Math.max(0, index - 4000), index);
  let lastMatch: RegExpExecArray | null = null;
  const re = new RegExp(CLAUSE_MARKER, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return null;
  return `Cláusula ${lastMatch[1].toUpperCase()}`;
}

export interface ContractFieldPageText {
  page: number;
  text: string;
}

/** Concatena las páginas en un único string de trabajo, recordando en qué rango de offsets cae cada página real -- así `findNearestClause` puede seguir mirando hacia atrás a través de un límite de página (una cláusula puede empezar en una página y su contenido continuar en la siguiente) sin perder la página REAL de cada coincidencia. */
function concatWithPageBoundaries(pages: readonly ContractFieldPageText[]): { text: string; boundaries: { page: number; start: number; end: number }[] } {
  let text = '';
  const boundaries: { page: number; start: number; end: number }[] = [];
  for (const p of pages) {
    const start = text.length;
    text += p.text;
    boundaries.push({ page: p.page, start, end: text.length });
    text += '\n';
  }
  return { text, boundaries };
}

/** Página REAL que contiene el offset `index` dentro del texto concatenado -- nunca una aproximación; si por alguna razón el índice cae fuera de todos los rangos (no debería), se usa la última página conocida. */
function pageForIndex(index: number, boundaries: { page: number; start: number; end: number }[]): number | null {
  if (boundaries.length === 0) return null;
  for (const b of boundaries) {
    if (index >= b.start && index <= b.end) return b.page;
  }
  return boundaries[boundaries.length - 1].page;
}

export function extractContractFields(pages: readonly ContractFieldPageText[]): ExtractedContractField[] {
  const results: ExtractedContractField[] = [];
  if (pages.length === 0) return results;
  const { text, boundaries } = concatWithPageBoundaries(pages);

  for (const rule of FIELD_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    const capturedValue = match[1]?.trim();
    const rawValue = (capturedValue && capturedValue.length > 0 ? capturedValue : match[0]).trim();
    const value = rawValue.length > rule.maxValueLength ? `${rawValue.slice(0, rule.maxValueLength)}…` : rawValue;
    const confidence = capturedValue && capturedValue.length > 0 && capturedValue.length <= 40 ? rule.highConfidence : rule.lowConfidence;

    results.push({
      fieldKey: rule.fieldKey,
      value,
      sourcePage: pageForIndex(match.index, boundaries),
      sourceClause: findNearestClause(text, match.index),
      confidence,
    });
  }
  return results;
}
