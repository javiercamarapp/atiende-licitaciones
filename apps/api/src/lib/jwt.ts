import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const encoder = new TextEncoder();

function key(secret: string) {
  return encoder.encode(secret);
}

export interface AccessTokenPayload extends JWTPayload {
  typ: 'access';
  sub: string;
}

export interface RefreshTokenPayload extends JWTPayload {
  typ: 'refresh';
  sub: string;
  /** Identificador único de esta emisión, para poder revocar tokens individuales (ver refresh_tokens en packages/db). */
  jti: string;
}

export async function signAccessToken(secret: string, userId: string): Promise<string> {
  return new SignJWT({ typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(secret));
}

export async function signRefreshToken(
  secret: string,
  userId: string,
  jti: string = randomUUID()
): Promise<{ token: string; jti: string }> {
  const token = await new SignJWT({ typ: 'refresh', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key(secret));
  return { token, jti };
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, key(secret));
  if (payload.typ !== 'access' || typeof payload.sub !== 'string') {
    throw new Error('Token no es de tipo access');
  }
  return payload as AccessTokenPayload;
}

export async function verifyRefreshToken(secret: string, token: string): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, key(secret));
  if (payload.typ !== 'refresh' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
    throw new Error('Token no es de tipo refresh');
  }
  return payload as RefreshTokenPayload;
}
