import { createWorker, type Worker } from "tesseract.js";
import { OcrNotConfiguredError, type LiveVerification, type OcrInput, type OcrLine, type OcrPageResult, type OcrPort, type OcrResult, type OcrWord } from "./types.js";

export interface TesseractOcrAdapterOptions {
  /** Código de idioma de Tesseract (3 letras), p. ej. `"spa"` (default) o `"eng"`. Un mismo worker queda inicializado para este idioma durante toda la vida del adaptador -- `recognize({language: otro})` con un idioma distinto al de construcción lanza `OcrNotConfiguredError` (reinicializar el worker por llamada anularía el punto de reusarlo; quien necesite varios idiomas debe crear un adaptador por idioma). */
  language?: string;
  /**
   * Carpeta local con los archivos `<idioma>.traineddata` (sin gzip) a usar
   * en vez de descargarlos de la CDN pública de tesseract.js en la primera
   * llamada. `test/tesseract-adapter.test.ts` la usa para que la suite
   * corra sin red (`test/fixtures/lang-data/`); en producción, omitirla
   * hace que tesseract.js descargue el modelo la primera vez que se use
   * (descarga pública sin credencial, pero SÍ requiere salida a Internet --
   * documentado en el README de este paquete).
   */
  langPath?: string;
  /** Carpeta donde tesseract.js cachea el modelo descargado/copiado entre llamadas dentro del mismo proceso. Default: no se fija (usa el default de tesseract.js). */
  cachePath?: string;
}

