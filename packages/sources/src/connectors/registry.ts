import type { SourceId } from "../types/tender-record.js";
import type { SourceConnector } from "./types.js";

/**
 * Registro único de conectores (REQ-004). Es la ÚNICA estructura del código
 * autorizada a asociar un `SourceId` con su implementación. Cualquier otro
 * módulo que necesite comportarse distinto por fuente debe pedirle el
 * conector a este registro, nunca comparar `=== "compras-mx"` (o similar)
 * directamente. `test/connectors/no-provider-branching.test.ts` falla si
 * aparece ese patrón fuera de este archivo.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<SourceId, SourceConnector>();

  register(connector: SourceConnector): this {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Ya existe un conector registrado con id "${connector.id}"`);
    }
    this.connectors.set(connector.id, connector);
    return this;
  }

  get(id: SourceId): SourceConnector | undefined {
    return this.connectors.get(id);
  }

  requireById(id: SourceId): SourceConnector {
    const connector = this.get(id);
    if (!connector) throw new Error(`No hay conector registrado para "${id}"`);
    return connector;
  }

  all(): SourceConnector[] {
    return [...this.connectors.values()];
  }
}
