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
 * LIMITACIÓN DOCUMENTADA (honesta, no oculta): `pdf-parse` (usado por
 * `extractDocumentText`) no conserva los saltos de página reales dentro del
 * texto extraído -- no hay forma de saber en qué página EXACTA cae cada
 * coincidencia. `sourcePage` es una aproximación proporcional (posición del
 * texto / longitud total * número de páginas del documento), redondeada
 * hacia arriba -- puede desviarse de la página real, especialmente en
 * documentos con páginas de longitud muy desigual (portadas, anexos). Con
 * texto plano (sin `pageCount`) o `pageCount` desconocido, `sourcePage` es
 * siempre `null` -- nunca se inventa un número de página sin base real.
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

/** Aproximación proporcional de página (ver limitación documentada arriba). `pageCount` null/0 -> siempre null. */
function estimatePage(index: number, textLength: number, pageCount: number | null): number | null {
  if (!pageCount || pageCount <= 0 || textLength <= 0) return null;
  const fraction = Math.min(1, Math.max(0, index / textLength));
  return Math.min(pageCount, Math.max(1, Math.ceil(fraction * pageCount)));
}

export function extractContractFields(text: string, pageCount: number | null = null): ExtractedContractField[] {
  const results: ExtractedContractField[] = [];
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
      sourcePage: estimatePage(match.index, text.length, pageCount),
      sourceClause: findNearestClause(text, match.index),
      confidence,
    });
  }
  return results;
}
