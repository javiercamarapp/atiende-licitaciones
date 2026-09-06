/**
 * ProposalVersion (REQ-161): versionado con hash de insumos. Cada versión
 * registra el hash de cada insumo utilizado (documento de bases, dato de
 * empresa, tarifa) para que, dado el hash, se puedan reconstruir
 * exactamente los insumos usados en esa versión.
 */
import { isoNow, sha256Hex } from "./types.js";

export interface ProposalInputRecord {
  /** p. ej. "requirement_matrix", "company_profile", "approved_rate:consultoria" */
  key: string;
  hash: string;
}

export interface ProposalVersion {
  version: number;
  hash: string;
  createdAt: string;
  inputs: ProposalInputRecord[];
}

export class ProposalVersionRegistry {
  private readonly versions: ProposalVersion[] = [];

  /** Registra una nueva versión a partir de un mapa `{clave: valor}` de insumos crudos; hashea cada uno y el conjunto. */
  createVersion(inputs: Record<string, unknown>): ProposalVersion {
    const inputRecords: ProposalInputRecord[] = Object.entries(inputs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, hash: sha256Hex(value) }));

    const combinedHash = sha256Hex(inputRecords);
    const version: ProposalVersion = {
      version: this.versions.length + 1,
      hash: combinedHash,
      createdAt: isoNow(),
      inputs: inputRecords,
    };
    this.versions.push(version);
    return version;
  }

  getVersion(version: number): ProposalVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  latest(): ProposalVersion | undefined {
    return this.versions[this.versions.length - 1];
  }

  all(): ProposalVersion[] {
    return [...this.versions];
  }

  /** Recalcula el hash de un insumo dado y compara contra el registrado en `version` — permite detectar si cambió desde entonces. */
  static inputChanged(version: ProposalVersion, key: string, currentValue: unknown): boolean {
    const recorded = version.inputs.find((i) => i.key === key);
    if (!recorded) return true; // insumo nuevo, no existía en esa versión: se considera cambio
    return recorded.hash !== sha256Hex(currentValue);
  }
}
