/**
 * CrossTenantSimilarityDetector (REQ-032, BLUEPRINT L625-627 G-11).
 *
 * Lógica de negocio REAL (no un stub): calcula la huella MinHash de un
 * texto recién generado, la persiste, busca candidatos de OTRAS
 * organizaciones que comparten al menos una banda LSH, estima Jaccard
 * exacto contra cada candidato (sobre las firmas, nunca sobre el
 * contenido) y decide si supera el umbral de similitud entre tenants.
 *
 * El PUERTO (`FingerprintStore`) es lo único que conoce Postgres/RLS -- el
 * adaptador real vive en `apps/worker/src/agents/similarity-store.pg.ts`
 * (mismo patrón `worker_role` ya usado por el resto de
 * `apps/worker/src/agents/db-context.ts`). El adaptador FAKE en memoria
 * (`InMemoryFingerprintStore`, este mismo archivo) es SOLO para test
 * unitario de la lógica de decisión -- nunca sustituye la prueba de
 * integración real contra Postgres (`apps/worker/test/similarity-*.test.ts`,
 * que sí usa `createMigratedDb()`).
 *
 * `calibrado_contra_datos_reales=false`: `DEFAULT_SIMILARITY_THRESHOLD` es
 * un valor de ingeniería razonable (ver justificación abajo), no calibrado
 * contra un gold-set real de pares de propuestas con colusión confirmada
 * -- ese gold-set no existe hoy y no se fabrica aquí.
 */
import { computeFingerprint, estimateJaccard, type MinHashSignature } from "./minhash.js";

/** Versión del algoritmo (shingle size, num hashes, bandas) -- una firma solo es comparable contra otra de la MISMA versión (ver `packages/db` migración REQ-032). Subir esta constante si cambian los parámetros del algoritmo. */
export const ALGORITHM_VERSION = 1;

/**
 * Umbral de similitud (estimador de Jaccard, 0-1) a partir del cual dos
 * secciones de tenants distintos se tratan como "misma plantilla". 0.75 es
 * un punto de partida razonable de la literatura de detección de
 * near-duplicates (documentos con Jaccard real >=0.75 comparten la enorme
 * mayoría de su estructura de 5-gramas de palabras -- muy por encima de la
 * coincidencia esperable por reutilizar boilerplate genérico del sector).
 * PENDIENTE calibrar contra casos reales confirmados cuando existan.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

export interface FingerprintRecord {
  orgId: string;
  tenderId: string;
  sectionKey: string;
  signature: MinHashSignature;
  bandHashes: readonly string[];
  shingleCount: number;
  algorithmVersion: number;
}

/**
 * Puerto real (no mockea la lógica de negocio -- solo el borde de
 * persistencia). `findCandidatesByBands` NUNCA debe devolver contenido de
 * texto de otra organización, solo firmas/metadatos de huella.
 */
export interface FingerprintStore {
  /** Reemplaza (upsert) la huella vigente de esta organización para esta sección de esta convocatoria. */
  upsertFingerprint(record: FingerprintRecord): Promise<void>;
  /** Candidatos de CUALQUIER otra organización que comparten al menos una de `bandHashes`. Nunca incluye al propio `excludeOrgId`. */
  findCandidatesByBands(input: {
    excludeOrgId: string;
    bandHashes: readonly string[];
    algorithmVersion: number;
  }): Promise<FingerprintRecord[]>;
  /**
   * Registra un evento de similitud entre tenants sobre el umbral, para
   * revisión de cumplimiento (anticolusión) -- visible SOLO a
   * superadmin/backoffice, nunca al tenant señalado ni al tenant con el
   * que coincidió (evita filtrar la identidad de un competidor).
   */
  recordSimilarityFlag(event: SimilarityFlagEvent): Promise<void>;
}

export interface SimilarityFlagEvent {
  orgId: string;
  tenderId: string;
  sectionKey: string;
  similarity: number;
  matchedOrgId: string;
  matchedTenderId: string;
  matchedSectionKey: string;
  regenerated: boolean;
}

export interface SimilarityAssessment {
  flagged: boolean;
  /** Máxima similitud (Jaccard estimado) encontrada contra CUALQUIER otra organización, redondeada a 2 decimales. 0 si no había candidatos. */
  similarity: number;
}

