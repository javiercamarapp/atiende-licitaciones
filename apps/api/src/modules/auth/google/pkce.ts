/**
 * REQ-172: PKCE (RFC 7636, method S256) + nonce (OIDC) para el flujo
 * Authorization Code de Google -- generación de valores criptográficamente
 * aleatorios, nunca predecibles.
 */
import { randomBytes, createHash } from 'node:crypto';

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

/** 32 bytes aleatorios en base64url (43 caracteres) -- dentro del rango 43-128 que exige RFC 7636. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function computeCodeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** Nonce OIDC: valor aleatorio único por intento, embebido en el id_token y verificado al volver (anti-replay). */
export function generateNonce(): string {
  return base64url(randomBytes(24));
}
