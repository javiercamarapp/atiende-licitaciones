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
 *
 * R6-11 (docs/auditoria-2/api-ronda6-reverificacion.md, ALTA): los límites
 * de AE-05 se comprobaban DESPUÉS de extraer el texto de TODAS las páginas
 * -- un PDF de 263 KB que declaraba 20.000 páginas (todas vacías) tardaba
 * 42 s de CPU síncrona en el handler HTTP antes de que `MAX_PDF_PAGES`
 * llegara a evaluarse, y como el texto concatenado quedaba vacío, ni
 * siquiera llegaba a rechazarse por ese límite -- ganaba antes la rama
 * `requires_ocr`. Ahora `extractPdfPages` comprueba `pdf.numPages` (dato ya
 * disponible tras `getDocument`, sin tocar una sola página) ANTES de entrar
 * al bucle, y dentro del bucle acumula caracteres y tiempo transcurrido
 * página a página para poder abortar temprano sin esperar a terminar de
 * recorrer el documento completo. El event loop se cede cada
 * `YIELD_EVERY_N_PAGES` páginas (`setImmediate`) para que un documento
 * legítimo de hasta `MAX_PDF_PAGES` páginas no bloquee el proceso de un
 * tirón.
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

/** R6-11: cuál de los límites anti "PDF bomb" (AE-05) provocó un `status: 'failed'`. `undefined` para cualquier otro `'failed'` (formato corrupto, cifrado, etc.) -- explícito y verificable por código, no solo por el texto libre de `detail`. No se añade como valor de `TextExtractionStatus` porque esa columna tiene un `check` en `packages/db` (`text_extraction_status in ('extracted','requires_ocr','failed')`, migraciones 0029/0067) que este agente no está autorizado a tocar; el estado "rechazado por límite" es 'failed' + este campo + un `detail` explícito. */
export type PdfBombLimit = 'paginas' | 'caracteres' | 'tiempo';

