import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import { createComprasMxConnector } from "../../src/connectors/compras-mx/compras-mx-connector.js";
import { createComprasMxHistoricalCsvConnector } from "../../src/connectors/compras-mx/compras-mx-historical-csv-connector.js";
import { createDofConnector } from "../../src/connectors/dof/dof-connector.js";
import { createOcdsShcpConnector } from "../../src/connectors/ocds-shcp/ocds-shcp-connector.js";
import { createPdnS6Connector } from "../../src/connectors/pdn-s6/pdn-s6-connector.js";
import { createStatePortalConnector } from "../../src/connectors/state-portal/state-portal-connector.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "..", "..", "src");

function listTsFilesRecursively(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listTsFilesRecursively(full));
    else if (entry.endsWith(".ts")) files.push(full);
  }
  return files;
}

describe("ConnectorRegistry (REQ-004)", () => {
  it("registra los 6 conectores (5 en vivo + el CSV histórico, SR-06) sin colisión de id y los recupera por id", () => {
    const registry = new ConnectorRegistry();
    registry.register(createComprasMxConnector());
    registry.register(createOcdsShcpConnector());
    registry.register(createDofConnector());
    registry.register(createPdnS6Connector());
    registry.register(createStatePortalConnector());
    registry.register(createComprasMxHistoricalCsvConnector());

    expect(registry.all()).toHaveLength(6);
    expect(registry.requireById("compras-mx").id).toBe("compras-mx");
    expect(registry.requireById("compras-mx-historico").id).toBe("compras-mx-historico");
    expect(() => registry.register(createDofConnector())).toThrow(/Ya existe un conector registrado/);
  });

  it("lanza si se pide un conector no registrado", () => {
    const registry = new ConnectorRegistry();
    expect(() => registry.requireById("dof")).toThrow(/No hay conector registrado/);
  });

  it("test estático: ningún archivo fuera de registry.ts ramifica con `=== \"<sourceId>\"` sobre el id de una fuente (REQ-004)", () => {
    const sourceIds = ["compras-mx", "ocds-shcp", "dof", "pdn-s6", "state-portal", "compras-mx-historico"];
    const forbiddenPattern = new RegExp(`(===|==)\\s*["'](${sourceIds.join("|")})["']`);
    const allowedFiles = new Set(["registry.ts", "tender-record.ts"]); // tender-record.ts define el enum, no ramifica

    const offenders: string[] = [];
    for (const file of listTsFilesRecursively(srcDir)) {
      const basename = path.basename(file);
      if (allowedFiles.has(basename)) continue;
      const content = readFileSync(file, "utf8");
      if (forbiddenPattern.test(content)) {
        offenders.push(path.relative(srcDir, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
