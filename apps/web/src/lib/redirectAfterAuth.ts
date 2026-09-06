/**
 * A dónde volver después de un login/registro exitoso, a partir del
 * `state.from` que dejó quien mandó al usuario a `/login` o `/registro`
 * (`RequireAuth`, o `/invitaciones/aceptar`).
 *
 * Ronda 8b: antes se leía SOLO `from.pathname`, lo que bastaba mientras el
 * único origen era `RequireAuth` sobre rutas sin query. Con los enlaces
 * firmados del correo deja de bastar: `/invitaciones/aceptar?d=…&s=…` sin
 * su query es una pantalla vacía sin invitación que aceptar. Se conserva
 * `search` (nunca `hash`, que ninguna ruta de esta app usa).
 *
 * Dos guardas contra redirección abierta, porque este valor sale de
 * `history.state` y ahí puede escribir cualquier página que consiga
 * navegar a `/login`:
 *
 *  - Debe empezar por `/` — descarta `https://otro-sitio` y `javascript:`.
 *  - No puede empezar por `//` ni por `/\` — el navegador interpreta
 *    `//evil.com` como una URL absoluta protocol-relative, así que un
 *    `Navigate to="//evil.com"` sacaría al usuario del sitio.
 */
export const DEFAULT_AFTER_AUTH = "/panel";

interface LocationLike {
  pathname?: unknown;
  search?: unknown;
}

export function redirectAfterAuth(state: unknown): string {
  const from = (state as { from?: LocationLike } | null | undefined)?.from;
  const pathname = typeof from?.pathname === "string" ? from.pathname : null;
  if (!pathname || !pathname.startsWith("/") || pathname.startsWith("//") || pathname.startsWith("/\\")) {
    return DEFAULT_AFTER_AUTH;
  }
  const search = typeof from?.search === "string" ? from.search : "";
  return `${pathname}${search}`;
}
