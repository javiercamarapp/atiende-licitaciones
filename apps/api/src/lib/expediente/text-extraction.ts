/**
 * Extracción de texto de documentos de bases y del contrato firmado (E6,
 * REQ-052). Cobertura honesta de esta ronda:
 *  - PDF con capa de texto: `pdfjs-dist` (build "legacy", el empaquetado
 *    pensado para Node sin DOM), extracción PÁGINA POR PÁGINA REAL (nunca
 *    una aproximación proporcional) -- ver `pages` en `TextExtractionResult`.
 *  - Texto plano (`.txt`, mime `text/plain` o sin mime reconocible que
 *    decodifique como UTF-8 imprimible): se usa tal cual, como una única
 *    "página" virtual (no hay noción de página real en texto plano).
 *  - PDF SIN capa de texto (escaneado / solo imagen): sigue sin OCR de PDF
 *    en esta ronda (rasterizar cada página a imagen es una pieza propia, con
 *    su propio riesgo tipo "PDF bomb" -- ver `packages/ocr/README.md`). El
 *    resultado es el estado EXPLÍCITO `"requires_ocr"` -- nunca se deja
 *    `extractedText` vacío como si el documento no tuviera contenido
 *    relevante (REQ-166: ausencia de dato nunca se traduce en "cumple"/"sin
 *    requisitos").
 *  - Imagen suelta (PNG/JPEG, por `mimeType` o firma de archivo): con un
 *    tercer argumento `ocr` (`OcrPort` de `@atiende/ocr`, REQ-014/018/129) se
 *    reconoce con OCR real -- ver "OCR (REQ-014/018/129)" más abajo. Sin
 *    `ocr` (el caso de HOY en los dos call sites reales,
 *    `documents.routes.ts`/`contract.routes.ts`), sigue siendo `"failed"`,
 *    comportamiento IDÉNTICO al de antes de este paquete.
 *  - Cualquier otro formato (docx, etc.): `"failed"` con detalle explícito;
 *    tampoco se inventa texto.
 *
 * ## OCR (REQ-014/018/129)
 *
 * `extractDocumentText(buffer, opts, ocr?)` acepta un `OcrPort` opcional
 * (`@atiende/ocr`, puerto + adaptador real `tesseract.js` + fake para
 * pruebas). Sin él, el comportamiento no cambia ni un bit frente a antes de
 * ese paquete. Con un `ocr` real:
 *  - Imagen suelta: se reconoce con `ocr.recognize()`. Texto vacío o
 *    `not_configured` → `"requires_ocr"` explícito (NUNCA `"extracted"` con
 *    texto vacío, REQ-166); `kind: "failed"` → `"failed"`; texto real →
 *    `"extracted"` con `pages[0].words` (bbox + confianza por palabra, lo
 *    que REQ-014 pide) y `ocrEngine` anotado -- la procedencia del texto
 *    nunca se oculta.
 *  - PDF sin capa de texto: sigue devolviendo `"requires_ocr"` SIN usar
 *    `ocr` -- rasterizar PDF a imagen queda deliberadamente fuera de esta
 *    ronda (ver `packages/ocr/README.md` para el porqué exacto).
 * `packages/ocr/README.md` documenta el estado honesto completo: qué
 * adaptador es real, por qué `verificado_contra_real=false`, y por qué
 * `createOcrPortFromEnv()` nunca activa el motor local por defecto (REQ-018
 * prohíbe que Tesseract sea el ÚNICO OCR de producción).
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
 * `requires_ocr`. `extractPdfPages` comprueba `pdf.numPages` (dato ya
 * disponible tras `getDocument`, sin tocar una sola página) ANTES de entrar
 * al bucle, y dentro del bucle acumula caracteres y tiempo transcurrido
 * página a página para poder abortar temprano sin esperar a terminar de
 * recorrer el documento completo. El event loop se cede cada
 * `YIELD_EVERY_N_PAGES` páginas (`setImmediate`) para que un documento
 * legítimo de hasta `MAX_PDF_PAGES` páginas no bloquee el proceso de un
 * tirón.
 *
 * R6-11 reincidencia (CI run 34363181329, 2026-09-09): con el fix anterior
 * YA en el código, el propio test de la "bomba de páginas" seguía haciendo
 * timeout en CI (20 s, el límite global de vitest) en vez de completar en
 * los <2 s que exige. Medido en aislado (`node`, con timeout de la
 * herramienta para nunca colgar más de 15 s, ver
 * `docs/logs/fix-api-r6-11-reincidencia-v2.log`): la causa DOMINANTE
 * resultó ser la propia GENERACIÓN del fixture del test, no este módulo --
 * el bucle `doc.addPage()` de `pdf-lib` para 20.000 páginas es O(n²)
 * (`insertLeafNode` recorre todo el array `Kids` en cada llamada) y por sí
 * solo mide ~25 s en una máquina de desarrollo ociosa, más que suficiente
 * para agotar el límite global de vitest sin que `extractDocumentText`
 * llegue a ejecutarse (fix del lado del test: `createBlankPageBombFast` en
 * `expediente-text-extraction.test.ts`, que construye el mismo archivo en
 * O(n)). Aislando ESE costo, `pdfjsLib.getDocument(...).promise` para el
 * PDF de 20.000 páginas también tiene un costo medible (no del bucle de
 * extracción, que ya se cortaba a tiempo, sino de construir el árbol
 * `/Pages` completo para poder reportar `numPages`): ~800 ms en una máquina
 * de desarrollo ociosa. Bajo la contención real de CI (varios ficheros de
 * test en paralelo, cada uno con su propio Fastify + PGlite, ver el
 * comentario en `vitest.config.ts` sobre timeouts espurios por saturación
 * de CPU) ese costo se amplifica, y es el que sí paga cualquier atacante
 * real (que nunca pasa por `doc.addPage()` de `pdf-lib`), así que vale la
 * pena evitarlo también en el camino de producción.
 *
 * `estimateFastPdfPageCount` añade un atajo MÁS BARATO que invocar
 * `pdfjs-dist` en absoluto para el caso fácil de detectar: cuenta
 * ocurrencias de `/Type/Page` en el archivo, incluyendo dentro de streams
 * comprimidos con Flate (`pdf-lib`, y la mayoría de generadores PDF 1.5+,
 * empaquetan los objetos de página dentro de "object streams" comprimidos --
 * el texto plano del fixture de este mismo ataque tiene CERO coincidencias
 * sin descomprimir). Si ese conteo aproximado ya supera `MAX_PDF_PAGES`, se
 * rechaza con el mismo contrato de siempre SIN llamar nunca a
 * `pdfjsLib.getDocument`. Es solo un atajo best-effort para el caso fácil:
 * si no encuentra suficientes coincidencias (streams con otro filtro,
 * cifrado, estructura atípica), se cae al flujo normal de abajo sin
 * cambios -- `pdf.numPages` sigue siendo la única fuente de verdad
 * autoritativa para documentos legítimos, y ningún límite existente
 * (páginas, caracteres, tiempo) se relaja.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';
import type { OcrPort, OcrWord } from '@atiende/ocr';

export type TextExtractionStatus = 'extracted' | 'requires_ocr' | 'failed';

export interface ExtractedPageText {
  /** Número de página REAL (1-based) tal como lo reporta el propio PDF; para texto plano o una imagen suelta siempre es 1 (página virtual única). */
  page: number;
  text: string;
  /** Presente SOLO cuando `text` de esta página vino de OCR (ver `ocrEngine` en `TextExtractionResult`) -- bbox + confianza por palabra tal como las reportó el motor (REQ-014). Páginas de texto nativo (PDF con capa de texto, texto plano) no tienen bbox por palabra en esta ronda. */
  words?: OcrWord[];
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
  /** Nombre del `OcrPort` (`OcrPort.name`, p. ej. `"tesseract"`/`"fake"`) que produjo `text`/`pages`, SOLO presente cuando `status === 'extracted'` vino de OCR -- nunca se oculta que el texto no vino de una capa de texto nativa (REQ-014/018). */
  ocrEngine?: string;
  /** Confianza media (0-100) reportada por el motor de OCR para esta página -- SOLO presente junto con `ocrEngine`. */
  ocrMeanConfidence?: number;
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

