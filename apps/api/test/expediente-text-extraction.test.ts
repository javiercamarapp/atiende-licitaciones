import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFNumber, PDFPageLeaf, PDFRef } from 'pdf-lib';
import { FakeOcrAdapter } from '@atiende/ocr';
import { extractDocumentText } from '../src/lib/expediente/text-extraction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pdf');

/**
 * Genera un PDF genuino de `pdf-lib` con `pageCount` páginas en blanco de
 * `size`, usando la API de bajo nivel de `pdf-lib` en vez de
 * `doc.addPage()` en un bucle -- ver el comentario del caso R6-11 más abajo
 * para el porqué: `insertLeafNode` (lo que usa `addPage`/`insertPage` por
 * debajo) recorre linealmente todo el array `Kids` en cada llamada, así que
 * generar miles de páginas secuencialmente es O(n²). Esta función inserta
 * cada página en O(1) (`PDFArray.push` + `context.register`, sin pasar por
 * `insertLeafNode`) construyendo el mismo árbol de páginas a mano con las
 * clases públicas de `pdf-lib` (`PDFPageLeaf`, `PDFName`, `PDFNumber`). El
 * archivo resultante es indistinguible en estructura del que produce
 * `doc.addPage()` -- mismo número de objetos `/Type/Page` reales, mismo
 * tamaño aproximado -- solo cambia CÓMO de rápido se fabrica.
 */
async function createBlankPageBombFast(pageCount: number, size: [number, number]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const pagesTree = doc.catalog.Pages();
  const pagesRef = doc.catalog.get(PDFName.of('Pages'));
  if (!(pagesRef instanceof PDFRef)) {
    throw new Error('createBlankPageBombFast: /Pages del catálogo no es una referencia indirecta -- inesperado en un PDFDocument recién creado con PDFDocument.create().');
  }
  const kids = pagesTree.Kids();
  const [width, height] = size;
  for (let i = 0; i < pageCount; i += 1) {
    const leaf = PDFPageLeaf.withContextAndParent(doc.context, pagesRef);
    leaf.set(PDFName.of('MediaBox'), doc.context.obj([0, 0, width, height]));
    kids.push(doc.context.register(leaf));
  }
  pagesTree.set(PDFName.of('Count'), PDFNumber.of(pageCount));
  return Buffer.from(await doc.save());
}

/**
 * Unitario de `lib/expediente/text-extraction.ts` (E6 + R6-01/R6-02).
 *
 * R6-01/R6-02 (docs/auditoria-2/api-ronda6.md, ALTA): `pdf-parse@1.1.1`
 * (empaqueta `pdf.js` v1.10.100, ~2017) no soportaba el formato de
 * referencia cruzada por STREAM (PDF 1.5+, el que `pdf-lib` genera por
 * defecto y muchos generadores reales de PDF usan) -- solo el formato
 * clásico de tabla xref. El motor se sustituyó por `pdfjs-dist` (build
 * "legacy" para Node); estos dos casos EJERCITAN AMBOS FORMATOS con PDFs
 * reales (fixtures en `test/fixtures/pdf/`), sin ningún mock de la
 * librería de PDF -- a diferencia de la ronda anterior, que mockeaba
 * `pdf-parse` para evitar justamente esta incompatibilidad.
 */

