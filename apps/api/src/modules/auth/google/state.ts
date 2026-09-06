/**
 * REQ-172: `state` anti-CSRF firmado. El valor real (PKCE `code_verifier` +
 * `nonce` + `redirect_uri`) vive en la tabla `oauth_states`
 * (0071_req172_google_oidc.sql), identificado por un `id` (uuid) --
 * `state` es un JWT compacto que solo transporta ese `id`, firmado con una
 * clave DERIVADA del `JWT_SECRET` de la aplicación (nunca la clave cruda:
 * separación de dominio explícita, para que un JWT de este propósito nunca
 * sea aceptado por accidente donde se espera un access/refresh token de
 * `lib/jwt.ts`, ni viceversa). Firmar el `id` (en vez de devolver el uuid
 * en claro) evita que un cliente pueda enumerar/forjar un `state` válido
 * sin conocer `JWT_SECRET`, y la expiración del propio JWT es una segunda
 * capa de TTL además de `oauth_states.expires_at` (verificada de forma
 * atómica en `app.consume_oauth_state`).
 */
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const encoder = new TextEncoder();

function deriveStateKey(jwtSecret: string): Uint8Array {
  return encoder.encode(createHash('sha256').update(`google-oauth-state:${jwtSecret}`).digest('hex'));
}

export async function signOauthState(jwtSecret: string, oauthStateId: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ typ: 'oauth_state', sid: oauthStateId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(deriveStateKey(jwtSecret));
}

/** Verifica la firma/expiración del JWT y devuelve el `id` de `oauth_states` que transporta. Lanza si es inválido, ajeno o expirado. */
export async function verifyOauthState(jwtSecret: string, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, deriveStateKey(jwtSecret));
  if (payload.typ !== 'oauth_state' || typeof payload.sid !== 'string' || payload.sid.length === 0) {
    throw new Error('state no es un token de oauth_state válido');
  }
  return payload.sid;
}
