import { createHash } from 'node:crypto';
import type { DbExecutor } from '@atiende/db';
import { FakeEmbeddingProvider, OpenAIEmbeddingProvider, cosineSimilarity, type EmbeddingProvider } from '@atiende/agents';

/**
 * REQ-006 (motor de matching híbrido semántico/pgvector + léxico): capa que
 * calcula, cachea y compara embeddings. El componente léxico/reglas duras
 * (packages/sources/src/matching/matching-engine.ts) queda SIN TOCAR -- este
 * módulo solo AÑADE un criterio de relevancia adicional que se combina con
 * el existente en `engine.ts` (`blendRelevance`).
 *
 * Selección de proveedor (mismo patrón que `apps/worker/src/agents/named-agents.ts`
 * para el LLM de agentes): `OpenAIEmbeddingProvider` real SOLO si
 * `OPENAI_API_KEY` está definida; si no, `FakeEmbeddingProvider` (determinista,
 * sin red, ver README.md "Pendientes" -- `verificado_contra_real=false`
 * hasta tener credenciales reales y un gold set real de convocatorias contra
 * el que medir precision@k/nDCG, ninguno de los cuales existe hoy en este
 * repo).
 */
export function resolveEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  if (env.OPENAI_API_KEY) {
    return new OpenAIEmbeddingProvider({ apiKey: env.OPENAI_API_KEY });
  }
  return new FakeEmbeddingProvider(1536);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Formatea un vector como literal de texto de pgvector (`'[0.1,0.2,...]'`), sin exponenciales ni NaN/Infinity (que `::vector` rechazaría). */
export function toVectorLiteral(vec: readonly number[]): string {
  return `[${vec.map((v) => (Number.isFinite(v) ? v.toFixed(8) : '0')).join(',')}]`;
}

export async function isPgvectorAvailable(tx: DbExecutor): Promise<boolean> {
  const { rows } = await tx.query<{ available: boolean }>('select app.pgvector_available() as available');
  return rows[0]?.available === true;
}

interface EmbeddingRow {
  source_text_hash: string;
  model: string;
  embedding_fallback: number[];
}

/**
 * Obtiene el embedding cacheado de la convocatoria (org_id, tender_id) si el
 * texto fuente y el modelo no cambiaron; si cambió o no existe, calcula uno
 * nuevo con `provider` y lo persiste (embedding_fallback siempre;
 * embedding_vec también si pgvector está disponible). Devuelve `null` si
 * `text` está vacío (nada que comparar -- nunca se inventa un vector para
 * texto ausente).
 */
export async function getOrCreateTenderEmbedding(
  tx: DbExecutor,
  orgId: string,
  tenderId: string,
  text: string,
  provider: EmbeddingProvider,
  pgvectorAvailable: boolean
): Promise<number[] | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const hash = sha256(trimmed);

  const { rows } = await tx.query<EmbeddingRow>(
    'select source_text_hash, model, embedding_fallback from tender_embeddings where org_id = $1 and tender_id = $2',
    [orgId, tenderId]
  );
  const existing = rows[0];
  if (existing && existing.source_text_hash === hash && existing.model === provider.model) {
    return existing.embedding_fallback;
  }

  const [vector] = await provider.embed([trimmed]);
  await tx.query(
    `insert into tender_embeddings (org_id, tender_id, source_text_hash, model, dims, embedding_fallback)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (org_id, tender_id) do update set
       source_text_hash = excluded.source_text_hash,
       model = excluded.model,
       dims = excluded.dims,
       embedding_fallback = excluded.embedding_fallback`,
    [orgId, tenderId, hash, provider.model, provider.dims, vector]
  );
  if (pgvectorAvailable) {
    await tx.query('update tender_embeddings set embedding_vec = $1::vector where org_id = $2 and tender_id = $3', [
      toVectorLiteral(vector),
      orgId,
      tenderId,
    ]);
  }
  return vector;
}