describe('extractDocumentText (E6 + R6-01/R6-02)', () => {
  it('PDF con cross-reference STREAM (xref-stream, PDF 1.5+, el formato que genera pdf-lib/Word/navegadores modernos) se extrae página por página real', async () => {
    const buffer = readFileSync(path.join(FIXTURES_DIR, 'xref-stream.pdf'));
    // Confirma que el fixture es genuinamente xref-stream (no clásico).
    expect(buffer.toString('latin1')).toContain('/Type /XRef');
    expect(buffer.toString('latin1')).not.toContain('\ntrailer');

    const result = await extractDocumentText(buffer, { filename: 'bases.pdf', mimeType: 'application/pdf' });
    expect(result.status).toBe('extracted');
    expect(result.text).toContain('garantia de cumplimiento');
    expect(result.pageCount).toBe(1);
    expect(result.pages).toHaveLength(1);
    expect(result.pages![0].page).toBe(1);
    expect(result.pages![0].text).toContain('Anexo 3');
  });

  it('PDF con tabla xref CLÁSICA (PDF <=1.4) también se extrae correctamente -- no es un regresión al soportar xref-stream', async () => {
    const buffer = readFileSync(path.join(FIXTURES_DIR, 'xref-classic.pdf'));
    // Confirma que el fixture es genuinamente xref clásico (no stream).
    expect(buffer.toString('latin1')).toContain('\ntrailer');
    expect(buffer.toString('latin1')).not.toContain('/Type /XRef');

    const result = await extractDocumentText(buffer, { filename: 'bases.pdf', mimeType: 'application/pdf' });
    expect(result.status).toBe('extracted');
    expect(result.text).toContain('garantia de cumplimiento');
    expect(result.pageCount).toBe(1);
  });

  it('un PDF real de VARIAS páginas devuelve el texto de cada página con su número REAL (no una aproximación proporcional)', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont('Helvetica');
    const page1 = doc.addPage([400, 400]);
    page1.drawText('Contenido de la pagina uno.', { x: 20, y: 360, size: 12, font });
    const page2 = doc.addPage([400, 400]);
    page2.drawText('Contenido de la pagina dos: monto total.', { x: 20, y: 360, size: 12, font });
    const page3 = doc.addPage([400, 400]);
    page3.drawText('Contenido de la pagina tres.', { x: 20, y: 360, size: 12, font });
    const buffer = Buffer.from(await doc.save());

    const result = await extractDocumentText(buffer, { filename: 'contrato.pdf', mimeType: 'application/pdf' });
    expect(result.status).toBe('extracted');
    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pages![0]).toMatchObject({ page: 1 });
    expect(result.pages![0].text).toContain('pagina uno');
    expect(result.pages![1]).toMatchObject({ page: 2 });
    expect(result.pages![1].text).toContain('pagina dos');
    expect(result.pages![2]).toMatchObject({ page: 3 });
    expect(result.pages![2].text).toContain('pagina tres');
  });

  it('un PDF real SIN ninguna capa de texto (página en blanco) queda "requires_ocr", nunca texto vacío en silencio', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]); // sin drawText: no hay ninguna capa de texto.
    const buffer = Buffer.from(await doc.save());

    const result = await extractDocumentText(buffer, { filename: 'escaneado.pdf', mimeType: 'application/pdf' });
    expect(result.status).toBe('requires_ocr');
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
    expect(result.pageCount).toBe(1);
    expect(result.detail).toContain('OCR');
  });

  it('texto plano se usa tal cual, como una única página', async () => {
    const result = await extractDocumentText(Buffer.from('Hola mundo, este es un documento de texto plano.'), { filename: 'bases.txt', mimeType: 'text/plain' });
    expect(result.status).toBe('extracted');
    expect(result.text).toContain('Hola mundo');
    expect(result.pages).toEqual([{ page: 1, text: result.text }]);
  });

  it('un formato no soportado (ni PDF ni texto imprimible) queda "failed" con detalle explícito', async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const result = await extractDocumentText(binary, { filename: 'foto.png', mimeType: 'image/png' });
    expect(result.status).toBe('failed');
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  it('un PDF corrupto (bytes truncados/inválidos tras el header) queda "failed" con detalle explícito, nunca lanza sin capturar', async () => {
    const corrupt = Buffer.from('%PDF-1.4\n%%garbage not a real pdf structure at all\n');
    const result = await extractDocumentText(corrupt, { filename: 'roto.pdf', mimeType: 'application/pdf' });
    expect(result.status).toBe('failed');
    expect(result.text).toBeNull();
    expect(result.detail).toBeTruthy();
  });

  /**
   * R6-11 (docs/auditoria-2/api-ronda6-reverificacion.md, ALTA): los límites
   * anti "PDF bomb" (AE-05, `MAX_PDF_PAGES=500`) se evaluaban DESPUÉS de
   * extraer el texto de TODAS las páginas -- el reverificador midió 42 s de
   * CPU síncrona para un PDF de 263 KB que declaraba 20.000 páginas en
   * blanco, y como el texto concatenado quedaba vacío, el límite de páginas
   * ni siquiera llegaba a dispararse (ganaba antes `requires_ocr`). Este
   * caso reproduce EXACTAMENTE ese ataque: 20.000 páginas en blanco,
   * generadas con `pdf-lib` (no un fixture manual), archivo resultante de
   * unos 260 KB -- igual que midió el reverificador.
   *
   * R6-11 reincidencia (CI run 34363181329, 2026-09-09): con el fix de
   * `extractPdfPages` ya en el código, este test SEGUÍA haciendo timeout en
   * CI a los 20 s (el límite global de vitest). Medido con `console.time`
   * en un script aislado: la causa NO era `extractDocumentText` (esa parte
   * ya tardaba unos pocos ms/cientos de ms) sino la GENERACIÓN del propio
   * fixture -- `doc.addPage()` de `pdf-lib` llama a `insertLeafNode`, que
   * recorre linealmente TODO el array `Kids` existente en cada llamada
   * (confirmado leyendo `pdf-lib/cjs/core/structures/PDFPageTree.js`), así
   * que 20.000 llamadas secuenciales son O(n²): ~15 s medidos en una
   * máquina de desarrollo ociosa, bastante más bajo la contención real de
   * CI (varios ficheros de test en paralelo, ver el comentario de
   * `vitest.config.ts` sobre timeouts espurios por saturación de CPU) --
   * tiempo que corre ANTES de que arranque el cronómetro `startedAt` de
   * abajo, así que no lo cubre la aserción `elapsedMs < 2_000`, pero SÍ
   * cuenta contra el `testTimeout` global de vitest.
   *
   * `createBlankPageBombFast` genera el MISMO archivo (misma cantidad de
   * páginas reales, mismo tamaño de ~260 KB, seguía siendo un PDF genuino
   * producido por `pdf-lib`, no un fixture manual) usando la API de bajo
   * nivel de `pdf-lib` (`PDFPageLeaf`, `context.register`, `Kids.push`) para
   * insertar cada página en O(1) en vez de pasar por `insertLeafNode`: la
   * generación baja de ~15 s a menos de 1 s. El comportamiento bajo prueba
   * (`extractDocumentText`) no cambia -- solo cambia cómo de rápido se
   * fabrica el archivo de entrada.
   */
  it('R6-11: una "bomba de páginas" (20.000 páginas en blanco, ~260 KB) se rechaza en menos de 2 s, ANTES de extraer texto de ninguna página, con estado explícito "rechazado_por_limite" -- nunca "requires_ocr"', async () => {
    const buffer = await createBlankPageBombFast(20_000, [50, 50]);
    // El propio ataque depende de que el archivo generado sea pequeño frente
    // al número de páginas -- si esto deja de cumplirse, el test ya no
    // reproduce el escenario del acta.
    expect(buffer.byteLength).toBeLessThan(1_000_000);

    const startedAt = Date.now();
    const result = await extractDocumentText(buffer, { filename: 'bomba.pdf', mimeType: 'application/pdf' });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2_000);
    expect(result.status).toBe('failed');
    expect(result.limitExceeded).toBe('paginas');
    expect(result.detail).toContain('rechazado_por_limite');
    expect(result.pageCount).toBe(20_000);
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
  });
});

