import type { SourceId } from "../types/tender-record.js";

export interface Checkpoint {
  /** Cursor opaco de la fuente (paginación, timestamp, etc.) para reanudar exactamente donde se quedó. */
  cursor?: string;
  lastRunAt: string;
  lastExternalId?: string;
}

/** Almacén de checkpoints por fuente, para que `DiscoveryPipeline` pueda reanudar tras un corte/reinicio. */
export interface CheckpointStore {
  get(sourceId: SourceId): Promise<Checkpoint | undefined>;
  set(sourceId: SourceId, checkpoint: Checkpoint): Promise<void>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<SourceId, Checkpoint>();

  async get(sourceId: SourceId): Promise<Checkpoint | undefined> {
    return this.checkpoints.get(sourceId);
  }

  async set(sourceId: SourceId, checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(sourceId, checkpoint);
  }
}
