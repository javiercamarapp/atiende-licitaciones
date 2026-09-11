import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Patrón Likida/atiende.ai #2 — frontera de capas dominio vs framework,
 * guardada con un test estático en CI (no solo documentada en README).
 *
 * El README (§"Arquitectura del monorepo") describe `packages/agents`
 * como "librería pura: auth., guardrails, idempot., presupuesto, trazas"
 * -- el runner de agentes de IA, consumido por `apps/api`/`apps/worker`,
 * nunca al revés. Su `package.json` ya refleja esto: solo declara `zod`
 * como dependencia de runtime, ningún framework HTTP/UI. Pero nada
 * verificaba esa frontera de forma automática: si alguien agregara
 * mañana un `import` de `fastify`/`express` (acoplando el dominio al
 * servidor HTTP) o de `react`/`vite` (acoplándolo a la UI), o una ruta
 * relativa hacia `apps/*` (invirtiendo la dependencia: el dominio no
 * debe conocer a sus consumidores), nada lo detectaba hasta notarse en
 * runtime o revisión manual.
 *
 * Mismo patrón que `packages/mail/test/provider/architecture.test.ts`
 * (REQ-182): grep estático sobre cada archivo fuente, con archivo:línea
 * en el mensaje de falla.
 */

const SRC_ROOT = join(import.meta.dirname, "..", "src");
const SOURCE_FILE_RE = /\.(ts|tsx)$/;

interface ForbiddenPattern {
  readonly description: string;
  readonly regex: RegExp;
}

const FRAMEWORK_SPECIFIERS = ["fastify", "@fastify/[a-z0-9-]+", "express", "react", "react-dom", "vite"].join("|");

const FORBIDDEN_PATTERNS: ForbiddenPattern[] = [
  {
    description: "import estático de un framework HTTP/UI (dominio no depende de framework)",
    regex: new RegExp(`\\bfrom\\s+["'](${FRAMEWORK_SPECIFIERS})(["']|/)`, "g"),
  },
  {
    description: "import()/require() dinámico de un framework HTTP/UI",
    regex: new RegExp(`\\b(?:import|require)\\(\\s*["'](${FRAMEWORK_SPECIFIERS})(["']|/)`, "g"),
  },
  {
    description: "import relativo hacia apps/* (inversión de dependencia: el dominio no conoce a sus consumidores)",
    regex: /\bfrom\s+["'][^"']*\/apps\/[^"']*["']/g,
  },
  {
    description: "import()/require() relativo hacia apps/*",
    regex: /\b(?:import|require)\(\s*["'][^"']*\/apps\/[^"']*["']/g,
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

describe("Patrón #2: frontera de capas dominio vs framework (@atiende/agents)", () => {
  const allSourceFiles = listSourceFiles(SRC_ROOT);

  it("el scan tiene algo que revisar (evita un falso verde por un scope vacío)", () => {
    expect(allSourceFiles.length).toBeGreaterThan(5);
  });

  it("el patrón SÍ detecta una violación de control (import de framework en un archivo simulado)", () => {
    const controlSource = 'import { FastifyInstance } from "fastify";\nimport("react-dom/client");\n';
    const hasViolation = FORBIDDEN_PATTERNS.some((p) => new RegExp(p.regex.source, "g").test(controlSource));
    expect(hasViolation).toBe(true);
  });

  it.each(allSourceFiles.map((f) => [relative(SRC_ROOT, f), f] as const))(
    "«src/%s» no importa un framework HTTP/UI ni una ruta hacia apps/*",
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
              "packages/agents es una librería pura consumida por apps/api y apps/worker, nunca al revés.",
          );
        }
      }
    },
  );
});
