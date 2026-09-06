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

/**
 * Base común de los errores de CONFIGURACIÓN de este módulo (credenciales
 * ausentes, issuer inseguro...). Existe para que las rutas puedan traducir
 * cualquiera de ellos al mismo 503 explícito ("el servidor no está
 * configurado para esto") en vez de a un 500 opaco -- ninguno de estos
 * errores lo puede provocar el cliente con ningún parámetro de la petición.
 */
export class GoogleOidcConfigError extends Error {}

export class GoogleOidcNotConfiguredError extends GoogleOidcConfigError {
  constructor() {
    super(
      'Login con Google no configurado: faltan GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI. ' +
        'El flujo contra Google real permanece BLOQUEADO_EXTERNO hasta que se aporten credenciales reales ' +
        '(REQ-178, ver apps/api/README.md); las pruebas automatizadas usan un proveedor OIDC falso local vía OIDC_ISSUER_URL.'
    );
    this.name = 'GoogleOidcNotConfiguredError';
  }
}

/**
 * GO-03 (docs/auditoria-2/api-google.md): `OIDC_ISSUER_URL` gobierna TODO el
 * flujo OIDC -- discovery, JWKS y token endpoint salen de
 * `${issuerUrl}/.well-known/openid-configuration` (ver `discovery.ts`). Con
 * `http://`, esos tres viajarían EN CLARO: cualquiera en la ruta podría
 * sustituir el JWKS por sus propias claves y, con ello, firmar `id_token`s
 * arbitrarios que esta API aceptaría como si vinieran de Google.
 */
export class GoogleOidcInsecureIssuerError extends GoogleOidcConfigError {
  constructor(issuerUrl: string, detail: string) {
    super(
      `OIDC_ISSUER_URL inválida (${detail}): "${issuerUrl}". El issuer OIDC debe usar https:// -- con http:// ` +
        'el documento de discovery, el JWKS y el token endpoint viajan en claro y un atacante en la ruta podría ' +
        'suplantar las claves de firma del proveedor. La ÚNICA excepción es el proveedor OIDC FALSO de pruebas ' +
        '(apps/api/test/helpers/fake-oidc.ts), que escucha en loopback: se admite http:// solo contra ' +
        '127.0.0.1/localhost/[::1] y solo fuera de NODE_ENV=production (GO-03, docs/auditoria-2/api-google.md).'
    );
    this.name = 'GoogleOidcInsecureIssuerError';
  }
}

/**
 * GO-03: hosts de loopback -- los ÚNICOS donde se tolera `http://`, porque son
 * exactamente los que levanta el proveedor OIDC falso de las pruebas
 * (`server.listen(0, '127.0.0.1')`) y por definición nunca salen de la
 * máquina, así que no hay "ruta" donde interceptar nada. Un despliegue real
 * jamás apunta su issuer a loopback.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * GO-03: valida el esquema del issuer OIDC y falla con un mensaje explícito.
 * Se invoca (a) al REGISTRAR las rutas de Google -- es decir, en el arranque
 * del proceso, ver `googleAuthRoutes` -- para que un `OIDC_ISSUER_URL` mal
 * configurado no llegue nunca a producción disfrazado de servicio sano, y
 * (b) en cada `loadGoogleOidcEnv`, como defensa en profundidad.
 */
export function assertSecureIssuerUrl(issuerUrl: string, env: NodeJS.ProcessEnv = process.env): void {
  let parsed: URL;
  try {
    parsed = new URL(issuerUrl);
  } catch {
    throw new GoogleOidcInsecureIssuerError(issuerUrl, 'no es una URL absoluta válida');
  }

  if (parsed.protocol === 'https:') return;
  if (parsed.protocol !== 'http:') {
    throw new GoogleOidcInsecureIssuerError(issuerUrl, `usa el esquema no soportado "${parsed.protocol}"`);
  }

  // `URL.hostname` de una IPv6 viene entre corchetes (`[::1]`).
  const hostname = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    throw new GoogleOidcInsecureIssuerError(issuerUrl, `usa http:// contra un host que no es de loopback ("${hostname}")`);
  }
  if ((env.NODE_ENV ?? '').trim() === 'production') {
    throw new GoogleOidcInsecureIssuerError(issuerUrl, 'usa http:// con NODE_ENV=production');
  }
}

/**
 * GO-03: comprobación de ARRANQUE. Solo mira el valor EXPLÍCITO del operador:
 * si no hay `OIDC_ISSUER_URL`, el default de `loadGoogleOidcEnv` ya es
 * forzosamente `https://accounts.google.com` y no hay nada que validar. No
 * exige que las credenciales de Google estén configuradas (REQ-178: la API
 * debe poder arrancar sin ellas), solo que, si el issuer se fijó a mano, sea
 * seguro.
 */
export function assertConfiguredIssuerUrlIsSecure(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env.OIDC_ISSUER_URL?.trim();
  if (!raw) return;
  assertSecureIssuerUrl(normalizeIssuerUrl(raw), env);
}

/** Quita las barras finales: el issuer se concatena con rutas absolutas (`/.well-known/...`). */
function normalizeIssuerUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export function loadGoogleOidcEnv(env: NodeJS.ProcessEnv = process.env): GoogleOidcEnv {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new GoogleOidcNotConfiguredError();
  }
  const issuerUrl = normalizeIssuerUrl(env.OIDC_ISSUER_URL?.trim() || 'https://accounts.google.com');
  // GO-03: nunca devolver un issuer inseguro -- `discovery.ts`/`id-token.ts`
  // confían ciegamente en él para descubrir el JWKS con el que se verifica la
  // firma de cada `id_token`.
  assertSecureIssuerUrl(issuerUrl, env);
  return { clientId, clientSecret, redirectUri, issuerUrl };
}