/**
 * R6-11 (perf): cotas de seguridad del atajo `estimateFastPdfPageCount` --
 * existen para que la propia heurística barata nunca se convierta en el
 * nuevo cuello de botella ni en un vector de ataque contra sí misma (p. ej.
 * una "zip bomb" dirigida al pre-chequeo en vez de a `pdfjs`).
 * `maxOutputLength` hace que Node ABORTE la descompresión de un stream en
 * cuanto se supera -- no descomprime de más para luego descartar --, así que
 * el costo real de cada stream queda acotado por este valor sin importar
 * cuánto "prometa" expandirse su versión comprimida.
 */
const FAST_PRECHECK_MAX_STREAM_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Tope de streams inspeccionados -- el propio ataque de referencia (20.000 páginas) produce 402; este margen es generoso sin dejar de acotar el peor caso. */
const FAST_PRECHECK_MAX_STREAMS = 20_000;
/** Presupuesto de tiempo de pared del atajo completo -- si se agota, se corta y se cae al flujo normal con `pdfjs` (que sigue siendo la fuente de verdad). */
const FAST_PRECHECK_MAX_MS = 500;

/** `/Type/Page` (con o sin espacio antes de la segunda barra), pero NUNCA `/Type/Pages` (el nodo intermedio del árbol, no una página real). */
const PAGE_TYPE_MARKER_RE = /\/Type\s*\/Page(?!s)/g;

