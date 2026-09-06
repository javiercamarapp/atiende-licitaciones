/**
 * REQ-206/docs/ACEPTACION.md (S1-S3): proveedor OIDC FALSO para pruebas de
 * integración del login con Google (`modules/auth/google/**`) -- un
 * servidor HTTP local real (no un mock de `fetch`) que implementa
 * discovery, JWKS, y el `token_endpoint` con la misma forma que un
 * proveedor OIDC real, firmando `id_token`s con una clave RSA de prueba
 * generada en memoria. NUNCA toca la red real ni credenciales de Google.
 *
 * Uso típico de un test:
 *   const provider = await startFakeOidcProvider();
 *   // ... configurar process.env.OIDC_ISSUER_URL = provider.issuerUrl,
 *   //     GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI de prueba, construir la app ...
 *   const start = await app.inject({ method: 'GET', url: '/auth/google/start' });
 *   const { state, nonce, codeChallenge } = parseAuthorizationUrl(start.json().authorizationUrl);
 *   const code = provider.issueAuthorizationCode({ sub: 'g-1', email: 'x@y.com', emailVerified: true, aud: GOOGLE_CLIENT_ID, nonce, codeChallenge });
 *   const callback = await app.inject({ method: 'GET', url: `/auth/google/callback?code=${code}&state=${state}` });
 *   await provider.close();
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface FakeOidcClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** `aud` del id_token emitido -- por defecto, el `client_id` que la propia request de token declaró. Pásalo explícito para simular un token "de otro cliente" (aud ajeno). */
  aud?: string;
  nonce: string;
  /** Si viene, el token endpoint verifica PKCE S256 real contra el `code_verifier` recibido -- mismatch responde `invalid_grant`. */
  codeChallenge?: string;
  /** Vida del id_token en segundos (default 300). Un valor negativo produce un token YA EXPIRADO, útil para pruebas adversariales. */
  expiresInSeconds?: number;
}

export interface FakeOidcProvider {
  issuerUrl: string;
  jwksUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Emite un `code` de un solo uso ligado a estos claims (consumido por el próximo POST al token_endpoint con ese `code`). */
  issueAuthorizationCode(claims: FakeOidcClaims): string;
  close(): Promise<void>;
}

interface PendingCode {
  claims: FakeOidcClaims;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeOidcProvider(): Promise<FakeOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = 'fake-oidc-test-key-1';
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };

  const pendingCodes = new Map<string, PendingCode>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'server_error', error_description: String(err) }));
    });
  });

  async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: issuerUrl(),
          authorization_endpoint: `${issuerUrl()}/authorize`,
          token_endpoint: `${issuerUrl()}/token`,
          jwks_uri: `${issuerUrl()}/jwks`,
        })
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/authorize') {
      // Formalidad: en las pruebas de este ronda nunca se sigue esta
      // redirección real (los tests llaman `issueAuthorizationCode`
      // directamente y golpean `/auth/google/callback` con el `code`
      // resultante) -- se documenta aquí solo por completitud del doble.
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('fake-oidc-provider: usa issueAuthorizationCode() en vez de seguir esta redirección en pruebas.');
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const rawBody = await readBody(req);
      const params = new URLSearchParams(rawBody);
      const code = params.get('code');
      const codeVerifier = params.get('code_verifier') ?? '';
      const pending = code ? pendingCodes.get(code) : undefined;
      if (!code || !pending) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code desconocido o ya utilizado' }));
        return;
      }
      // Un solo uso -- mismo criterio anti-replay que un IdP real.
      pendingCodes.delete(code);

      if (pending.claims.codeChallenge) {
        const computed = base64url(createHash('sha256').update(codeVerifier).digest());
        if (computed !== pending.claims.codeChallenge) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'code_verifier no coincide con code_challenge (PKCE)' }));
          return;
        }
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiresInSeconds = pending.claims.expiresInSeconds ?? 300;
      const idToken = await new SignJWT({
        email: pending.claims.email,
        email_verified: pending.claims.emailVerified,
        nonce: pending.claims.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setSubject(pending.claims.sub)
        .setIssuer(issuerUrl())
        .setAudience(pending.claims.aud ?? (params.get('client_id') as string))
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + expiresInSeconds)
        .sign(privateKey);

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: `fake-access-token-${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: idToken,
        })
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  function issuerUrl(): string {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fake-oidc: servidor sin puerto asignado');
    return `http://127.0.0.1:${address.port}`;
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = issuerUrl();

  return {
    issuerUrl: base,
    jwksUri: `${base}/jwks`,
    authorizationEndpoint: `${base}/authorize`,
    tokenEndpoint: `${base}/token`,
    issueAuthorizationCode(claims: FakeOidcClaims): string {
      const code = `fake-code-${randomBytes(16).toString('hex')}`;
      pendingCodes.set(code, { claims });
      return code;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

/** Extrae `state`/`nonce`/`code_challenge` de la `authorizationUrl` devuelta por `GET /auth/google/start` -- evita que cada test reimplemente el parseo de query params. */
export function parseAuthorizationUrl(authorizationUrl: string): { state: string; nonce: string; codeChallenge: string; clientId: string; redirectUri: string } {
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  const codeChallenge = url.searchParams.get('code_challenge');
  const clientId = url.searchParams.get('client_id');
  const redirectUri = url.searchParams.get('redirect_uri');
  if (!state || !nonce || !codeChallenge || !clientId || !redirectUri) {
    throw new Error(`authorizationUrl incompleta: ${authorizationUrl}`);
  }
  return { state, nonce, codeChallenge, clientId, redirectUri };
}
