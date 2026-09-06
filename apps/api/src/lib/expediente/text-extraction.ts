/**
 * Extracción de texto de documentos de bases (E6). Cobertura honesta de esta
 * ronda:
 *  - PDF con capa de texto: `pdf-parse` (import directo de
 *    `pdf-parse/lib/pdf-parse.js`, NO del `index.js` del paquete -- ese
 *    archivo trae un modo de depuración que intenta leer un PDF de ejemplo
 *    del propio paquete cuando `module.parent` es `undefined`, algo que
 *    revienta bajo ESM/tsx en este monorepo).
 *  - Texto plano (`.txt`, mime `text/plain` o sin mime reconocible que
 *    decodifique como UTF-8 imprimible): se usa tal cual.
 *  - PDF SIN capa de texto (escaneado / solo imagen): NO se hace OCR en esta
 *    ronda. El resultado es el estado EXPLÍCITO `"requires_ocr"` -- nunca se
 *    deja `extractedText` vacío como si el documento no tuviera contenido
 *    relevante (REQ-166: ausencia de dato nunca se traduce en "cumple"/"sin
 *    requisitos").
 *  - Cualquier otro formato (docx, imagen suelta, etc.): `"failed"` con
 *    detalle explícito; tampoco se inventa texto.
 */
// @ts-expect-error -- pdf-parse no publica tipos para el subpath interno; ver comentario arriba sobre por qué se evita el index.js del paquete.
import pdfParseInternal from 'pdf-parse/lib/pdf-parse.js';

export type TextExtractionStatus = 'extracted' | 'requires_ocr' | 'failed';

export interface TextExtractionResult {
  status: TextExtractionStatus;
  text: string | null;
  pageCount: number | null;
  detail?: string;
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Heurística simple de "texto plano": decodifica UTF-8 y verifica que la proporción de caracteres de control (fuera de espacios/saltos) sea baja. */
function looksLikePlainText(buffer: Buffer): string | null {
  const text = buffer.toString('utf8');
  if (text.length === 0) return null;
  let controlCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) controlCount += 1;
  }
  if (controlCount / text.length > 0.02) return null; // demasiados bytes no imprimibles: probablemente binario, no texto.
  return text;
}

export async function extractDocumentText(buffer: Buffer, opts: { mimeType?: string | null; filename?: string | null } = {}): Promise<TextExtractionResult> {
  const filename = (opts.filename ?? '').toLowerCase();
  const isPdfByHint = opts.mimeType === 'application/pdf' || filename.endsWith('.pdf') || looksLikePdf(buffer);

  if (isPdfByHint) {
    try {
      const parsed = await pdfParseInternal(buffer);
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      const pageCount = typeof parsed.numpages === 'number' ? parsed.numpages : null;
      if (text.length === 0) {
        return {
          status: 'requires_ocr',
          text: null,
          pageCount,
          detail: 'PDF sin capa de texto extraíble (probablemente escaneado). Requiere OCR, no soportado en esta ronda.',
        };
      }
      return { status: 'extracted', text, pageCount };
    } catch (err) {
      return {
        status: 'failed',
        text: null,
        pageCount: null,
        detail: `No se pudo procesar el PDF: ${(err as Error).message}`,
      };
    }
  }

  const isTextByHint = opts.mimeType === 'text/plain' || filename.endsWith('.txt') || filename.endsWith('.md');
  const plainText = looksLikePlainText(buffer);
  if (isTextByHint || plainText !== null) {
    const text = plainText ?? buffer.toString('utf8');
    if (text.trim().length === 0) {
      return { status: 'failed', text: null, pageCount: null, detail: 'Archivo de texto vacío.' };
    }
    return { status: 'extracted', text, pageCount: null };
  }

  return {
    status: 'failed',
    text: null,
    pageCount: null,
    detail: `Formato no soportado en esta ronda (solo PDF con texto y texto plano). mimeType=${opts.mimeType ?? 'desconocido'}`,
  };
}