/** Firma PNG mínima (magic bytes reales) -- suficiente para `looksLikeImage`; el contenido real del PNG no importa porque `FakeOcrAdapter` nunca lo decodifica de verdad (ver `packages/ocr`). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

/**
 * OCR (REQ-014/018/129): `extractDocumentText` acepta un tercer argumento
 * `OcrPort` opcional (`@atiende/ocr`). Estas pruebas usan `FakeOcrAdapter`
 * -- el motor real (`TesseractOcrAdapter`, `tesseract.js`) ya se prueba de
 * verdad, sin mocks, en `packages/ocr/test/tesseract-adapter.test.ts`; aquí
 * se prueba la LÓGICA DE NEGOCIO de esta función (qué hace con cada
 * resultado posible del puerto), no el motor de OCR en sí -- mismo criterio
 * que el resto del repo (se mockea el borde externo, nunca la lógica que lo
 * consume).
 */
describe('extractDocumentText + OcrPort (REQ-014/018/129)', () => {
  it('sin `ocr`, una imagen suelta sigue siendo "failed" -- comportamiento IDÉNTICO al de antes de este paquete', async () => {
    const result = await extractDocumentText(PNG_SIGNATURE, { filename: 'foto.png', mimeType: 'image/png' });
    expect(result.status).toBe('failed');
    expect(result.detail).not.toContain('OCR');
  });

  it('con un `ocr` real que reconoce texto, una imagen suelta queda "extracted" con bbox por palabra y el motor anotado', async () => {
    const fake = new FakeOcrAdapter({
      respond: {
        ok: true,
        page: {
          imageWidth: 800,
          imageHeight: 200,
          text: 'REQUISITO: garantia de cumplimiento obligatoria',
          meanConfidence: 92,
          lines: [
            {
              text: 'REQUISITO: garantia de cumplimiento obligatoria',
              confidence: 92,
              bbox: { x0: 10, y0: 10, x1: 500, y1: 40 },
              words: [
                { text: 'REQUISITO:', confidence: 95, bbox: { x0: 10, y0: 10, x1: 120, y1: 40 } },
                { text: 'garantia', confidence: 90, bbox: { x0: 125, y0: 10, x1: 220, y1: 40 } },
              ],
            },
          ],
        },
      },
    });

    const result = await extractDocumentText(PNG_SIGNATURE, { filename: 'foto.png', mimeType: 'image/png' }, fake);

    expect(result.status).toBe('extracted');
    expect(result.text).toContain('garantia de cumplimiento');
    expect(result.pageCount).toBe(1);
    expect(result.ocrEngine).toBe('fake');
    expect(result.ocrMeanConfidence).toBe(92);
    expect(result.pages).toHaveLength(1);
    expect(result.pages![0].words).toHaveLength(2);
    expect(result.pages![0].words![0]).toMatchObject({ text: 'REQUISITO:', confidence: 95 });
    // El puerto se invocó con la imagen real pasada a la función.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].image).toBe(PNG_SIGNATURE);
  });

  it('con `ocr` pero sin texto reconocido, queda "requires_ocr" -- NUNCA "extracted" con texto vacío (REQ-166)', async () => {
    const fake = new FakeOcrAdapter(); // sin `respond`: página vacía, confidence 0.
    const result = await extractDocumentText(PNG_SIGNATURE, { filename: 'foto.png', mimeType: 'image/png' }, fake);
    expect(result.status).toBe('requires_ocr');
    expect(result.text).toBeNull();
    expect(result.pages).toBeNull();
    expect(result.detail).toContain('fake');
  });

  it('con `ocr` en estado not_configured, queda "requires_ocr" con el detalle del motor -- nunca "failed" (el documento no tiene la culpa)', async () => {
    const fake = new FakeOcrAdapter({ respond: { ok: false, kind: 'not_configured', detail: 'sin credencial Mistral configurada' } });
    const result = await extractDocumentText(PNG_SIGNATURE, { filename: 'foto.png', mimeType: 'image/png' }, fake);
    expect(result.status).toBe('requires_ocr');
    expect(result.detail).toContain('sin credencial Mistral configurada');
  });

  it('con `ocr` que falla de verdad (imagen corrupta para el motor), queda "failed" con el detalle del motor', async () => {
    const fake = new FakeOcrAdapter({ respond: { ok: false, kind: 'failed', detail: 'imagen corrupta' } });
    const result = await extractDocumentText(PNG_SIGNATURE, { filename: 'foto.png', mimeType: 'image/png' }, fake);
    expect(result.status).toBe('failed');
    expect(result.detail).toContain('imagen corrupta');
  });

  it('un PDF escaneado (sin capa de texto) sigue "requires_ocr" incluso con un `ocr` real disponible -- rasterizar PDF a imagen queda fuera de esta ronda (ver packages/ocr/README.md), nunca se promete silenciosamente más de lo que se construyó', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]); // sin drawText: sin capa de texto.
    const buffer = Buffer.from(await doc.save());
    const fake = new FakeOcrAdapter({ respond: { ok: true, page: { imageWidth: 1, imageHeight: 1, text: 'no debería llegar aquí', meanConfidence: 99, lines: [] } } });

    const result = await extractDocumentText(buffer, { filename: 'escaneado.pdf', mimeType: 'application/pdf' }, fake);

    expect(result.status).toBe('requires_ocr');
    expect(fake.calls).toHaveLength(0); // el puerto NUNCA se invoca para un PDF en esta ronda.
  });

  it('detecta una imagen por firma de archivo (magic bytes) aunque el mimeType declarado sea incorrecto/ausente', async () => {
    const fake = new FakeOcrAdapter({ respond: { ok: true, page: { imageWidth: 1, imageHeight: 1, text: 'texto real', meanConfidence: 80, lines: [] } } });
    const result = await extractDocumentText(PNG_SIGNATURE, { filename: 'sin-extension', mimeType: null }, fake);
    expect(result.status).toBe('extracted');
    expect(fake.calls).toHaveLength(1);
  });
});
