import { MissingCredentialsError, NonRetryableProviderError, RetryableProviderError } from "../errors.js";
import type { EmbeddingProvider } from "./provider.js";

export type EmbeddingFetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenAIEmbeddingProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: EmbeddingFetchLike;
  /** Modelo real de embeddings de OpenAI. Por defecto "text-embedding-3-small" (1536 dims), el más barato con calidad suficiente para ranking de recuperación (no es el caso de uso de razonamiento que sí justificaría "large"). */
  model?: string;
  /** Dimensión esperada del vector que devuelve `model` -- 1536 para text-embedding-3-small/ada-002, configurable porque OpenAI permite truncar dimensiones en los modelos v3 vía el parámetro `dimensions`. */
  dims?: number;
}

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMS = 1536;

/**
 * Proveedor real contra la OpenAI Embeddings API (REQ-006: motor semántico
 * de matching). Lee `OPENAI_API_KEY` de variables de entorno por defecto
 * (nunca hardcodeada). No hace ninguna llamada de red en tiempo de import;
 * `fetchImpl` es inyectable para que las pruebas nunca toquen la red real
 * (mismo patrón que `OpenAIResponsesProvider`, ver `../llm/openai-responses-provider.ts`).
 *
 * PENDIENTE (esqueleto honesto, `verificado_contra_real=false`): no se ha
 * ejercitado contra la API real de OpenAI (requiere credenciales de
 * producción, ver README.md "Pendientes"). Que las pruebas pasen contra un
 * `fetch` simulado no certifica la integración real ni la calidad semántica
 * de los vectores obtenidos contra un gold set real de convocatorias
 * (tampoco existe ese gold set en este repo, ver docs/ACEPTACION.md REQ-006).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly model: string;
  readonly dims: number;

  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIEmbeddingProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.model = options.model ?? DEFAULT_MODEL;
    this.dims = options.dims ?? DEFAULT_DIMS;
  }

  private getApiKey(): string {
    const key = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new MissingCredentialsError(
        "OPENAI_API_KEY no está configurada. La integración real con OpenAI Embeddings API está pendiente de credenciales (ver README.md).",
      );
    }
    return key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const apiKey = this.getApiKey();
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as EmbeddingFetchLike | undefined);
    if (!fetchImpl) {
      throw new MissingCredentialsError("No hay implementación de fetch disponible en este entorno");
    }

    const response = await fetchImpl(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: texts, dimensions: this.dims }),
    });

    if (!response.ok) {
      await this.throwForStatus(response);
    }

    const json = (await response.json()) as OpenAIEmbeddingsApiPayload;
    const byIndex = new Map(json.data.map((item) => [item.index, item.embedding]));
    return texts.map((_, i) => {
      const vector = byIndex.get(i);
      if (!vector) {
        throw new NonRetryableProviderError(
          `OpenAI Embeddings API no devolvió un vector para el índice ${i} de ${texts.length} textos enviados`,
        );
      }
      if (vector.length !== this.dims) {
        throw new NonRetryableProviderError(
          `OpenAI Embeddings API devolvió un vector de ${vector.length} dimensiones; se esperaban ${this.dims} (modelo "${this.model}")`,
        );
      }
      return vector;
    });
  }

  private async throwForStatus(response: Response): Promise<never> {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // El cuerpo puede no estar disponible; no bloquea la clasificación del error.
    }
    const message = `OpenAI Embeddings API respondió ${response.status}: ${bodyText || response.statusText}`;
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableProviderError(message, response.status);
    }
    throw new NonRetryableProviderError(message, response.status);
  }
}

interface OpenAIEmbeddingsApiPayload {
  data: Array<{ index: number; embedding: number[] }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}
