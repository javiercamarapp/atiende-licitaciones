import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TesseractOcrAdapter, createTesseractOcrAdapter } from "../src/tesseract-adapter.js";
import { OcrNotConfiguredError } from "../src/types.js";
import { renderBlankPng, renderTextToPng } from "./support/render-text-image.js";

const FIXTURES_LANG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lang-data");

/**
 * Prueba de integración REAL del adaptador `tesseract.js` (REQ-014/018/129):
 * ejecuta el motor OCR de verdad contra imágenes generadas en esta misma
 * suite (`render-text-image.ts`), sin mockear el reconocimiento. `langPath`
 * apunta al modelo de español empaquetado en `test/fixtures/lang-data/` para
 * que la suite corra determinística y sin red -- ver README de este paquete
 * para el origen y licencia de ese archivo.
 *
 * NO es una prueba contra un documento escaneado real de licitación (no
 * existe ese gold set en este repo) -- por eso `liveVerification.verified`
 * del adaptador es `false` de forma explícita; ver su docstring.
 */
describe("TesseractOcrAdapter (motor real, tesseract.js)", () => {
  const adapters: TesseractOcrAdapter[] = [];
  function makeAdapter(): TesseractOcrAdapter {
    const adapter = new TesseractOcrAdapter({ language: "spa", langPath: FIXTURES_LANG_PATH });
    adapters.push(adapter);
    return adapter;
  }

  afterAll(async () => {
    await Promise.all(adapters.map((a) => a.terminate()));
  });

  it("declara verificado_contra_real=false explícito (REQ-014/018/129: sin gold set de licitaciones reales)", () => {
    const adapter = makeAdapter();
    expect(adapter.liveVerification.verified).toBe(false);
    expect(adapter.liveVerification.note.toLowerCase()).toContain("verificado_contra_real=false");
  });

  it("reconoce texto REAL de una imagen renderizada, con bounding boxes de palabra y línea", async () => {
    const adapter = makeAdapter();
    const png = renderTextToPng("LICITACION PUBLICA NACIONAL", { fontSize: 40, width: 900, height: 180 });
    const result = await adapter.recognize({ image: png });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Fuzzy: el OCR real puede confundir alguna letra -- se exige la
    // sustancia del texto (mayúsculas, sin acentos en este caso), NUNCA
    // igualdad exacta contra un motor de terceros no determinista al 100%.
    expect(result.page.text.toUpperCase()).toContain("LICITACION");
    expect(result.page.text.toUpperCase()).toContain("NACIONAL");
    expect(result.page.lines.length).toBeGreaterThan(0);
    const words = result.page.lines.flatMap((l) => l.words);
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) {
      expect(w.bbox.x1).toBeGreaterThan(w.bbox.x0);
      expect(w.bbox.y1).toBeGreaterThan(w.bbox.y0);
      expect(w.confidence).toBeGreaterThanOrEqual(0);
      expect(w.confidence).toBeLessThanOrEqual(100);
    }
    expect(result.page.meanConfidence).toBeGreaterThan(0);
    expect(result.page.imageWidth).toBeGreaterThan(0);
    expect(result.page.imageHeight).toBeGreaterThan(0);
  });

  it("una imagen en blanco no inventa texto -- devuelve página vacía con confianza 0, nunca contenido fabricado", async () => {
    const adapter = makeAdapter();
    const png = renderBlankPng();
    const result = await adapter.recognize({ image: png });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.page.text.trim()).toBe("");
    expect(result.page.meanConfidence).toBe(0);
  });

  it("una entrada que no es una imagen válida devuelve kind:'failed' explícito, nunca lanza sin control ni inventa texto", async () => {
    const adapter = makeAdapter();
    const result = await adapter.recognize({ image: Buffer.from("esto no es un PNG/JPEG válido") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("failed");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("pedir un idioma distinto al de construcción se rechaza como not_configured, en vez de reinicializar el worker en silencio", async () => {
    const adapter = makeAdapter();
    const result = await adapter.recognize({ image: renderBlankPng(), language: "eng" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("not_configured");
  });

  it("terminate() es seguro de llamar más de una vez y sin haber reconocido nada", async () => {
    const adapter = makeAdapter();
    await adapter.terminate();
    await adapter.terminate();
  });

  it("createTesseractOcrAdapter rechaza un idioma vacío en vez de construir un adaptador inservible", () => {
    expect(() => createTesseractOcrAdapter({ language: "   " })).toThrow(OcrNotConfiguredError);
  });
});
