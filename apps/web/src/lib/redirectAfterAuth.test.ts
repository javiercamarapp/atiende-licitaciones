import { describe, expect, it } from "vitest";

import { redirectAfterAuth, DEFAULT_AFTER_AUTH } from "@/lib/redirectAfterAuth";

describe("redirectAfterAuth", () => {
  it("conserva la query firmada del enlace de invitación (el motivo de existir de esta función)", () => {
    expect(redirectAfterAuth({ from: { pathname: "/invitaciones/aceptar", search: "?d=abc&s=def" } })).toBe(
      "/invitaciones/aceptar?d=abc&s=def",
    );
  });

  it("sin `state` va al panel", () => {
    expect(redirectAfterAuth(null)).toBe(DEFAULT_AFTER_AUTH);
    expect(redirectAfterAuth(undefined)).toBe(DEFAULT_AFTER_AUTH);
    expect(redirectAfterAuth({})).toBe(DEFAULT_AFTER_AUTH);
  });

  it("acepta una ruta interna sin query", () => {
    expect(redirectAfterAuth({ from: { pathname: "/preparacion/expediente" } })).toBe("/preparacion/expediente");
  });

  /**
   * ADVERSARIAL (redirección abierta). Este valor sale de `history.state`,
   * donde puede escribir cualquier página que consiga navegar a /login. Una
   * URL absoluta —incluida la forma `//host` que el navegador trata como
   * absoluta— nunca debe sobrevivir a este filtro.
   */
  it.each([
    "https://sitio-malicioso.example/robar",
    "//sitio-malicioso.example",
    "/\\sitio-malicioso.example",
    "javascript:alert(1)",
    "panel",
    "",
  ])("descarta %j y cae al panel", (pathname) => {
    expect(redirectAfterAuth({ from: { pathname } })).toBe(DEFAULT_AFTER_AUTH);
  });

  it("ignora un `from` que no tiene la forma esperada", () => {
    expect(redirectAfterAuth({ from: "/panel" })).toBe(DEFAULT_AFTER_AUTH);
    expect(redirectAfterAuth({ from: { pathname: 42 } })).toBe(DEFAULT_AFTER_AUTH);
    expect(redirectAfterAuth("una cadena suelta")).toBe(DEFAULT_AFTER_AUTH);
  });

  it("ignora un `search` que no es una cadena en vez de romperse", () => {
    expect(redirectAfterAuth({ from: { pathname: "/panel", search: { d: "abc" } } })).toBe("/panel");
  });
});
