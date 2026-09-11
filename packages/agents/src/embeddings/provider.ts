/**
 * Puerto de proveedor de embeddings (REQ-006: motor de matching híbrido
 * semántico/pgvector + léxico). Independiente de `LLMProvider`
 * (`../llm/provider.ts`): un embedding NO es una compleción de chat, es un
 * vector numérico de longitud fija que representa el significado de un
 * texto para poder compararlo por similitud coseno.
 */
export interface EmbeddingProvider {
  readonly id: string;
  /** Identificador del modelo real usado (p. ej. "text-embedding-3-small"), persistido junto al vector para poder invalidar el caché si cambia. */
  readonly model: string;
  /** Dimensión fija de cada vector que devuelve este proveedor. */
  readonly dims: number;
  /** Convierte cada texto de entrada en un vector de `dims` componentes. El orden de salida corresponde 1:1 al de `texts`. */
  embed(texts: string[]): Promise<number[][]>;
}