function countPageMarkers(text: string): number {
  const matches = text.match(PAGE_TYPE_MARKER_RE);
  return matches ? matches.length : 0;
}

/**
 * R6-11 (perf): conteo APROXIMADO y barato de páginas reales de un PDF, sin
 * invocar `pdfjs-dist` -- ver el comentario de cabecera de este módulo para
 * el porqué (evitar que `pdfjs` construya el árbol `/Pages` completo es lo
 * que de verdad hace falta para el caso "bomba", no solo cortar el bucle de
 * extracción). Cuenta ocurrencias de `/Type/Page` tanto en el texto plano
 * del archivo como dentro de cada stream que logre descomprimirse con
 * Flate -- `pdf-lib` y la mayoría de generadores PDF 1.5+ empaquetan los
 * objetos de página dentro de "object streams" (`/Type/ObjStm`)
 * comprimidos, así que el texto plano por sí solo no encuentra nada en esos
 * archivos.
 *
 * Es SOLO un atajo best-effort para el caso fácil de detectar: si el
 * archivo usa otro filtro de compresión, está cifrado, o tiene una
 * estructura atípica que este escaneo ingenuo no reconoce, simplemente
 * cuenta menos de lo real (nunca más) y la llamada de arriba cae al flujo
 * normal con `pdfjs`, que sigue comprobando `pdf.numPages` como única
 * fuente de verdad. Esta función nunca reemplaza ese chequeo -- solo evita
 * pagar su costo en el caso en que ya alcanza para rechazar.
 */