/** Igual que `getOrCreateTenderEmbedding` pero para el embedding único de perfil de organización (una fila por org_id, sin dimensión de convocatoria). */
export async function getOrCreateProfileEmbedding(
  tx: DbExecutor,
  orgId: string,
  text: string,
  provider: EmbeddingProvider,
  pgvectorAvailable: boolean
): Promise<number[] | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const hash = sha256(trimmed);

  const { rows } = await tx.query<EmbeddingRow>(
    'select source_text_hash, model, embedding_fallback from company_profile_embeddings where org_id = $1',
    [orgId]
  );
  const existing = rows[0];
  if (existing && existing.source_text_hash === hash && existing.model === provider.model) {
    return existing.embedding_fallback;
  }

  const [vector] = await provider.embed([trimmed]);
  await tx.query(
    `insert into company_profile_embeddings (org_id, source_text_hash, model, dims, embedding_fallback)
     values ($1, $2, $3, $4, $5)
     on conflict (org_id) do update set
       source_text_hash = excluded.source_text_hash,
       model = excluded.model,
       dims = excluded.dims,
       embedding_fallback = excluded.embedding_fallback`,
    [orgId, hash, provider.model, provider.dims, vector]
  );
  if (pgvectorAvailable) {
    await tx.query('update company_profile_embeddings set embedding_vec = $1::vector where org_id = $2', [
      toVectorLiteral(vector),
      orgId,
    ]);
  }
  return vector;
}

/**
 * Peso del componente semántico dentro de la relevancia combinada (REQ-006:
 * "matching híbrido"). Deliberadamente minoritario frente al léxico/reglas
 * (que sigue siendo la señal principal, con criterios explícitos y
 * auditables por campo): el embedding es una señal de apoyo de "tema
 * general", no un reemplazo de las reglas duras de negocio.
 */
export const SEMANTIC_RELEVANCE_WEIGHT = 0.35;

export interface SemanticRelevanceResult {
  /** Similitud coseno cruda, en [-1, 1] (o, en la práctica, casi siempre en [0, 1] con embeddings de texto real). */
  cosine: number;
  /** Escalado a 0-100 para combinarse con las demás puntuaciones de `MatchCriterionResult`. */
  score0to100: number;
  provider: string;
  model: string;
}

/**
 * Calcula la relevancia semántica (perfil de organización vs. convocatoria)
 * usando embeddings cacheados en `packages/db`. Devuelve `null` cuando no
 * hay texto utilizable de alguno de los dos lados (perfil sin capacidades ni
 * productos capturados, o convocatoria sin título/anexos) -- se EXCLUYE del
 * blend en vez de inventar un score neutro, mismo criterio que el resto del
 * matching léxico ante datos ausentes (REQ-166).
 */
