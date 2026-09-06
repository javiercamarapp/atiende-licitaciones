import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { extractDocumentText } from '../src/lib/expediente/text-extraction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'pdf');

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
   */
  it('R6-11: una "bomba de páginas" (20.000 páginas en blanco, ~260 KB) se rechaza en menos de 2 s, ANTES de extraer texto de ninguna página, con estado explícito "rechazado_por_limite" -- nunca "requires_ocr"', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 20_000; i += 1) {
      doc.addPage([50, 50]);
    }
    const buffer = Buffer.from(await doc.save());
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
