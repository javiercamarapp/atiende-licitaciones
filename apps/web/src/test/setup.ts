import { expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import * as axeMatchers from "vitest-axe/matchers";

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

afterEach(() => {
  cleanup();
});

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
