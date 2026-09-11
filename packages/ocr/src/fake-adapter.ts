import type { LiveVerification, OcrInput, OcrPort, OcrResult } from "./types.js";

export type FakeOcrResponder = OcrResult | ((input: OcrInput) => OcrResult);

export interface FakeOcrAdapterOptions {
  /**
   * Qué devolver en cada llamada a `recognize`. Puede ser un `OcrResult` fijo
   * o una función del `input` (para que un mismo test module varíe la
   * respuesta por imagen, p. ej. simular una página en blanco vs. una con
   * texto). Default: `{ ok: true, page: <página vacía, confidence 0> }` --
   * simula un documento sin texto reconocible, NUNCA inventa contenido salvo
   * que el test lo pida explícitamente pasando su propio `respond`.
   */
  respond?: FakeOcrResponder;
}

const EMPTY_PAGE: OcrResult = {
  ok: true,
  page: { imageWidth: 0, imageHeight: 0, text: "", lines: [], meanConfidence: 0 },
};

/**
 * Adaptador FAKE de `OcrPort`: nunca ejecuta reconocimiento óptico real --
 * solo para pruebas de la lógica que CONSUME el puerto (p. ej.
 * `apps/api/src/lib/expediente/text-extraction.ts`), nunca para probar que
 * el OCR en sí funciona (eso lo cubre `TesseractOcrAdapter` +
 * `test/tesseract-adapter.test.ts` en este mismo paquete, contra el motor
 * real). Mismo criterio que `CaptureProvider` de `packages/mail` y los fakes
 * de `packages/agents`: se mockea el BORDE externo, nunca la lógica de
 * negocio del consumidor.
 */
export class FakeOcrAdapter implements OcrPort {
  readonly name = "fake";
  readonly liveVerification: LiveVerification = {
    verified: false,
    note: "Adaptador FAKE -- nunca ejecuta reconocimiento óptico real. Exclusivamente para pruebas; no usar en producción.",
  };

  /** Cada `OcrInput` recibido, en orden -- para que un test verifique qué imagen/idioma se le pasó realmente. */
  readonly calls: OcrInput[] = [];

  constructor(private readonly options: FakeOcrAdapterOptions = {}) {}

  async recognize(input: OcrInput): Promise<OcrResult> {
    this.calls.push(input);
    const responder = this.options.respond;
    if (!responder) return EMPTY_PAGE;
    return typeof responder === "function" ? responder(input) : responder;
  }

  async terminate(): Promise<void> {
    // No hay recursos que liberar.
  }
}
