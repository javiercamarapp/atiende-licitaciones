/**
 * REQ-178: credenciales de Google (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`)
 * únicamente por variable de entorno, NUNCA en el repositorio -- este
 * archivo es el ÚNICO punto de `apps/api` que las lee. Sin ellas
 * configuradas, el login con Google real permanece BLOQUEADO_EXTERNO
 * (declarado explícitamente en `apps/api/README.md`), sin impedir el
 * desarrollo ni las pruebas: `OIDC_ISSUER_URL` permite apuntar el flujo
 * completo a un proveedor OIDC FALSO local (ver
 * `apps/api/test/helpers/fake-oidc.ts`) en vez de a Google real -- el
 * resto del código (`discovery.ts`, `id-token.ts`, `token-exchange.ts`)
 * nunca hardcodea el issuer/endpoints de Google, siempre los descubre vía
 * `${issuerUrl}/.well-known/openid-configuration` (REQ-172: "issuer
 * configurable").
 *
 * Deliberadamente NO se lee vía `AppConfig`/`config.ts` (que sí exige sus
 * variables al arrancar, ver `loadConfig`): estas son opcionales a nivel de
 * proceso -- el resto de la API debe poder arrancar sin ellas, y solo
 * `GET /auth/google/start`/`GET /auth/google/callback` fallan explícitamente
 * (503) mientras no estén configuradas.
 */
export interface GoogleOidcEnv {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** REQ-172: issuer configurable -- default el propio Google, sin barra final. */
  issuerUrl: string;
}

export class GoogleOidcNotConfiguredError extends Error {
  constructor() {
    super(
      'Login con Google no configurado: faltan GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI. ' +
        'El flujo contra Google real permanece BLOQUEADO_EXTERNO hasta que se aporten credenciales reales ' +
        '(REQ-178, ver apps/api/README.md); las pruebas automatizadas usan un proveedor OIDC falso local vía OIDC_ISSUER_URL.'
    );
    this.name = 'GoogleOidcNotConfiguredError';
  }
}

export function loadGoogleOidcEnv(env: NodeJS.ProcessEnv = process.env): GoogleOidcEnv {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOidcNotConfiguredError();
  }
  const issuerUrlRaw = env.OIDC_ISSUER_URL?.trim() || 'https://accounts.google.com';
  return { clientId, clientSecret, redirectUri, issuerUrl: issuerUrlRaw.replace(/\/+$/, '') };
}
