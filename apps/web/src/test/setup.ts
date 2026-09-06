import { expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import * as axeMatchers from "vitest-axe/matchers";
import { clearTokens, writeStoredOrgId } from "@/lib/api/session";
import { server } from "@/test/msw";

// RF-03 (ConfiguracionPage.tsx, TotpQrCode): `qrcode` dibuja el QR real del
// 2FA sobre un <canvas> real. jsdom no implementa
// `HTMLCanvasElement.prototype.getContext` (falta el paquete opcional
// `canvas` nativo): cualquier prueba que renderice esa pantalla sin mockear
// `qrcode` disparaba "Error: Not implemented: HTMLCanvasElement.prototype.
// getContext" en cada intento de dibujar (ver docs/logs/ci-local-4.log).
// Se descarta a propósito stubear `HTMLCanvasElement.prototype.getContext`
// aquí: axe-core (vitest-axe, usado en varias pruebas de accesibilidad de
// esta suite) llama a ese MISMO método para detectar ligaduras de icono en
// su regla de contraste de color -- fingir un contexto 2D "suficiente" para
// `qrcode` cambiaría también ese resultado de axe-core en pruebas que nada
// tienen que ver con el QR, un efecto colateral fuera de este arreglo. En
// su lugar se mockea el módulo `qrcode` completo: `toCanvas` resuelve sin
// dibujar nada real (jsdom no puede pintarlo de todas formas), dejando el
// componente en su camino feliz en vez de su `catch` de último recurso. La
// prueba RF-03 (ConfiguracionPage.test.tsx) que sí necesita verificar la
// llamada real usa su propio `vi.spyOn` sobre este mismo mock; la
// generación visual real la cubre `test:e2e` (navegador real, canvas real).
vi.mock("qrcode", () => ({
  default: {
    toCanvas: vi.fn().mockResolvedValue(undefined),
    toDataURL: vi.fn().mockResolvedValue(""),
    toString: vi.fn().mockResolvedValue(""),
    create: vi.fn(),
  },
}));

// Se extiende `expect` manualmente con los matchers en vez de usar el import
// de conveniencia "@testing-library/jest-dom/vitest" (o "vitest-axe/extend-expect"):
// en este monorepo con npm workspaces, otros paquetes (packages/db, packages/agents,
// packages/sources) fijan vitest@^2.1, así que ese vitest queda hoisteado en la raíz
// mientras apps/web usa su propio vitest@^4 anidado. El import de conveniencia de
// jest-dom hace `import { expect } from "vitest"` resuelto desde node_modules raíz
// (la instancia vieja), distinta de la instancia real que ejecuta los tests aquí —
// extendía el `expect` equivocado. Los matchers en sí (".../matchers") no importan
// "vitest", así que extender aquí con el `expect` correctamente resuelto evita el
// problema de doble instancia.
expect.extend(jestDomMatchers);
expect.extend(axeMatchers);

// "bypass": los tests que no interactúan con la API no registran ningún
// handler MSW; sus llamadas de red (si las hubiera) pasan de largo en vez de
// fallar la suite completa con un error de "unhandled request".
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

afterEach(() => {
  cleanup();
  // Evita que la sesión (tokens en memoria + refresh token/organización en
  // localStorage, ver src/lib/api/session.ts) se filtre de un test a otro
  // dentro del mismo archivo — el módulo es un singleton con estado.
  clearTokens();
  writeStoredOrgId(null);
});

// jsdom no implementa estas APIs del DOM real que Radix UI (Select/Dialog)
// usa internamente para su comportamiento de puntero/desplazamiento — sin
// estos no-ops, cualquier prueba que abra un <Select/> real (ronda 5: los
// selectores de convocatoria de los módulos del expediente) lanza
// "target.hasPointerCapture is not a function" al hacer click.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
// jsdom no implementa ResizeObserver: <SelectContent/> (Radix) lo usa para
// medir su viewport al abrirse; sin este stub, abrir un <Select/> real en
// una prueba nunca completa el ciclo de render (queda colgado, no lanza).
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

// jsdom no implementa matchMedia; ThemeSelector y useIsMobile lo necesitan.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}