function toBbox(b: { x0: number; y0: number; x1: number; y1: number }) {
  return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

/**
 * Adaptador REAL de `OcrPort` sobre `tesseract.js` (motor Tesseract OCR
 * compilado a WASM) -- corre enteramente en este proceso Node, sin llamar a
 * ningún servicio externo ni requerir API key. Es el adaptador "local" que
 * REQ-129 pide para el caso por defecto de bajo costo; NO sustituye el
 * pipeline completo de REQ-018 (Docling/PyMuPDF + Mistral OCR/Azure Layout +
 * visión LLM), que requiere credenciales de proveedor que este repo no
 * fabrica -- ver el docstring de `types.ts` para el detalle de por qué
 * `createOcrPortFromEnv()` nunca lo activa como default silencioso.
 */
export class TesseractOcrAdapter implements OcrPort {
  readonly name = "tesseract";
  readonly liveVerification: LiveVerification;
  private readonly language: string;
  private readonly langPath?: string;
  private readonly cachePath?: string;
  private workerPromise: Promise<Worker> | null = null;

  constructor(options: TesseractOcrAdapterOptions = {}) {
    this.language = options.language ?? "spa";
    this.langPath = options.langPath;
    this.cachePath = options.cachePath;
    this.liveVerification = {
      verified: false,
      note:
        "Motor tesseract.js real (no simulado): probado en esta ronda contra imágenes generadas en test/tesseract-adapter.test.ts (texto renderizado a PNG con @napi-rs/canvas), confirmando reconocimiento de texto y bounding boxes reales de palabra/línea. NO fue probado contra un documento ESCANEADO real de una licitación mexicana -- no existe ese gold set en este repo (mismo hueco de REQ-021/REQ-014). verificado_contra_real=false explícito hasta que exista.",
    };
  }

  private getWorker(): Promise<Worker> {
    if (!this.workerPromise) {
      this.workerPromise = createWorker(this.language, undefined, {
        // `errorHandler` no-op: sin él, `createWorker.js` (ver su código
        // fuente) lanza un SEGUNDO error sin capturar (`throw Error(data)`)
        // ADEMÁS de rechazar la promesa de `recognize()` -- que es la que
        // este adaptador ya captura en su propio try/catch más abajo. Sin
        // este handler, una imagen inválida deja una excepción no
        // controlada en el worker_thread de Node (reproducido en
        // `test/tesseract-adapter.test.ts`), aunque `recognize()` ya haya
        // devuelto `{ok:false, kind:"failed"}` correctamente.
        errorHandler: () => {},
        ...(this.langPath ? { langPath: this.langPath, gzip: false } : {}),
        // Sin `cachePath` explícito, tesseract.js cachea el modelo de idioma
        // en `process.cwd()` POR DEFECTO (`worker-script/index.js`,
        // `cacheMethod` sin fijar => `'write'`) -- un efecto secundario
        // sorprendente (escribir un archivo de varios MB en el directorio
        // de trabajo de quien sea que ejecute el proceso, sin haberlo
        // pedido) descubierto al correr la suite de este paquete la primera
        // vez, que dejó `spa.traineddata` suelto en la raíz de
        // `packages/ocr/`. `cacheMethod: 'none'` lo desactiva por completo
        // cuando nadie pidió `cachePath` -- cachear es un opt-in explícito,
        // nunca un efecto secundario silencioso.
        ...(this.cachePath ? { cachePath: this.cachePath } : { cacheMethod: 'none' }),
      });
    }
    return this.workerPromise;
  }

  async recognize(input: OcrInput): Promise<OcrResult> {
    if (input.language && input.language !== this.language) {
      // Ver docstring de `language` arriba: este adaptador está fijo a UN
      // idioma por instancia. No se reinicializa el worker en caliente para
      // no ocultarle a quien llama un costo (segundos) que no esperaba.
      return {
        ok: false,
        kind: "not_configured",
        detail: `Este adaptador fue construido para el idioma "${this.language}"; se pidió "${input.language}". Cree un TesseractOcrAdapter distinto para ese idioma.`,
      };
    }
    let worker: Worker;
    try {
      worker = await this.getWorker();
    } catch (err) {
      // Típicamente: sin red y sin `langPath` local -- tesseract.js no pudo
      // obtener el modelo de idioma. Estado declarado, nunca texto inventado.
      return { ok: false, kind: "not_configured", detail: `No se pudo inicializar el worker de tesseract.js (¿sin red y sin langPath local?): ${(err as Error).message}` };
    }
    try {
      const { data } = await worker.recognize(input.image, {}, { blocks: true, text: true });
      const lines: OcrLine[] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs ?? []) {
          for (const line of paragraph.lines ?? []) {
            const words: OcrWord[] = (line.words ?? []).map((w) => ({
              text: w.text,
              confidence: w.confidence,
              bbox: toBbox(w.bbox),
            }));
            lines.push({
              text: line.text.replace(/\n+$/, ""),
              confidence: line.confidence,
              bbox: toBbox(line.bbox),
              words,
            });
          }
        }
      }
      const allWords = lines.flatMap((l) => l.words);
      const meanConfidence = allWords.length > 0 ? allWords.reduce((sum, w) => sum + w.confidence, 0) / allWords.length : 0;
      // Nota de tamaño: tesseract.js no expone el ancho/alto de la imagen de
      // entrada en `data` -- se deriva del propio `bbox` cuando hay al menos
      // una palabra (el x1/y1 máximos son una cota inferior razonable, nunca
      // se inventa un tamaño exacto sin dato real); si no se reconoció nada,
      // se reporta `0` explícito en vez de un valor inventado.
      const imageWidth = allWords.length > 0 ? Math.max(...allWords.map((w) => w.bbox.x1)) : 0;
      const imageHeight = allWords.length > 0 ? Math.max(...allWords.map((w) => w.bbox.y1)) : 0;
      const page: OcrPageResult = {
        imageWidth,
        imageHeight,
        text: data.text.replace(/\n+$/, ""),
        lines,
        meanConfidence,
      };
      return { ok: true, page };
    } catch (err) {
      return { ok: false, kind: "failed", detail: `tesseract.js falló al reconocer la imagen: ${(err as Error).message}` };
    }
  }

  async terminate(): Promise<void> {
    if (!this.workerPromise) return;
    const worker = await this.workerPromise;
    this.workerPromise = null;
    await worker.terminate();
  }
}

/** Construye el adaptador o lanza `OcrNotConfiguredError` si `options.language` viene vacío -- guarda contra un caller que arma `TesseractOcrAdapterOptions` dinámicamente y termina pasando `language: ""`. */
export function createTesseractOcrAdapter(options: TesseractOcrAdapterOptions = {}): TesseractOcrAdapter {
  if (options.language !== undefined && options.language.trim().length === 0) {
    throw new OcrNotConfiguredError("TesseractOcrAdapter requiere un código de idioma no vacío (o ninguno, para usar el default 'spa').");
  }
  return new TesseractOcrAdapter(options);
}
