/**
 * REQ-172: intercambio del `code` de autorización por tokens en el
 * `token_endpoint` del proveedor (Authorization Code + PKCE, RFC 6749/7636)
 * -- petición HTTP directa (sin SDK de Google), igual de sencilla para el
 * proveedor OIDC falso de pruebas que para Google real.
 */
export interface ExchangeAuthorizationCodeParams {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}

export interface TokenExchangeResult {
  idToken: string;
}

export async function exchangeAuthorizationCode(params: ExchangeAuthorizationCodeParams): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const res = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Intercambio de código con el proveedor OIDC falló (status ${res.status})`);
  }
  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
    throw new Error('Respuesta del token endpoint sin id_token');
  }
  return { idToken: json.id_token };
}
