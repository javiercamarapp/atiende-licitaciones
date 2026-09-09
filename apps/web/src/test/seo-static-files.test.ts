import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * E22 / REQ-197: "sitemap.xml y robots.txt accesibles". Antes de este
 * archivo, ningún test verificaba esto (ver docs/ACEPTACION.md REQ-197) —
 * ambos vivían en `public/` y Vite los copia tal cual a `dist/` sin pasar
 * por ningún build step que un test normal ejercite, así que se leen
 * directo del disco en vez de por HTTP (no hay servidor real en un test
 * unitario).
 */
const PUBLIC_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../public");

describe("archivos estáticos de SEO en apps/web/public", () => {
  it("robots.txt existe y es accesible", () => {
    const content = readFileSync(path.join(PUBLIC_DIR, "robots.txt"), "utf-8");
    expect(content).toContain("User-agent");
  });

  it("sitemap.xml existe, es XML válido y solo lista rutas marcadas index,follow en su propia página", () => {
    const content = readFileSync(path.join(PUBLIC_DIR, "sitemap.xml"), "utf-8");
    expect(content).toContain('<?xml version="1.0"');
    expect(content).toContain("<urlset");

    // Mismo criterio que `useDocumentMeta` ya aplica en el código (ver
    // LandingPage.tsx/DemoPage.tsx): SOLO "/" y "/demo" pasan
    // `robots: "index, follow"` -- el resto del sitio es back office
    // autenticado o un flujo de correo/acceso de un solo uso, sin nada que
    // ganar (y con un `noindex, nofollow` propio que contradecir) al
    // listarlo en el sitemap.
    expect(content).toContain("<loc>https://atiende-licitaciones.vercel.app/</loc>");
    expect(content).toContain("<loc>https://atiende-licitaciones.vercel.app/demo</loc>");
    expect(content).not.toContain("/login<");
    expect(content).not.toContain("/registro<");
  });
});
