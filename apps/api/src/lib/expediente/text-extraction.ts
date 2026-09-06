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
 *
 * AE-04 (docs/auditoria-2/api-expediente.md, MEDIA): el texto extraído
 * (sobre todo por la rama de "texto plano", que no analiza estructura
 * alguna) podía contener HTML/`<script>` sin ningún indicio de ser PDF,
 * persistirse tal cual, y devolverse SIN escapar en
 * `description`/`sourceExcerpt` de `GET /tenders/:id/matrix` -- un vector
 * de XSS almacenado para cualquier frontend que renderizara esos campos
 * sin escapar. Se sanea (`sanitizePlainText`) ANTES de persistir: se
 * elimina el contenido de `<script>`/`<style>` por completo y se quita
 * cualquier otra etiqueta HTML restante, dejando solo texto plano.
 *
 * AE-05 (anti "PDF bomb"): además del límite de tamaño de subida (~22MB,
 * ver `lib/storage.ts`), se acota el número de páginas y el tamaño del
 * texto extraído de un PDF -- un PDF con miles de páginas/objetos
 * repetidos podría inflar el texto extraído en memoria mucho más allá del
 * tamaño del archivo original.
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

/** AE-05: límites anti "PDF bomb" -- un PDF real de licitación (bases + anexos) nunca debería acercarse a estos límites; existen para acotar el costo de procesar un archivo adversarial, no para restringir el uso normal. */
const MAX_PDF_PAGES = 500;
const MAX_EXTRACTED_TEXT_LENGTH = 5_000_000; // ~5MB de texto extraído.

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

/**
 * AE-04: elimina por completo el contenido de `<script>`/`<style>` (nunca
 * solo la etiqueta -- dejar el contenido visible como texto sería igual de
 * indeseable para un documento que se supone es texto plano) y quita
 * cualquier otra etiqueta HTML restante, conservando el texto entre ellas.
 * El resultado se persiste como texto plano; nunca se decide aquí cómo
 * escapar al renderizar (responsabilidad del consumidor), pero se elimina
 * la posibilidad de que el propio contenido almacenado sea HTML ejecutable.
 */
function sanitizePlainText(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]+>/g, '');
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
      // AE-05 (anti "PDF bomb"): rechazar ANTES de persistir un texto
      // desproporcionadamente grande o un PDF con demasiadas páginas.
      if (pageCount !== null && pageCount > MAX_PDF_PAGES) {
        return {
          status: 'failed',
          text: null,
          pageCount,
          detail: `PDF con demasiadas páginas (${pageCount} > límite de ${MAX_PDF_PAGES} de esta ronda) -- rechazado como medida anti "PDF bomb".`,
        };
      }
      if (text.length > MAX_EXTRACTED_TEXT_LENGTH) {
        return {
          status: 'failed',
          text: null,
          pageCount,
          detail: `Texto extraído del PDF excede el límite de esta ronda (${text.length} > ${MAX_EXTRACTED_TEXT_LENGTH} caracteres) -- rechazado como medida anti "PDF bomb".`,
        };
      }
      return { status: 'extracted', text: sanitizePlainText(text), pageCount };
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
    // AE-04: sanitizar ANTES de persistir -- ver docstring del módulo. Si
    // el contenido era ÍNTEGRAMENTE HTML/script (nada de texto real fuera
    // de las etiquetas), el resultado queda vacío -- se marca "failed"
    // explícito, nunca "extracted" con texto vacío (REQ-166).
    const sanitized = sanitizePlainText(text);
    if (sanitized.trim().length === 0) {
      return { status: 'failed', text: null, pageCount: null, detail: 'El contenido quedó vacío después de sanitizar HTML/script embebido (AE-04); no se persiste como "extracted" un texto vacío.' };
    }
    return { status: 'extracted', text: sanitized, pageCount: null };
  }

  return {
    status: 'failed',
    text: null,
    pageCount: null,
    detail: `Formato no soportado en esta ronda (solo PDF con texto y texto plano). mimeType=${opts.mimeType ?? 'desconocido'}`,
  };
}
