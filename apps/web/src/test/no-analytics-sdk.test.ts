import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CONTENT_SECURITY_POLICY } from "@/lib/security/csp";

/**
 * REQ-198 (AMPLIACION-2 §4) / docs/ACEPTACION.md: "Analítica de páginas
 * públicas sin captura de datos personales identificables (sin PII en
 * eventos, sin cookies de terceros no declaradas)".
 *
 * Estado real verificado hoy (2026-09): `apps/web` no tiene NINGÚN SDK de
 * analítica instalado, ningún script de analítica en `index.html`, y
 * ninguna llamada a una plataforma de analítica en `src/` ni `e2e/`. Antes
 * de este archivo, esa verificación era manual (un `grep` corrido a mano
 * durante una auditoría) y no bloqueaba un PR que agregara analítica de
 * golpe. Este test la fija como REGRESIÓN automática: si alguien agrega un
 * SDK/script/llamada de analítica sin pasar por
 * `src/lib/analytics/piiGuard.ts` (`guardAnalyticsSink`/`assertNoPii`, ver
 * ese archivo y `piiGuard.test.ts` para la lógica que SÍ bloquea PII una vez
 * que exista analítica real), este test falla en CI y señala exactamente
 * qué se encontró.
 *
 * No sustituye a `piiGuard.test.ts` (que prueba la lógica de detección de
 * PII en sí): esta prueba es la trampa de alambre que asegura que la
 * decisión de "agregar analítica" pase por revisión de código en vez de
 * colarse silenciosamente.
 */

const WEB_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const SRC_DIR = path.join(WEB_ROOT, "src");
const E2E_DIR = path.join(WEB_ROOT, "e2e");
const INDEX_HTML = path.join(WEB_ROOT, "index.html");
const PACKAGE_JSON = path.join(WEB_ROOT, "package.json");

// El propio guardia (src/lib/analytics/) y este archivo documentan a
// propósito los nombres de SDKs de analítica conocidos (para reconocerlos)
// -- se excluyen del escaneo de código fuente para no autodetectarse.
const SELF_FILE = fileURLToPath(import.meta.url);
const ANALYTICS_GUARD_DIR = path.join(SRC_DIR, "lib", "analytics");

const SCANNABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".html", ".css"]);
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "coverage", "playwright-report", ".artifacts"]);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (SCANNABLE_EXTENSIONS.has(path.extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

function isExcludedFromSourceScan(file: string): boolean {
  return file === SELF_FILE || file.startsWith(`${ANALYTICS_GUARD_DIR}${path.sep}`);
}

/**
 * SDKs/plataformas de analítica y tracking de terceros conocidos. Lista
 * heurística (no exhaustiva) -- suficiente para atrapar la enorme mayoría
 * de integraciones reales de analítica de páginas públicas.
 */
const ANALYTICS_SOURCE_MARKERS: RegExp[] = [
  /\bgtag\s*\(/i,
  /\bdataLayer\b/,
  /\bplausible\b/i,
  /\bposthog\b/i,
  /\bumami\b/i,
  /\bmixpanel\b/i,
  /\bamplitude\b/i,
  /segment\.(io|com)/i,
  /\bhotjar\b/i,
  /clarity\.ms/i,
  /\bfullstory\b/i,
  /\bmatomo\b/i,
  /heap\.io/i,
  /@vercel\/analytics/i,
  /@vercel\/speed-insights/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
];

const ANALYTICS_PACKAGE_NAMES = [
  "posthog-js",
  "posthog-node",
  "plausible-tracker",
  "react-ga",
  "react-ga4",
  "@amplitude/analytics-browser",
  "mixpanel-browser",
  "@segment/analytics-next",
  "@segment/analytics-node",
  "hotjar",
  "clarity-js",
  "@microsoft/clarity",
  "fullstory",
  "@fullstory/browser",
  "@vercel/analytics",
  "@vercel/speed-insights",
  "matomo-tracker",
];

describe("REQ-198: 0 analítica hoy en apps/web (regresión explícita)", () => {
  it("ninguna dependencia declarada en package.json es un SDK de analítica/tracking conocido", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    const found = ANALYTICS_PACKAGE_NAMES.filter((name) => declared.has(name));
    expect(
      found,
      `Se encontró dependencia(s) de analítica en package.json: ${found.join(", ")}. ` +
        `Antes de instalarla(s), enruta cualquier evento por src/lib/analytics/piiGuard.ts (guardAnalyticsSink) y actualiza este test.`,
    ).toEqual([]);
  });

  it("index.html no carga ningún script/beacon de analítica de terceros", () => {
    const html = readFileSync(INDEX_HTML, "utf-8");
    const matched = ANALYTICS_SOURCE_MARKERS.filter((re) => re.test(html)).map((re) => re.source);
    expect(matched, `index.html contiene referencias a analítica: ${matched.join(", ")}`).toEqual([]);
  });

  it("src/ y e2e/ no contienen ninguna llamada/import a un SDK de analítica de terceros", () => {
    const files = [...collectFiles(SRC_DIR), ...collectFiles(E2E_DIR)].filter((f) => !isExcludedFromSourceScan(f));
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      for (const marker of ANALYTICS_SOURCE_MARKERS) {
        if (marker.test(content)) {
          offenders.push(`${path.relative(WEB_ROOT, file)} (${marker.source})`);
        }
      }
    }
    expect(
      offenders,
      `Se encontraron referencias a analítica de terceros: ${offenders.join("; ")}. ` +
        `Si es intencional, la implementación DEBE pasar por guardAnalyticsSink (src/lib/analytics/piiGuard.ts) y este test debe actualizarse a propósito, con revisión de código.`,
    ).toEqual([]);
  });

  it("la CSP real de apps/web sigue restringiendo connect-src a 'self' (defensa de red complementaria)", () => {
    // Mientras connect-src sea 'self', un beacon de analítica hacia un
    // dominio de terceros ya sería bloqueado por el navegador salvo que
    // alguien edite src/lib/security/csp.ts a propósito -- momento en el
    // que también debería enrutar el evento por el guardia de PII.
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
  });
});
