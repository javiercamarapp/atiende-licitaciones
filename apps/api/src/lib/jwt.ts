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
}

export async function signAccessToken(secret: string, userId: string): Promise<string> {
  return new SignJWT({ typ: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(secret));
}

export async function signRefreshToken(secret: string, userId: string): Promise<string> {
  return new SignJWT({ typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key(secret));
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
  if (payload.typ !== 'refresh' || typeof payload.sub !== 'string') {
    throw new Error('Token no es de tipo refresh');
  }
  return payload as RefreshTokenPayload;
}
