import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import { useDocumentMeta } from "./useDocumentMeta";

/**
 * WB-04 (docs/auditoria-2/web-r7-r8a.md §2): `index.html` fija
 * `<meta name="robots" content="noindex, nofollow">` para casi todo el
 * sitio (back office autenticado), y páginas públicas puntuales (`/`,
 * `/demo`) la revierten a "index, follow" mientras están montadas. El
 * cleanup solo restauraba `document.title`, dejando el meta `robots`
 * pegado en "index, follow" para cualquier ruta siguiente que no llame a
 * este hook -- este archivo reproduce ese ciclo real de montaje/
 * desmontaje sobre el DOM (jsdom), sin mocks.
 */
describe("useDocumentMeta", () => {
  beforeEach(() => {
    document.head.querySelectorAll('meta[name="robots"]').forEach((el) => el.remove());
  });

  afterEach(() => {
    document.head.querySelectorAll('meta[name="robots"]').forEach((el) => el.remove());
    document.title = "";
  });

  it("restaura el meta robots anterior ('noindex, nofollow' de index.html) al desmontar", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex, nofollow");
    document.head.appendChild(meta);

    const { unmount } = renderHook(() => useDocumentMeta({ title: "Demo", robots: "index, follow" }));
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("index, follow");

    unmount();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
  });

  it("elimina el meta robots (en vez de dejarlo pegado) si no existía ninguno antes del montaje", () => {
    expect(document.querySelector('meta[name="robots"]')).toBeNull();

    const { unmount } = renderHook(() => useDocumentMeta({ title: "Landing", robots: "index, follow" }));
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("index, follow");

    unmount();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  it("restaura el título anterior al desmontar", () => {
    document.title = "Título original";
    const { unmount } = renderHook(() => useDocumentMeta({ title: "Demo" }));
    expect(document.title).toBe("Demo · Atiende Licitaciones");

    unmount();
    expect(document.title).toBe("Título original");
  });

  it("nunca toca el meta robots si la página no pasa la opción (páginas autenticadas del panel)", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "robots");
    meta.setAttribute("content", "noindex, nofollow");
    document.head.appendChild(meta);

    const { unmount } = renderHook(() => useDocumentMeta({ title: "Panel" }));
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");

    unmount();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
  });
});