/**
 * Adaptador FAKE explícito en memoria -- borde externo simulado SOLO para
 * pruebas unitarias de `CrossTenantSimilarityDetector` en aislamiento (sin
 * levantar Postgres). Cualquier prueba que verifique el comportamiento
 * REAL de RLS/aislamiento entre tenants debe usar el adaptador de
 * Postgres real (`PgFingerprintStore`), nunca este.
 */
export class InMemoryFingerprintStore implements FingerprintStore {
  readonly fingerprints: FingerprintRecord[] = [];
  readonly flags: SimilarityFlagEvent[] = [];

  async upsertFingerprint(record: FingerprintRecord): Promise<void> {
    const idx = this.fingerprints.findIndex(
      (f) => f.orgId === record.orgId && f.tenderId === record.tenderId && f.sectionKey === record.sectionKey && f.algorithmVersion === record.algorithmVersion,
    );
    if (idx >= 0) this.fingerprints[idx] = record;
    else this.fingerprints.push(record);
  }

  async findCandidatesByBands(input: { excludeOrgId: string; bandHashes: readonly string[]; algorithmVersion: number }): Promise<FingerprintRecord[]> {
    const bandSet = new Set(input.bandHashes);
    return this.fingerprints.filter(
      (f) => f.orgId !== input.excludeOrgId && f.algorithmVersion === input.algorithmVersion && f.bandHashes.some((b) => bandSet.has(b)),
    );
  }

  async recordSimilarityFlag(event: SimilarityFlagEvent): Promise<void> {
    this.flags.push(event);
  }
}

export class CrossTenantSimilarityDetector {
  constructor(
    private readonly store: FingerprintStore,
    private readonly options: { threshold?: number; shingleSize?: number; numHashes?: number; numBands?: number; rowsPerBand?: number } = {},
  ) {}

  /**
   * Evalúa `content` (texto YA GENERADO, antes o después de regenerar) para
   * la sección `sectionKey` de la convocatoria `tenderId` de `orgId`.
   * SIEMPRE persiste la huella propia (para que futuras evaluaciones de
   * otros tenants puedan compararse contra ella), y si supera el umbral
   * contra otra organización, registra el evento de cumplimiento
   * (`recordSimilarityFlag`) -- `regenerated` documenta si esta evaluación
   * corresponde al borrador ya regenerado (segunda pasada) o al original.
   */
  async assess(
    content: string,
    ctx: { orgId: string; tenderId: string; sectionKey: string },
    opts: { regenerated: boolean } = { regenerated: false },
  ): Promise<SimilarityAssessment> {
    const fingerprint = computeFingerprint(content, this.options);
    const record: FingerprintRecord = {
      orgId: ctx.orgId,
      tenderId: ctx.tenderId,
      sectionKey: ctx.sectionKey,
      signature: fingerprint.signature,
      bandHashes: fingerprint.bandHashes,
      shingleCount: fingerprint.shingleCount,
      algorithmVersion: ALGORITHM_VERSION,
    };

    const candidates = await this.store.findCandidatesByBands({
      excludeOrgId: ctx.orgId,
      bandHashes: fingerprint.bandHashes,
      algorithmVersion: ALGORITHM_VERSION,
    });

    await this.store.upsertFingerprint(record);

    if (fingerprint.shingleCount === 0 || candidates.length === 0) {
      return { flagged: false, similarity: 0 };
    }

    let best: { similarity: number; candidate: FingerprintRecord } | null = null;
    for (const candidate of candidates) {
      const similarity = estimateJaccard(fingerprint.signature, candidate.signature);
      if (!best || similarity > best.similarity) best = { similarity, candidate };
    }
    /* istanbul ignore next -- candidates.length > 0 ya garantiza `best` no nulo */
    if (!best) return { flagged: false, similarity: 0 };

    const threshold = this.options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const roundedSimilarity = Math.round(best.similarity * 100) / 100;
    const flagged = best.similarity >= threshold;

    if (flagged) {
      await this.store.recordSimilarityFlag({
        orgId: ctx.orgId,
        tenderId: ctx.tenderId,
        sectionKey: ctx.sectionKey,
        similarity: roundedSimilarity,
        matchedOrgId: best.candidate.orgId,
        matchedTenderId: best.candidate.tenderId,
        matchedSectionKey: best.candidate.sectionKey,
        regenerated: opts.regenerated,
      });
    }

    return { flagged, similarity: roundedSimilarity };
  }
}
