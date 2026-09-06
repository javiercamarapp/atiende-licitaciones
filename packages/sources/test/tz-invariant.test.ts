import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsxBin = path.join(__dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
const harnessPath = path.join(__dirname, "tz-harness", "print-connector-date.ts");
const connectorsDir = path.join(__dirname, "..", "src", "connectors");

function runHarness(connectorId: string, tz: string): { dateIso?: string; recordCount: number; resolvedTz: string } {
  const stdout = execFileSync(tsxBin, [harnessPath, connectorId], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

/** Los 6 `SourceId` que registra `ConnectorRegistry` hoy (ver `test/connectors/registry.test.ts`). */
const REGISTERED_SOURCE_IDS = ["compras-mx", "compras-mx-historico", "dof", "ocds-shcp", "pdn-s6", "state-portal"];

describe(
  "SR-12 (invariante ampliada): TODOS los conectores registrados producen fechas TZ-independientes ante una entrada naive",
  () => {
    for (const sourceId of REGISTERED_SOURCE_IDS) {
      it(
        `${sourceId}: el mismo fixture con fecha naive produce el MISMO instante bajo TZ=UTC/America/Mexico_City/Asia/Tokyo`,
        () => {
          const resultUtc = runHarness(sourceId, "UTC");
          const resultMx = runHarness(sourceId, "America/Mexico_City");
          const resultTokyo = runHarness(sourceId, "Asia/Tokyo");

          // Confirma que cada subproceso realmente corrió con el TZ pedido (si esto fallara, el test no probaría nada).
          expect(resultUtc.resolvedTz).toBe("UTC");
          expect(resultMx.resolvedTz).toBe("America/Mexico_City");
          expect(resultTokyo.resolvedTz).toBe("Asia/Tokyo");

          // Confirma que el conector realmente produjo un registro con el fixture (si esto fallara -- 0 registros --
          // el resto de las aserciones pasaría trivialmente con `undefined === undefined`, sin probar nada).
          expect(resultUtc.recordCount).toBeGreaterThan(0);
          expect(resultUtc.dateIso).toBeDefined();

          expect(resultUtc.dateIso).toBe(resultMx.dateIso);
          expect(resultUtc.dateIso).toBe(resultTokyo.dateIso);
        },
        20_000,
      );
    }
  },
);

function stripCommentsForScan(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "") // bloques /* ... */ (incluye JSDoc): evita falsos positivos por menciones en comentarios.
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

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

describe("SR-12 (estático): ningún conector construye `new Date(<algo>)` directo con argumento", () => {
  it("fuera de `new Date()` (reloj 'ahora'), toda fecha de NEGOCIO debe pasar por fromMexicoCityNaive()/parseComprasMxDate()/parseDofDate()/parseOcdsDate()", () => {
    // `new Date(` seguido de un carácter que no sea el `)` de cierre inmediato -> tiene argumento(s).
    const forbidden = /new Date\(\s*[^)\s]/;
    const offenders: string[] = [];

    for (const file of listTsFilesRecursively(connectorsDir)) {
      const content = stripCommentsForScan(readFileSync(file, "utf8"));
      for (const [index, line] of content.split("\n").entries()) {
        if (forbidden.test(line)) {
          offenders.push(`${path.relative(connectorsDir, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
