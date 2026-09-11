/**
 * Puerto de OCR (REQ-014/018/129) -- patrón "puerto + adaptadores" ya usado
 * en este monorepo (`packages/mail/src/provider/types.ts` para `MailProvider`,
 * `packages/sources/src/connectors/types.ts` para `SourceConnector`): SOLO
 * contratos + tipos aquí; `apps/api`/`apps/worker` deciden CUÁNDO invocar un
 * `OcrPort` y qué hacer con el resultado.
 *
 * Alcance HONESTO de esta ronda (ver `docs/REQUISITOS.md` REQ-014/REQ-018/
 * REQ-129 y `docs/ACEPTACION.md`, donde este pipeline estaba marcado
 * "PENDIENTE -- sin gold set ni pipeline OCR/bbox" / "OCR no construido"):
 *
 * - Este paquete define el PUERTO y dos adaptadores: `TesseractOcrAdapter`
 *   (real, motor `tesseract.js` -- corre 100% local, sin API key ni
 *   credencial externa, ver README) y `FakeOcrAdapter` (para pruebas, nunca
 *   ejecuta reconocimiento real).
 * - REQ-018 exige EXPLÍCITAMENTE "nunca usar Tesseract como ÚNICO OCR" --
 *   el pipeline de producción que describe (Docling/PyMuPDF + Mistral
 *   OCR/Azure Layout + visión LLM por excepción) requiere credenciales de
 *   proveedor (Mistral/Azure) que este agente NO tiene y que esta wiki nunca
 *   fabrica. El diseño de `OcrPort` es intencionalmente agnóstico del motor
 *   para que agregar esos adaptadores reales (cuando exista la credencial)
 *   no requiera tocar ningún consumidor -- pero HOY el único adaptador real
 *   de este paquete es `TesseractOcrAdapter`, así que activarlo como el
 *   OCR de producción violaría la letra de REQ-018 ("nunca ÚNICO"). Por eso
 *   `createOcrPortFromEnv()` (`factory.ts`) NUNCA lo activa por defecto --
 *   solo con `OCR_ENGINE=tesseract` explícito, y el README deja este límite
 *   documentado sin adornos.
 * - `TesseractOcrAdapter.liveVerification.verified` es `false`: el motor SÍ
 *   se probó de verdad (no un mock) contra imágenes generadas en esta sesión
 *   (`test/tesseract-adapter.test.ts`, texto renderizado con
 *   `@napi-rs/canvas`), pero NUNCA contra un documento ESCANEADO real de una
 *   licitación mexicana -- no existe ese gold set en el repo (mismo hueco
 *   que documenta REQ-021). "verificado_contra_real=false" explícito hasta
 *   que exista.
 */

/** Caja delimitadora en píxeles de la imagen rasterizada de entrada (no de la página del PDF original -- quien rasteriza debe llevar la cuenta de la escala si necesita mapear de vuelta a puntos PDF). */
export interface OcrBoundingBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  /** 0-100, tal como lo reporta el motor subyacente. */
  confidence: number;
  bbox: OcrBoundingBox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBoundingBox;
  words: OcrWord[];
}

export interface OcrPageResult {
  /** Dimensiones en píxeles de la imagen de entrada -- necesarias para interpretar los `bbox` (absolutos, no normalizados 0-1). */
  imageWidth: number;
  imageHeight: number;
  /** Texto completo de la página, líneas unidas con `\n`. */
  text: string;
  lines: OcrLine[];
  /** Promedio de `confidence` de todas las palabras reconocidas; `0` si no se reconoció ninguna palabra (página en blanco o ilegible) -- nunca se infla artificialmente. */
  meanConfidence: number;
}

export type OcrResult =
  | { ok: true; page: OcrPageResult }
  /** El adaptador no tiene lo que necesita para operar (credencial/servicio remoto no configurado, o motor local sin datos de idioma disponibles ni forma de obtenerlos) -- estado declarado, nunca un intento silencioso de "adivinar" texto. */
  | { ok: false; kind: "not_configured"; detail: string }
  /** Falló el reconocimiento en sí (imagen corrupta, motor lanzó una excepción, etc.). */
  | { ok: false; kind: "failed"; detail: string };

export interface OcrInput {
  /** Imagen rasterizada de UNA sola página (PNG/JPEG/TIFF/BMP -- lo que el adaptador subyacente soporte). Rasterizar un PDF a imagen es responsabilidad de quien llama al puerto; ver README para el estado de esa pieza en este repo. */
  image: Buffer;
  /** Código de idioma tal como lo espera el adaptador subyacente (para `TesseractOcrAdapter`: código de 3 letras de Tesseract, p. ej. `"spa"`/`"eng"`). Default del adaptador si se omite: español (`"spa"`) -- el idioma real de toda licitación pública mexicana. */
  language?: string;
}

/** Mismo contrato que `LiveVerification` de `packages/sources` (REQ-132/133/134/135): declara si este adaptador fue probado contra un servicio/documento REAL, nunca solo contra un mock. */
export interface LiveVerification {
  verified: boolean;
  note: string;
}

export interface OcrPort {
  readonly name: string;
  readonly liveVerification: LiveVerification;
  recognize(input: OcrInput): Promise<OcrResult>;
  /** Libera recursos del motor (p. ej. el worker WASM de Tesseract). Seguro de invocar más de una vez o sin haber llamado nunca a `recognize`. */
  terminate(): Promise<void>;
}

/**
 * Error que un adaptador PUEDE lanzar (además de devolver `{ok:false, kind:
 * "not_configured"}`) cuando construirlo sin la configuración necesaria no
 * tiene forma de degradar a un resultado -- mismo criterio que
 * `SourceNotConfiguredError` de `packages/sources`.
 */
export class OcrNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrNotConfiguredError";
  }
}
