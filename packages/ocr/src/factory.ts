import { FakeOcrAdapter } from "./fake-adapter.js";
import { TesseractOcrAdapter } from "./tesseract-adapter.js";
import type { OcrPort } from "./types.js";

export type OcrEngineKind = "tesseract" | "fake";

export interface OcrEnv {
  OCR_ENGINE?: string;
  OCR_LANGUAGE?: string;
  OCR_LANG_PATH?: string;
  OCR_CACHE_PATH?: string;
}

function parseKind(raw: string | undefined): OcrEngineKind {
  if (raw === "tesseract") return "tesseract";
  // Sin `OCR_ENGINE=tesseract` explícito (incluida su ausencia total), el
  // default es `fake`: mismo criterio que `createMailProviderFromEnv`
  // (`packages/mail`) degradando a `capture` sin config -- un entorno sin
  // esta variable nunca dispara, ni por accidente, un motor OCR real (con
  // su propio costo de CPU/memoria y, sin `OCR_LANG_PATH` local, una
  // descarga de red). Ver README para por qué esto también es, de forma
  // deliberada, el único guardarraíl operativo del lado del consumidor de
  // REQ-018 ("nunca Tesseract como ÚNICO OCR"): activar este motor exige un
  // paso explícito, nunca es la ruta silenciosa por defecto.
  return "fake";
}

/**
 * Arma el `OcrPort` real a partir de variables de entorno -- mismo patrón
 * que `createMailProviderFromEnv` (`packages/mail`). Nunca lanza por
 * configuración incompleta: `TesseractOcrAdapter` reporta `not_configured`
 * en el primer `recognize()` si no logra preparar el modelo de idioma.
 */
export function createOcrPortFromEnv(env: OcrEnv = process.env as OcrEnv): OcrPort {
  const kind = parseKind(env.OCR_ENGINE);
  if (kind === "tesseract") {
    return new TesseractOcrAdapter({
      language: env.OCR_LANGUAGE,
      langPath: env.OCR_LANG_PATH,
      cachePath: env.OCR_CACHE_PATH,
    });
  }
  return new FakeOcrAdapter();
}