function estimateFastPdfPageCount(buffer: Buffer): number {
  const startedAt = Date.now();
  const text = buffer.toString('latin1');
  let count = countPageMarkers(text);
  let searchFrom = 0;
  let streamsScanned = 0;
  while (streamsScanned < FAST_PRECHECK_MAX_STREAMS) {
    const streamKeywordIdx = text.indexOf('stream', searchFrom);
    if (streamKeywordIdx === -1) break;
    let dataStart = streamKeywordIdx + 'stream'.length;
    if (text[dataStart] === '\r') dataStart += 1;
    if (text[dataStart] === '\n') dataStart += 1;
    const dataEnd = text.indexOf('endstream', dataStart);
    if (dataEnd === -1) break;
    streamsScanned += 1;
    try {
      const inflated = zlib.inflateSync(buffer.subarray(dataStart, dataEnd), {
        maxOutputLength: FAST_PRECHECK_MAX_STREAM_OUTPUT_BYTES,
      });
      count += countPageMarkers(inflated.toString('latin1'));
    } catch {
      // Filtro distinto de Flate, stream corrupto/cifrado, o excede
      // `maxOutputLength`: se ignora -- es solo un atajo best-effort, el
      // chequeo autoritativo (`pdf.numPages`) sigue vigente más abajo.
    }
    searchFrom = dataEnd + 'endstream'.length;
    if (Date.now() - startedAt > FAST_PRECHECK_MAX_MS) break;
  }
  return count;
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Firma de archivo (magic bytes) de los formatos de imagen que `TesseractOcrAdapter`/`tesseract.js` soportan -- PNG, JPEG, y BMP/TIFF por si acaso, aunque los dos primeros son los reales en escaneos subidos desde un teléfono/scanner. Nunca se confía SOLO en `mimeType` (un cliente puede mentir sobre él) ni SOLO en la extensión del nombre de archivo. */
function looksLikeImage(buffer: Buffer, mimeType: string | null | undefined, filename: string): boolean {
  if (mimeType?.startsWith('image/')) return true;
  if (/\.(png|jpe?g|bmp|tiff?)$/.test(filename)) return true;
  const sig = buffer.subarray(0, 8);
  if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47) return true; // PNG
  if (sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff) return true; // JPEG
  if (sig[0] === 0x42 && sig[1] === 0x4d) return true; // BMP
  return false;
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
  // R6-11 (perf): atajo barato ANTES de tocar `pdfjs-dist` en absoluto --
  // ver `estimateFastPdfPageCount`. Si el conteo aproximado ya supera el
  // límite, se rechaza con el mismo contrato de siempre sin pagar el costo
  // de que `pdfjs` construya el árbol `/Pages` completo (el cuello de
  // botella real medido para el caso "bomba", ver comentario de cabecera).
  const fastPageCount = estimateFastPdfPageCount(buffer);
  if (fastPageCount > MAX_PDF_PAGES) {
    return { ok: false, limit: 'paginas', pageCount: fastPageCount };
  }

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

export async function extractDocumentText(
  buffer: Buffer,
  opts: { mimeType?: string | null; filename?: string | null } = {},
  ocr?: OcrPort
): Promise<TextExtractionResult> {
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

  // REQ-014/018/129: imagen suelta (foto/escaneo de una sola página) + un
  // OcrPort real disponible -- ver "OCR (REQ-014/018/129)" en el docstring
  // del módulo. Sin `ocr`, este bloque no se ejecuta y el comportamiento es
  // el de siempre (cae al `"failed"` final, sin cambio alguno).
  if (ocr && looksLikeImage(buffer, opts.mimeType, filename)) {
    const result = await ocr.recognize({ image: buffer });
    if (!result.ok) {
      if (result.kind === 'not_configured') {
        // Mismo criterio que un PDF escaneado sin `ocr`: ausencia de
        // capacidad real de OCR es `requires_ocr`, nunca `failed` (que
        // sugeriría un problema del documento) ni `extracted` vacío.
        return { status: 'requires_ocr', text: null, pages: null, pageCount: null, detail: `OCR no disponible (${ocr.name}): ${result.detail}` };
      }
      return { status: 'failed', text: null, pages: null, pageCount: null, detail: `OCR (${ocr.name}) falló al reconocer la imagen: ${result.detail}` };
    }
    const rawText = result.page.text.trim();
    if (rawText.length === 0) {
      // REQ-166: una imagen sin texto reconocible NUNCA se traduce en
      // "extracted" con texto vacío -- mismo criterio que un PDF escaneado.
      return { status: 'requires_ocr', text: null, pages: null, pageCount: null, detail: `OCR (${ocr.name}) se ejecutó pero no reconoció texto en la imagen (confianza media 0 o página en blanco).` };
    }
    const sanitized = sanitizePlainText(result.page.text);
    if (sanitized.trim().length === 0) {
      return { status: 'failed', text: null, pages: null, pageCount: null, detail: 'El texto reconocido por OCR quedó vacío después de sanitizar HTML/script embebido (AE-04); no se persiste como "extracted" un texto vacío.' };
    }
    // AE-04 solo sanea `text` (concatenado); las palabras de `words` quedan
    // tal como las reportó el motor (bbox real, sin reescribir) -- un
    // texto de OCR real nunca trae HTML embebido, a diferencia del caso de
    // texto plano subido por un usuario que sí puede traerlo.
    const words = result.page.lines.flatMap((l) => l.words);
    return {
      status: 'extracted',
      text: sanitized,
      pages: [{ page: 1, text: sanitized, words }],
      pageCount: 1,
      ocrEngine: ocr.name,
      ocrMeanConfidence: result.page.meanConfidence,
    };
  }

  return {
    status: 'failed',
    text: null,
    pages: null,
    pageCount: null,
    detail: `Formato no soportado en esta ronda (solo PDF con texto, texto plano${ocr ? ', e imágenes vía OCR' : ''}). mimeType=${opts.mimeType ?? 'desconocido'}`,
  };
}
