import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * REQ-182 exige un adaptador único de proveedor de correo por env, "sin
 * `if provider === X` fuera del adaptador". La arquitectura (un solo
 * `src/provider/factory.ts` decide, con `resend`/`postmark`/`smtp`/`capture`
 * detrás de `provider/types.ts`) ya es correcta, pero el criterio pide un
 * test estático que la GUARDE: si alguien agrega, en cualquier archivo de
 * `packages/mail/src` fuera de `src/provider/`, un condicional que
 * distinga el proveedor concreto (`if (provider === "resend")`, un
 * `switch (kind) { case "smtp": ... }`, o una lectura directa de
 * `MAIL_PROVIDER`), este test falla y señala el archivo y la línea.
 *
 * El único lugar autorizado para esas comparaciones es `src/provider/`
 * (el propio adaptador/factory) — se excluye explícitamente de este scan.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const ADAPTER_DIR = join(SRC_ROOT, "provider");
const SOURCE_FILE_RE = /\.(ts|tsx)$/;

const PROVIDER_KIND_LITERAL = /["'`](resend|postmark|smtp|capture)["'`]/.source;

interface ForbiddenPattern {
  readonly description: string;
  readonly regex: RegExp;
}

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    description: "comparación (===/!==) contra el literal de un proveedor concreto",
    regex: new RegExp(`(===|!==)\\s*${PROVIDER_KIND_LITERAL}`, "g"),
  },
  {
    description: "literal de un proveedor concreto comparado (===/!==) por la izquierda",
    regex: new RegExp(`${PROVIDER_KIND_LITERAL}\\s*(===|!==)`, "g"),
  },
  {
    description: "`case` de un `switch` sobre el nombre de un proveedor concreto",
    regex: new RegExp(`\\bcase\\s*${PROVIDER_KIND_LITERAL}\\s*:`, "g"),
  },
  {
    description: "lectura directa de la variable de entorno MAIL_PROVIDER fuera del adaptador",
    regex: /\bMAIL_PROVIDER\b/g,
  },
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (SOURCE_FILE_RE.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function isInsideAdapter(filePath: string): boolean {
  const rel = relative(ADAPTER_DIR, filePath);
  return !rel.startsWith("..") && rel !== "";
}

describe("REQ-182: un único adaptador de proveedor de correo (test estático)", () => {
  const allSourceFiles = listSourceFiles(SRC_ROOT);
  const filesOutsideAdapter = allSourceFiles.filter((f) => !isInsideAdapter(f));

  it("el scan tiene algo que revisar (evita un falso verde por un scope vacío)", () => {
    expect(allSourceFiles.length).toBeGreaterThan(10);
    expect(filesOutsideAdapter.length).toBeGreaterThan(10);
    // El propio adaptador existe y quedó correctamente excluido del scan.
    expect(allSourceFiles.length).toBeGreaterThan(filesOutsideAdapter.length);
  });

  it("src/provider/ (el adaptador) SÍ contiene la lógica de selección — control del propio test", () => {
    const factoryPath = join(ADAPTER_DIR, "factory.ts");
    const factorySource = readFileSync(factoryPath, "utf-8");
    const hasSelectionLogic = FORBIDDEN_PATTERNS.some((p) => new RegExp(p.regex.source, "g").test(factorySource));
    expect(hasSelectionLogic).toBe(true);
  });

  it.each(filesOutsideAdapter.map((f) => [relative(SRC_ROOT, f), f] as const))(
    "«src/%s» no decide por nombre de proveedor concreto fuera del adaptador",
    (_relPath, filePath) => {
      const source = readFileSync(filePath, "utf-8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        const regex = new RegExp(pattern.regex.source, "g");
        const match = regex.exec(source);
        if (match) {
          const upToMatch = source.slice(0, match.index);
          const line = upToMatch.split("\n").length;
          throw new Error(
            `${relative(SRC_ROOT, filePath)}:${line} — ${pattern.description} ("${match[0]}"). ` +
              "REQ-182 exige que solo src/provider/ (el adaptador/factory) decida por proveedor concreto.",
          );
        }
      }
    },
  );
});