export async function computeSemanticRelevance(
  tx: DbExecutor,
  orgId: string,
  tenderId: string,
  profileText: string,
  tenderText: string,
  provider: EmbeddingProvider = resolveEmbeddingProvider()
): Promise<SemanticRelevanceResult | null> {
  const pgvectorOn = await isPgvectorAvailable(tx);
  // Secuencial, NUNCA Promise.all: ambas llamadas comparten la misma
  // conexión/transacción (`tx`) -- despacharlas en paralelo enviaría
  // sentencias intercaladas sobre el mismo socket (pg.Client y la
  // transacción de PGlite no soportan queries concurrentes en una misma
  // conexión).
  const profileVec = await getOrCreateProfileEmbedding(tx, orgId, profileText, provider, pgvectorOn);
  const tenderVec = await getOrCreateTenderEmbedding(tx, orgId, tenderId, tenderText, provider, pgvectorOn);
  if (!profileVec || !tenderVec) return null;

  const cosine = cosineSimilarity(profileVec, tenderVec);
  // cosine en [-1,1] -> [0,100], preservando el orden (nunca se trunca a 0
  // silenciosamente: un texto con coseno negativo real produce un score
  // bajo pero explicable, no un error).
  const score0to100 = clamp(((cosine + 1) / 2) * 100, 0, 100);
  return { cosine, score0to100, provider: provider.id, model: provider.model };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Texto agregado del perfil de organización para el embedding semántico -- mismas señales que ya usa el componente léxico (capacidades + productos/servicios), nunca datos no capturados por el usuario. */
export function buildProfileEmbeddingText(keywords: string[]): string {
  return keywords.join('. ');
}

/**
 * Texto agregado de la convocatoria para el embedding semántico: título +
 * entidad convocante + clasificadores + texto extraído de anexos técnicos
 * reales (`tender_documents.extracted_text`) cuando existe -- REQ-006 exige
 * explícitamente ir más allá de solo metadatos/título.
 */
export function buildTenderEmbeddingText(input: {
  title: string;
  contractingBody: string | null;
  cpvCodes: string[] | null;
  attachmentTexts: string[];
}): string {
  const parts = [input.title, input.contractingBody ?? '', ...(input.cpvCodes ?? []), ...input.attachmentTexts];
  return parts.filter((p) => p && p.trim().length > 0).join('. ');
}

export interface MatchProceduresResult {
  tenderId: string;
  /** Similitud coseno en [-1, 1] (en la práctica casi siempre en [0, 1] con embeddings de texto). */
  similarity: number;
}

/**
 * RPC `match_procedures` (REQ-006, nombre exigido por el criterio de
 * aceptación): dado el embedding de perfil de UNA organización, devuelve las
 * `limit` convocatorias MÁS SIMILARES de esa MISMA organización, ordenadas
 * por similitud coseno descendente.
 *
 * Camino real: cuando pgvector está disponible, delega en la función SQL
 * `match_procedures` (creada por la migración 0099 SOLO en ese caso), que
 * usa el operador `<=>` sobre el índice ANN. Camino de FALLBACK
 * DETERMINISTA (obligatorio en el entorno de pruebas de este repo, ver
 * `packages/db/test/req006-pgvector-migration.test.ts`): sin pgvector, trae
 * los embeddings ya cacheados de la organización y calcula la MISMA
 * similitud coseno en TypeScript -- mismo resultado matemático, sin índice
 * ANN (aceptable: el volumen de convocatorias por organización en este
 * dominio no justifica más que un escaneo secuencial hoy).
 *
 * Aislamiento (REQ-059/061): el filtro `org_id = $1` es explícito en AMBOS
 * caminos (defensa en profundidad), además de la RLS real de
 * `tender_embeddings` para el rol `app_role` -- verificado en
 * `apps/api/test/req006-semantic-matching.test.ts` con un canary de
 * organización competidora.
 */
export async function matchProcedures(
  tx: DbExecutor,
  orgId: string,
  queryEmbedding: readonly number[],
  limit: number = 20
): Promise<MatchProceduresResult[]> {
  const boundedLimit = Math.max(0, Math.trunc(limit));
  if (boundedLimit === 0) return [];

  const pgvectorOn = await isPgvectorAvailable(tx);
  if (pgvectorOn) {
    const { rows } = await tx.query<{ tender_id: string; similarity: number }>(
      'select tender_id, similarity from match_procedures($1, $2::vector, $3)',
      [orgId, toVectorLiteral(queryEmbedding), boundedLimit]
    );
    return rows.map((r) => ({ tenderId: r.tender_id, similarity: r.similarity }));
  }

  const { rows } = await tx.query<{ tender_id: string; embedding_fallback: number[] }>(
    'select tender_id, embedding_fallback from tender_embeddings where org_id = $1',
    [orgId]
  );
  return rows
    .map((r) => ({ tenderId: r.tender_id, similarity: cosineSimilarity(queryEmbedding, r.embedding_fallback) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, boundedLimit);
}
