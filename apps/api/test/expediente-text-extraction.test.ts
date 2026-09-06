import { describe, it, expect, vi } from 'vitest';

/**
 * Unitario de `lib/expediente/text-extraction.ts` (E6). El caso
 * "requires_ocr" (PDF genuinamente escaneado, sin ninguna capa de texto) se
 * verifica aquí con `pdf-parse` mockeado (devolviendo texto vacío) en vez de
 * un PDF binario "en blanco" real: la versión de `pdf.js` que empaqueta
 * `pdf-parse@1.1.1` es incompatible, de forma dependiente del contenido
 * exacto, con el flujo de compresión de xref que genera `pdf-lib` para
 * documentos pequeños ("Unknown compression method in flate stream") --
 * ruido de compatibilidad entre esas dos librerías ajeno al comportamiento
 * que este caso quiere ejercitar. El camino real de extracción de un PDF
 * CON texto (sin mocks, PDF genuino generado con `pdf-lib`) se prueba
 * end-to-end en `test/expediente-documents-and-matrix.test.ts`.
 */

describe('extractDocumentText (E6)', () => {
  it('un PDF sin capa de texto (mock: pdf-parse devuelve solo espacios) queda "requires_ocr", nunca texto vacío en silencio', async () => {
    vi.resetModules();
    vi.doMock('pdf-parse/lib/pdf-parse.js', () => ({ default: vi.fn(async () => ({ text: '   \n  ', numpages: 3 })) }));
    // @ts-expect-error -- query string fuerza una instancia de módulo nueva por caso (vitest); tsc no la reconoce como especificador válido.
    const { extractDocumentText: extractWithMock } = await import('../src/lib/expediente/text-extraction.js?ocr-case');
    const result = await extractWithMock(Buffer.from('%PDF-1.4 fake but treated as pdf by magic bytes'), { filename: 'escaneado.pdf' });
    expect(result.status).toBe('requires_ocr');
    expect(result.text).toBeNull();
    expect(result.pageCount).toBe(3);
    expect(result.detail).toContain('OCR');
  });

  it('texto plano se usa tal cual', async () => {
    vi.resetModules();
    // @ts-expect-error -- ver nota arriba.
    const { extractDocumentText: extractPlain } = await import('../src/lib/expediente/text-extraction.js?plain-case');
    const result = await extractPlain(Buffer.from('Hola mundo, este es un documento de texto plano.'), { filename: 'bases.txt', mimeType: 'text/plain' });
    expect(result.status).toBe('extracted');
    expect(result.text).toContain('Hola mundo');
  });

  it('un formato no soportado (ni PDF ni texto imprimible) queda "failed" con detalle explícito', async () => {
    vi.resetModules();
    // @ts-expect-error -- ver nota arriba.
    const { extractDocumentText: extractUnsupported } = await import('../src/lib/expediente/text-extraction.js?unsupported-case');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
    const result = await extractUnsupported(binary, { filename: 'foto.png', mimeType: 'image/png' });
    expect(result.status).toBe('failed');
    expect(result.text).toBeNull();
    expect(result.detail).toBeTruthy();
  });
});
