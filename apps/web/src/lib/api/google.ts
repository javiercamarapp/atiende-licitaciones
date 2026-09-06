// REQ-172..180 (docs/REQUISITOS.md, D-09 docs/DECISIONES.md): login con
// Google (OIDC). Espejo del cliente de `auth.ts` (login/registro por
// contraseña), pero público (ninguno de estos tres endpoints exige sesión
// previa — es exactamente el flujo que la CREA) — nunca pasa por
// `apiRequest` (que inyecta `Authorization`/`X-Org-Id` de una sesión que
// todavía no existe), siempre por `rawRequest` directo, igual que
// `login()`/`register()`.
import { rawRequest } from "./http";
import { googleAuthResultSchema, googleStartResponseSchema, type GoogleAuthResult, type GoogleStartResponse } from "./schemas";

/**
 * `GET /auth/google/start`: genera PKCE/state/nonce del lado del servidor y
 * devuelve la URL de autorización real del proveedor (Google, o el proveedor
 * OIDC falso de pruebas vía `OIDC_ISSUER_URL`). El llamador debe navegar el
 * navegador completo a `authorizationUrl` (`window.location.assign`, nunca
 * un `fetch` — es una redirección de usuario, no una llamada de API) — ver
 * `components/auth/GoogleAuthButton.tsx`.
 *
 * REQ-178: sin `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`
 * reales configuradas en `apps/api`, este endpoint responde `503` explícito
 * (BLOQUEADO_EXTERNO) — `GoogleAuthButton` lo distingue de cualquier otro
 * error vía `ApiError.status === 503` y muestra una explicación honesta en
 * vez de intentar la redirección.
 */
export async function startGoogleLogin(): Promise<GoogleStartResponse> {
  const raw = await rawRequest<unknown>("/auth/google/start");
  return googleStartResponseSchema.parse(raw);
}

/**
 * `GET /auth/google/callback?code&state[&error]`: intercambia el `code`
 * recibido en la redirección de vuelta del proveedor (capturado por
 * `pages/auth/GoogleCallbackPage.tsx` desde `window.location.search`, NUNCA
 * reenviado por el navegador solo — este endpoint vive en `apps/api`, no en
 * `apps/api`'s propio dominio de redirect_uri: `GOOGLE_REDIRECT_URI` apunta
 * a esta SPA, ver apps/api/test/google-oidc-login.test.ts).
 *
 * `error` (p. ej. `access_denied`, el usuario canceló el consentimiento en
 * el proveedor) se reenvía tal cual si viene en la URL — `apps/api` lo
 * audita y responde 400 con un mensaje honesto.
 */
export async function exchangeGoogleCallback(params: { code?: string | null; state: string; error?: string | null }): Promise<GoogleAuthResult> {
  const query = new URLSearchParams();
  if (params.code) query.set("code", params.code);
  query.set("state", params.state);
  if (params.error) query.set("error", params.error);
  const raw = await rawRequest<unknown>(`/auth/google/callback?${query.toString()}`);
  return googleAuthResultSchema.parse(raw);
}

/**
 * `POST /auth/google/verify-2fa`: completa un login `requires_2fa` (REQ-176
 * — la cuenta vinculada/existente ya tiene 2FA enrolado+verificado) con un
 * código TOTP de 6 dígitos o un código de respaldo `XXXX-XXXX`. El
 * `pendingToken` viene de `exchangeGoogleCallback` (`status: "requires_2fa"`)
 * y NUNCA autoriza nada por sí mismo — solo sirve para este intercambio.
 */
export async function verifyGoogleTwoFactor(pendingToken: string, code: string): Promise<GoogleAuthResult> {
  const raw = await rawRequest<unknown>("/auth/google/verify-2fa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pendingToken, code }),
  });
  return googleAuthResultSchema.parse(raw);
}
