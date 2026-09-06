/**
 * Extracción de texto de documentos de bases y del contrato firmado (E6,
 * REQ-052). Cobertura honesta de esta ronda:
 *  - PDF con capa de texto: `pdfjs-dist` (build "legacy", el empaquetado
 *    pensado para Node sin DOM), extracción PÁGINA POR PÁGINA REAL (nunca
 *    una aproximación proporcional) -- ver `pages` en `TextExtractionResult`.
 *  - Texto plano (`.txt`, mime `text/plain` o sin mime reconocible que
 *    decodifique como UTF-8 imprimible): se usa tal cual, como una única
 *    "página" virtual (no hay noción de página real en texto plano).
 *  - PDF SIN capa de texto (escaneado / solo imagen): NO se hace OCR en esta
 *    ronda. El resultado es el estado EXPLÍCITO `"requires_ocr"` -- nunca se
 *    deja `extractedText` vacío como si el documento no tuviera contenido
 *    relevante (REQ-166: ausencia de dato nunca se traduce en "cumple"/"sin
 *    requisitos").
 *  - Cualquier otro formato (docx, imagen suelta, etc.): `"failed"` con
 *    detalle explícito; tampoco se inventa texto.
 *
 * R6-01/R6-02 (docs/auditoria-2/api-ronda6.md, ALTA): `pdf-parse@1.1.1`
 * empaqueta una versión de `pdf.js` de 2017 (v1.10.100) que NO soporta el
 * formato de referencia cruzada por STREAM (cross-reference stream, PDF
 * 1.5+) -- el que `pdf-lib` genera por defecto y el que emiten muchos
 * generadores reales (exportar desde Word/LibreOffice, imprimir a PDF desde
 * un navegador moderno, herramientas de firma electrónica). Solo soportaba
 * el formato clásico de tabla xref (PDF <=1.4). Consecuencia real: el motor
 * de extracción del contrato firmado (REQ-052, que reutiliza este mismo
 * módulo) nunca se probaba con éxito contra esa categoría de PDF, y
 * probablemente fallaba en producción para ella -- clasificado (de forma
 * correcta, nunca inventando contenido) como `"failed"`, pero sin que la
 * causa fuera ese defecto del extractor y no del documento del usuario. Se
 * sustituyó por `pdfjs-dist` (build "legacy" para Node, sin canvas/DOM),
 * que soporta ambos formatos de xref -- ver fixtures
 * `test/fixtures/pdf/xref-stream.pdf` (generado con `pdf-lib`, cross-
 * reference stream) y `test/fixtures/pdf/xref-classic.pdf` (tabla xref
 * clásica, PDF 1.4) en `expediente-documents-and-matrix.test.ts` y
 * `expediente-text-extraction.test.ts`.
 *
 * AE-04 (docs/auditoria-2/api-expediente.md, MEDIA): el texto extraído
 * (sobre todo por la rama de "texto plano", que no analiza estructura
 * alguna) podía contener HTML/`<script>` sin ningún indicio de ser PDF,
 * persistirse tal cual, y devolverse SIN escapar en
 * `description`/`sourceExcerpt` de `GET /tenders/:id/matrix` -- un vector
 * de XSS almacenado para cualquier frontend que renderizara esos campos
 * sin escapar. Se sanea (`sanitizePlainText`) ANTES de persistir, página
 * por página: se elimina el contenido de `<script>`/`<style>` por completo
 * y se quita cualquier otra etiqueta HTML restante, dejando solo texto
 * plano.
 *
 * AE-05 (anti "PDF bomb"): además del límite de tamaño de subida (~22MB,
 * ver `lib/storage.ts`), se acota el número de páginas y el tamaño del
 * texto extraído de un PDF -- un PDF con miles de páginas/objetos
 * repetidos podría inflar el texto extraído en memoria mucho más allá del
 * tamaño del archivo original.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export type TextExtractionStatus = 'extracted' | 'requires_ocr' | 'failed';

export interface ExtractedPageText {
  /** Número de página REAL (1-based) tal como lo reporta el propio PDF; para texto plano siempre es 1 (página virtual única). */
  page: number;
  text: string;
}

export interface TextExtractionResult {
  status: TextExtractionStatus;
  /** Texto completo concatenado (todas las páginas unidas con `PAGE_BREAK`), para persistencia/búsqueda de texto completo. */
  text: string | null;
  /** Texto por página REAL -- consumidores que necesiten citar una página concreta (matriz de requisitos, campos del contrato) deben usar esto, nunca una aproximación proporcional. */
  pages: ExtractedPageText[] | null;
  pageCount: number | null;
  detail?: string;
}

/**
 * Separador entre páginas dentro de `text` (form feed, `\f`) -- convención
 * estándar de "salto de página" en texto plano, invisible al leer pero
 * recuperable de forma determinista con `splitPersistedTextIntoPages` para
 * reconstruir el arreglo de páginas después de leer `extracted_text` de la
 * base de datos (donde solo se persiste el string concatenado, no el
 * arreglo estructurado).
 */
export const PAGE_BREAK = '\f';

/**
 * Reconstruye páginas reales a partir del texto persistido (columna
 * `extracted_text`), usando el separador `PAGE_BREAK`. Si el texto persistido
 * no contiene el separador (documento de texto plano, o dato de una ronda
 * anterior a este cambio sin el separador), se devuelve como una única
 * página -- nunca se inventa un número de página que el dato no sustenta.
 */
