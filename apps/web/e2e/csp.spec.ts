import { test, expect } from "./fixtures";

// WI-01 (docs/auditoria-2/web-integrado.md): antes de esta corrección no
// existía NINGUNA Content-Security-Policy real -- ni en la respuesta HTTP
// de `vite preview` (el mismo artefacto que serviría en producción) ni en
// el propio HTML. Esta prueba corre contra el navegador real (no jsdom):
// verifica la CSP EFECTIVA (la que el navegador de verdad aplica) y que un
// `<script>` inline inyectado dinámicamente (el patrón clásico de una
// carga útil de XSS) NO se ejecuta bajo esa política.
test.describe("Content-Security-Policy real (WI-01)", () => {
  test("la respuesta HTTP de vite preview trae una CSP real sin 'unsafe-inline' en script-src", async ({ noAuthPage: page }) => {
    const response = await page.goto("/login");
    const csp = response?.headers()["content-security-policy"];
    expect(csp, "vite preview debe servir la cabecera Content-Security-Policy real, no solo el meta tag").toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline' 'self'"); // sanity: no se coló unsafe-inline en script-src
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("el documento sirve el meta tag CSP (defensa en profundidad para hosting estático sin cabeceras propias)", async ({ noAuthPage: page }) => {
    await page.goto("/login");
    const metaContent = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(metaContent).toContain("script-src 'self'");
    expect(metaContent).toContain("default-src 'self'");
  });

  test("un <script> inline inyectado dinámicamente NO se ejecuta bajo la CSP real", async ({ noAuthPage: page }) => {
    await page.goto("/login");

    const violationPromise = page.waitForEvent("console", {
      predicate: (msg) => msg.type() === "error" && /Content Security Policy|Refused to execute/i.test(msg.text()),
      timeout: 5_000,
    }).catch(() => null);

    // Patrón clásico de "DOM XSS": un script creado e insertado en tiempo
    // de ejecución (no uno que ya viniera en el HTML servido por el
    // servidor) -- exactamente lo que script-src 'self' sin
    // 'unsafe-inline' ni nonce/hash debe bloquear.
    const executed = await page.evaluate(() => {
      return new Promise<boolean>((resolve) => {
        (window as unknown as { __cspTestExecuted?: boolean }).__cspTestExecuted = false;
        const script = document.createElement("script");
        script.textContent = "window.__cspTestExecuted = true;";
        document.head.appendChild(script);
        // El bloqueo por CSP es síncrono para <script> insertado así; un
        // pequeño margen evita un falso negativo por timing.
        setTimeout(() => resolve(Boolean((window as unknown as { __cspTestExecuted?: boolean }).__cspTestExecuted)), 50);
      });
    });

    expect(executed, "el script inline inyectado NO debió ejecutarse bajo script-src 'self'").toBe(false);
    await violationPromise;
  });
});
