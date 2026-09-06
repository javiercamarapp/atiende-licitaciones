/**
 * REQ-176: cuando la cuenta destino de un login con Google ya tiene 2FA
 * enrolado y verificado, la sesión NO se completa hasta confirmar el
 * segundo factor (`POST /auth/google/verify-2fa`). Este token "pendiente"
 * es un JWT de vida MUY corta (5 min) que identifica exclusivamente al
 * usuario ya verificado por Google -- deliberadamente NO es un access
 * token real (`lib/jwt.ts`): no autoriza NINGÚN endpoint autenticado de la
 * API, solo puede canjearse en `POST /auth/google/verify-2fa` junto con un
 * código TOTP/backup válido para obtener el par access/refresh real (vía
 * `issueTokenPair`, el mismo camino que cualquier otro login -- REQ-175).
 * Firmado con una clave derivada propia (separación de dominio, mismo
 * patrón que `state.ts`).
 */
import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const encoder = new TextEncoder();
const PENDING_2FA_TTL_SECONDS = 5 * 60;

function deriveKey(jwtSecret: string): Uint8Array {
  return encoder.encode(createHash('sha256').update(`google-oauth-pending-2fa:${jwtSecret}`).digest('hex'));
}

export async function signPending2faToken(jwtSecret: string, userId: string): Promise<string> {
  return new SignJWT({ typ: 'google_pending_2fa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + PENDING_2FA_TTL_SECONDS)
    .sign(deriveKey(jwtSecret));
}

/** Devuelve el `userId` verificado por Google que este token pendiente representa. Lanza si es inválido, ajeno o expirado. */
export async function verifyPending2faToken(jwtSecret: string, token: string): Promise<string> {
  const { payload } = await jwtVerify(token, deriveKey(jwtSecret));
  if (payload.typ !== 'google_pending_2fa' || typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('token pendiente de verificación en dos pasos inválido');
  }
  return payload.sub;
}
