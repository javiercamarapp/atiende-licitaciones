/**
 * PgFingerprintStore (REQ-032): adaptador REAL de `FingerprintStore`
 * (`@atiende/agents`) contra Postgres. Es el único punto del sistema que
 * traduce el puerto de negocio a SQL/RLS -- la decisión de qué es
 * "similar" y cuándo avisar vive enteramente en
 * `CrossTenantSimilarityDetector` (paquete `@atiende/agents`), nunca aquí.
 *
 * Usa los contextos `worker_role` de `./db-context.js` (mismo patrón que el
 * resto de `business-tools.ts`): `withFingerprintWriteContext` (org-scoped,
 * la huella propia) y `withFingerprintCompareContext`/
 * `withSimilarityFlagInsertContext` (cross-tenant, solo huellas/hashes,
 * nunca contenido).
 */
import type { DbClient } from '@atiende/db';
import type { FingerprintRecord, FingerprintStore, SimilarityFlagEvent } from '@atiende/agents';
import { withFingerprintWriteContext, withFingerprintCompareContext, withSimilarityFlagInsertContext } from './db-context.js';

export class PgFingerprintStore implements FingerprintStore {
  constructor(private readonly db: DbClient) {}

  async upsertFingerprint(record: FingerprintRecord): Promise<void> {
    await withFingerprintWriteContext(this.db, record.orgId, (tx) =>
      tx.query(
        `insert into proposal_section_fingerprints (org_id, tender_id, section_key, algorithm_version, signature, band_hashes, shingle_count)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (org_id, tender_id, section_key, algorithm_version)
         do update set signature = excluded.signature, band_hashes = excluded.band_hashes, shingle_count = excluded.shingle_count`,
        [
          record.orgId,
          record.tenderId,
          record.sectionKey,
          record.algorithmVersion,
          Array.from(record.signature),
          Array.from(record.bandHashes),
          record.shingleCount,
        ],
      ),
    );
  }

  async findCandidatesByBands(input: { excludeOrgId: string; bandHashes: readonly string[]; algorithmVersion: number }): Promise<FingerprintRecord[]> {
    if (input.bandHashes.length === 0) return [];
    const { rows } = await withFingerprintCompareContext(this.db, (tx) =>
      tx.query<{
        org_id: string;
        tender_id: string;
        section_key: string;
        algorithm_version: number;
        signature: number[];
        band_hashes: string[];
        shingle_count: number;
      }>(
        `select org_id, tender_id, section_key, algorithm_version, signature, band_hashes, shingle_count
         from proposal_section_fingerprints
         where org_id <> $1 and algorithm_version = $2 and band_hashes && $3::text[]`,
        [input.excludeOrgId, input.algorithmVersion, Array.from(input.bandHashes)],
      ),
    );
    return rows.map((r) => ({
      orgId: r.org_id,
      tenderId: r.tender_id,
      sectionKey: r.section_key,
      algorithmVersion: r.algorithm_version,
      signature: r.signature,
      bandHashes: r.band_hashes,
      shingleCount: r.shingle_count,
    }));
  }

  async recordSimilarityFlag(event: SimilarityFlagEvent): Promise<void> {
    await withSimilarityFlagInsertContext(this.db, (tx) =>
      tx.query(
        `insert into proposal_similarity_flags (org_id, tender_id, section_key, similarity, matched_org_id, matched_tender_id, matched_section_key, regenerated)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.orgId,
          event.tenderId,
          event.sectionKey,
          event.similarity,
          event.matchedOrgId,
          event.matchedTenderId,
          event.matchedSectionKey,
          event.regenerated,
        ],
      ),
    );
  }
}
