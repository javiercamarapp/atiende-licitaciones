/**
 * REQ-172: descubre los endpoints reales del proveedor OIDC (Google, o el
 * proveedor OIDC falso de pruebas -- ver `env.ts`) vía el documento de
 * discovery estándar, en vez de hardcodear las URLs de Google en el
 * código. Cacheado en memoria de proceso por `issuerUrl` con un TTL corto
 * (los endpoints de un proveedor OIDC real casi nunca cambian, pero un TTL
 * evita servir un documento obsoleto indefinidamente si algún día
 * cambian) -- nunca colisiona entre tests: cada proveedor OIDC falso de
 * pruebas nace en un puerto efímero distinto, así que su `issuerUrl` (y
 * por tanto la clave de caché) es único por instancia.
 */
export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface CacheEntry {
  value: OidcDiscoveryDocument;
  expiresAt: number;
}

const DISCOVERY_CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

export async function fetchDiscoveryDocument(issuerUrl: string): Promise<OidcDiscoveryDocument> {
  const cached = cache.get(issuerUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const res = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
  if (!res.ok) {
    throw new Error(`No se pudo obtener el discovery document OIDC de ${issuerUrl} (status ${res.status})`);
  }
  const doc = (await res.json()) as Partial<OidcDiscoveryDocument>;
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error(`Discovery document OIDC de ${issuerUrl} incompleto o inválido`);
  }
  const value: OidcDiscoveryDocument = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
  };
  cache.set(issuerUrl, { value, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS });
  return value;
}
