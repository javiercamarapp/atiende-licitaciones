import { computeCrossSourceFingerprint } from "../dedupe/fingerprint.js";
import { sourceKey, type TenderRecord } from "../types/tender-record.js";

export interface UpsertResult {
  record: TenderRecord;
  wasNew: boolean;
  /** true si ya existía un registro con la misma clave pero con `snapshot.rawHash` distinto. */
  wasUpdated: boolean;
}

/**
 * Contrato de persistencia de convocatorias descubiertas. `apps/api`
 * implementará esta interfaz contra la base de datos real (tablas OCDS +
 * MxCnet, REQ-008); aquí solo vive la implementación en memoria usada por
 * `DiscoveryPipeline` y sus pruebas.
 */
export interface TenderRepository {
  upsert(record: TenderRecord): Promise<UpsertResult>;
  findBySourceAndExternalId(source: string, externalId: string): Promise<TenderRecord | undefined>;
  /**
   * Candidatos de la MISMA convocatoria publicada por otra fuente (REQ-001
   * cruce entre fuentes), vía `computeCrossSourceFingerprint` (SR-07). El
   * resultado es SIEMPRE un candidato a REVISAR (posible falso positivo:
   * dos procedimientos distintos de la misma entidad con título genérico
   * compartido pueden colisionar), NUNCA una fusión automática. Ningún
   * punto de `DiscoveryPipeline`/`processRecord` invoca este método hoy
   * (no hay fusión automática en este paquete); un consumidor futuro que sí
   * fusione candidatos debe tratar el resultado como sugerencia, no como
   * hecho confirmado.
   */
  findByFingerprint(fingerprint: string): Promise<TenderRecord[]>;
  all(): Promise<TenderRecord[]>;
}

export class InMemoryTenderRepository implements TenderRepository {
  private readonly byKey = new Map<string, TenderRecord>();
  private readonly byFingerprint = new Map<string, Set<string>>();

  async upsert(record: TenderRecord): Promise<UpsertResult> {
    const key = sourceKey(record);
    const existing = this.byKey.get(key);
    const wasNew = !existing;
    const wasUpdated = Boolean(existing) && existing?.snapshot.rawHash !== record.snapshot.rawHash;

    this.byKey.set(key, record);

    const fingerprint = computeCrossSourceFingerprint(record);
    const bucket = this.byFingerprint.get(fingerprint) ?? new Set<string>();
    bucket.add(key);
    this.byFingerprint.set(fingerprint, bucket);

    return { record, wasNew, wasUpdated };
  }

  async findBySourceAndExternalId(source: string, externalId: string): Promise<TenderRecord | undefined> {
    return this.byKey.get(`${source}:${externalId}`);
  }

  async findByFingerprint(fingerprint: string): Promise<TenderRecord[]> {
    const keys = this.byFingerprint.get(fingerprint);
    if (!keys) return [];
    return [...keys].map((k) => this.byKey.get(k)).filter((r): r is TenderRecord => Boolean(r));
  }

  async all(): Promise<TenderRecord[]> {
    return [...this.byKey.values()];
  }
}
