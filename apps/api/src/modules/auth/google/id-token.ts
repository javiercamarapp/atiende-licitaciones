/**
 * REQ-172/REQ-179: verificación del `id_token` de Google contra el JWKS
 * real del proveedor (`jose`, RS256) -- `aud`/`iss`/`exp` verificados por
 * `jose` (falla explícitamente si no coinciden), `nonce` verificado a mano
 * contra el valor generado en `GET /auth/google/start` (ver `pkce.ts`,
 * `oauth_states.nonce`). `email_verified=false` (o ausente) se trata como
 * un caso de rechazo aparte en el llamador (REQ-179: "rechazado
 * explícitamente"), no aquí -- esta función solo valida la FORMA
 * criptográfica del token, nunca decide la política de negocio.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface GoogleIdTokenClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

export interface VerifyGoogleIdTokenParams {
  idToken: string;
  jwksUri: string;
  issuer: string;
  audience: string;
  expectedNonce: string;
}

export async function verifyGoogleIdToken(params: VerifyGoogleIdTokenParams): Promise<GoogleIdTokenClaims> {
  // Nota: se crea un `RemoteJWKSet` nuevo por llamada (sin caché entre
  // requests) -- simplicidad deliberada para esta ronda: cada proveedor
  // OIDC falso de pruebas vive en un puerto efímero distinto, así que
  // cachear por instancia de proceso no aportaría nada en el entorno de
  // pruebas y evita servir un JWKS obsoleto tras una rotación de clave real
  // de Google. Limitación documentada: en producción de alto tráfico
  // convendría cachear por `jwksUri` (jose ya soporta esto vía la misma
  // instancia de `RemoteJWKSet`) -- fuera de alcance de esta ronda.
  const jwks = createRemoteJWKSet(new URL(params.jwksUri));
  const { payload } = await jwtVerify(params.idToken, jwks, {
    issuer: params.issuer,
    audience: params.audience,
  });

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('id_token sin "sub"');
  }
  if (payload.nonce !== params.expectedNonce) {
    throw new Error('nonce del id_token no coincide con el esperado');
  }

  const emailVerifiedRaw = payload.email_verified;
  const emailVerified = emailVerifiedRaw === true || emailVerifiedRaw === 'true';

  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified,
  };
}