export interface TextExtractionResult {
  status: TextExtractionStatus;
  /** Texto completo concatenado (todas las páginas unidas con `PAGE_BREAK`), para persistencia/búsqueda de texto completo. */
  text: string | null;
  /** Texto por página REAL -- consumidores que necesiten citar una página concreta (matriz de requisitos, campos del contrato) deben usar esto, nunca una aproximación proporcional. */
  pages: ExtractedPageText[] | null;
  pageCount: number | null;
  detail?: string;
  /** Ver `PdfBombLimit`. Presente y con estado explícito ("rechazado_por_limite" en `detail`) solo cuando `status === 'failed'` por AE-05/R6-11. */
  limitExceeded?: PdfBombLimit;
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
/** R6-11: presupuesto de tiempo de pared para el bucle página-a-página de un solo PDF, comprobado ENTRE páginas (no interrumpe una página a medio parsear -- el margen real es este valor más el costo de la página más lenta en curso). Cubre el caso que `MAX_PDF_PAGES`/`MAX_EXTRACTED_TEXT_LENGTH` no acotan por sí solos: pocas páginas (<=500) pero carísimas de decodificar (p. ej. streams con ratio de compresión extremo). */
const MAX_EXTRACTION_MS = 8_000;
/** R6-11: cada cuántas páginas se cede el event loop (`setImmediate`) durante la extracción, para que un documento legítimo de hasta `MAX_PDF_PAGES` páginas no monopolice el proceso de un tirón. */
const YIELD_EVERY_N_PAGES = 20;

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

type PdfExtractionResult =
  | { ok: true; pages: ExtractedPageText[]; pageCount: number }
  | { ok: false; limit: PdfBombLimit; pageCount: number };

async function extractPdfPages(buffer: Buffer): Promise<PdfExtractionResult> {
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
    // R6-11: `pdf.numPages` sale de la tabla /Pages ya parseada por
    // `getDocument` -- comprobarlo aquí es O(1) frente al documento y NO
    // requiere invocar `getPage`/`getTextContent` en NINGUNA página. Antes
    // de este cambio el límite se comprobaba DESPUÉS de recorrer las
    // `pdf.numPages` páginas: un PDF de 263 KB que declaraba 20.000 páginas
    // (todas vacías) tardaba 42 s de CPU síncrona en llegar hasta aquí, y
    // como el texto concatenado quedaba vacío, ni siquiera se rechazaba por
    // este límite -- ganaba antes la rama `requires_ocr`.
    if (pdf.numPages > MAX_PDF_PAGES) {
      return { ok: false, limit: 'paginas', pageCount: pdf.numPages };
    }
    const pages: ExtractedPageText[] = [];
    let totalLength = 0;
    const deadline = Date.now() + MAX_EXTRACTION_MS;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item: unknown) => (typeof (item as { str?: unknown }).str === 'string' ? (item as { str: string }).str : '')).join(' ');
      page.cleanup();
      pages.push({ page: pageNumber, text });
      totalLength += text.length;
      // R6-11: abortar EN CUANTO se cruza el límite de caracteres, sin
      // esperar a terminar de recorrer el resto de páginas -- antes se
      // sumaba el total DESPUÉS del bucle completo.
      if (totalLength > MAX_EXTRACTED_TEXT_LENGTH) {
        return { ok: false, limit: 'caracteres', pageCount: pdf.numPages };
      }
      if (Date.now() > deadline) {
        return { ok: false, limit: 'tiempo', pageCount: pdf.numPages };
      }
      if (pageNumber % YIELD_EVERY_N_PAGES === 0) {
        // Ceder el event loop periódicamente: con el tope de
        // `MAX_PDF_PAGES` ya comprobado arriba, un `worker_thread` aparte no
        // se justificó (medido en docs/logs/fix-api-r6b.log); sin este punto
        // de cesión, un documento con muchas páginas legítimas seguiría
        // bloqueando el proceso de un tirón.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return { ok: true, pages, pageCount: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

export async function extractDocumentText(buffer: Buffer, opts: { mimeType?: string | null; filename?: string | null } = {}): Promise<TextExtractionResult> {
  const filename = (opts.filename ?? '').toLowerCase();
  const isPdfByHint = opts.mimeType === 'application/pdf' || filename.endsWith('.pdf') || looksLikePdf(buffer);

  if (isPdfByHint) {
    try {
      const extraction = await extractPdfPages(buffer);
      // R6-11: los límites anti "PDF bomb" (AE-05) ya se comprobaron DENTRO
      // de `extractPdfPages` -- antes del bucle (páginas) y página a página
      // (caracteres/tiempo) -- así que si `ok` es `false` aquí nunca se hizo
      // el trabajo de extraer texto de más páginas de las estrictamente
      // necesarias para detectar el límite. Estado explícito
      // ("rechazado_por_limite" en `detail`, `limitExceeded` para consumo
      // programático), nunca se fabrica texto.
      if (!extraction.ok) {
        const detailByLimit: Record<PdfBombLimit, string> = {
          paginas: `PDF rechazado_por_limite: ${extraction.pageCount} páginas > límite de ${MAX_PDF_PAGES} de esta ronda -- comprobado ANTES de extraer texto de ninguna página, medida anti "PDF bomb" (AE-05/R6-11).`,
          caracteres: `PDF rechazado_por_limite: el texto extraído superó ${MAX_EXTRACTED_TEXT_LENGTH} caracteres antes de terminar de recorrer sus páginas -- extracción abortada temprano, medida anti "PDF bomb" (AE-05/R6-11).`,
          tiempo: `PDF rechazado_por_limite: la extracción superó el presupuesto de tiempo de esta ronda (${MAX_EXTRACTION_MS} ms) -- abortada temprano, medida anti "PDF bomb" (AE-05/R6-11).`,
        };
        return {
          status: 'failed',
          text: null,
          pages: null,
          pageCount: extraction.pageCount,
          detail: detailByLimit[extraction.limit],
          limitExceeded: extraction.limit,
        };
      }
      const { pages: rawPages, pageCount } = extraction;
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