export function splitPersistedTextIntoPages(text: string): ExtractedPageText[] {
  const parts = text.split(PAGE_BREAK);
  return parts.map((t, i) => ({ page: i + 1, text: t }));
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

// Resuelto una sola vez por proceso: ruta absoluta al directorio
// `standard_fonts/` que empaqueta `pdfjs-dist` -- evita la advertencia
// "Ensure that the `standardFontDataUrl` API parameter is provided" al
// medir glifos de las 14 fuentes estándar (Helvetica y similares, las que
// `pdf-lib`/la mayoría de generadores usan) sin tener que descargar nada.
let cachedStandardFontDataUrl: string | null = null;
function resolveStandardFontDataUrl(): string {
  if (cachedStandardFontDataUrl) return cachedStandardFontDataUrl;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('pdfjs-dist/package.json');
  const dir = path.join(path.dirname(pkgPath), 'standard_fonts') + path.sep;
  cachedStandardFontDataUrl = pathToFileURL(dir).href;
  return cachedStandardFontDataUrl;
}

async function extractPdfPages(buffer: Buffer): Promise<{ pages: ExtractedPageText[]; pageCount: number }> {
  // Import perezoso: `pdfjs-dist` es pesado y solo hace falta en la rama PDF.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const loadingTask = pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: resolveStandardFontDataUrl(),
    // Solo se usa para extraer texto (nunca se renderiza a un lienzo): las
    // advertencias de métricas de fuente que no afectan el texto extraído
    // (p. ej. no poder cargar una fuente estándar de reserva para un PDF que
    // no la necesita) son ruido, no errores reales -- se silencian aquí para
    // no ensuciar los logs de cada subida, sin ocultar errores genuinos
    // (verbosity ERRORS sigue reportando fallos reales de parseo).
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  });
  const pdf = await loadingTask.promise;
  try {
    const pages: ExtractedPageText[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item: unknown) => (typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : '')).join(' ');
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
    return { pages, pageCount: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

export async function extractDocumentText(buffer: Buffer, opts: { mimeType?: string | null; filename?: string | null } = {}): Promise<TextExtractionResult> {
  const filename = (opts.filename ?? '').toLowerCase();
  const isPdfByHint = opts.mimeType === 'application/pdf' || filename.endsWith('.pdf') || looksLikePdf(buffer);

  if (isPdfByHint) {
    try {
      const { pages: rawPages, pageCount } = await extractPdfPages(buffer);
      const joined = rawPages.map((p) => p.text).join('').trim();
      if (joined.length === 0) {
        return {
          status: 'requires_ocr',
          text: null,
          pages: null,
          pageCount,
          detail: 'PDF sin capa de texto extraíble (probablemente escaneado). Requiere OCR, no soportado en esta ronda.',
        };
      }
      // AE-05 (anti "PDF bomb"): rechazar ANTES de persistir un texto
      // desproporcionadamente grande o un PDF con demasiadas páginas.
      if (pageCount > MAX_PDF_PAGES) {
        return {
          status: 'failed',
          text: null,
          pages: null,
          pageCount,
          detail: `PDF con demasiadas páginas (${pageCount} > límite de ${MAX_PDF_PAGES} de esta ronda) -- rechazado como medida anti "PDF bomb".`,
        };
      }
      const totalLength = rawPages.reduce((acc, p) => acc + p.text.length, 0);
      if (totalLength > MAX_EXTRACTED_TEXT_LENGTH) {
        return {
          status: 'failed',
          text: null,
          pages: null,
          pageCount,
          detail: `Texto extraído del PDF excede el límite de esta ronda (${totalLength} > ${MAX_EXTRACTED_TEXT_LENGTH} caracteres) -- rechazado como medida anti "PDF bomb".`,
        };
      }
      const sanitizedPages = rawPages.map((p) => ({ page: p.page, text: sanitizePlainText(p.text) }));
      return {
        status: 'extracted',
        text: sanitizedPages.map((p) => p.text).join(PAGE_BREAK),
        pages: sanitizedPages,
        pageCount,
      };
    } catch (err) {
      return {
        status: 'failed',
        text: null,
        pages: null,
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
      return { status: 'failed', text: null, pages: null, pageCount: null, detail: 'Archivo de texto vacío.' };
    }
    // AE-04: sanitizar ANTES de persistir -- ver docstring del módulo. Si
    // el contenido era ÍNTEGRAMENTE HTML/script (nada de texto real fuera
    // de las etiquetas), el resultado queda vacío -- se marca "failed"
    // explícito, nunca "extracted" con texto vacío (REQ-166).
    const sanitized = sanitizePlainText(text);
    if (sanitized.trim().length === 0) {
      return { status: 'failed', text: null, pages: null, pageCount: null, detail: 'El contenido quedó vacío después de sanitizar HTML/script embebido (AE-04); no se persiste como "extracted" un texto vacío.' };
    }
    // Texto plano: no hay noción de página real -- una única página virtual.
    return { status: 'extracted', text: sanitized, pages: [{ page: 1, text: sanitized }], pageCount: null };
  }

  return {
    status: 'failed',
    text: null,
    pages: null,
    pageCount: null,
    detail: `Formato no soportado en esta ronda (solo PDF con texto y texto plano). mimeType=${opts.mimeType ?? 'desconocido'}`,
  };
}
