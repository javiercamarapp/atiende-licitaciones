// Almacén de la sesión (tokens) fuera de React, para que `client.ts` pueda
// leer/escribir el access token sin depender del árbol de componentes (p.
// ej. durante el reintento tras 401) y para que `AuthProvider` pueda
// suscribirse a los cambios y re-renderizar.
//
// RIESGO DOCUMENTADO (ver README): apps/api emite el refresh token en el
// CUERPO de la respuesta de /auth/login y /auth/refresh (`authTokensSchema`
// en apps/api/src/modules/auth/schemas.ts), no como cookie httpOnly. Un
// backend que expusiera el refresh token solo por cookie httpOnly evitaría
// que JavaScript (y por tanto un XSS) pudiera leerlo; como esta API no
// ofrece esa opción, el cliente no tiene alternativa a guardarlo en un
// almacén accesible desde JS. Se elige `localStorage` (sobrevive a recargar
// la pestaña, evita forzar un login en cada F5) en vez de mantenerlo solo en
// memoria — la mitigación real (cookies httpOnly + rotación en el servidor)
// requeriría un cambio de contrato en apps/api, fuera del alcance de
// apps/web. El access token de vida corta SÍ vive solo en memoria (nunca en
// localStorage), para minimizar la ventana de exposición.
export interface Tokens {
  accessToken: string | null;
  refreshToken: string | null;
}

const REFRESH_TOKEN_KEY = "atiende.refreshToken";

function readStoredRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    // Modo privado / almacenamiento bloqueado: la sesión simplemente no
    // persiste entre recargas, no falla de forma ruidosa.
    return null;
  }
}

let tokens: Tokens = { accessToken: null, refreshToken: readStoredRefreshToken() };
const listeners = new Set<() => void>();

export function getTokens(): Tokens {
  return tokens;
}

export function setTokens(next: Tokens): void {
  tokens = next;
  try {
    if (next.refreshToken) {
      localStorage.setItem(REFRESH_TOKEN_KEY, next.refreshToken);
    } else {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
  } catch {
    // Igual que arriba: si el almacenamiento no está disponible, la sesión
    // no persiste, pero la app sigue funcionando dentro de esta pestaña.
  }
  for (const listener of listeners) listener();
}

export function clearTokens(): void {
  setTokens({ accessToken: null, refreshToken: null });
}

export function subscribeTokens(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- Organización actual (X-Org-Id) ---------------------------------------
// Persistir la última organización usada es una conveniencia de UX (evitar
// que el usuario tenga que reseleccionarla en cada carga), no un dato de
// seguridad: el servidor siempre revalida la membresía real en
// `app.requireOrg` (ver apps/api/src/plugins/auth.plugin.ts) sin importar lo
// que diga este valor local.
const CURRENT_ORG_KEY = "atiende.currentOrgId";

export function readStoredOrgId(): string | null {
  try {
    return localStorage.getItem(CURRENT_ORG_KEY);
  } catch {
    return null;
  }
}

export function writeStoredOrgId(orgId: string | null): void {
  try {
    if (orgId) localStorage.setItem(CURRENT_ORG_KEY, orgId);
    else localStorage.removeItem(CURRENT_ORG_KEY);
  } catch {
    // Sin persistencia disponible: el selector de organización simplemente
    // vuelve a pedir selección en la próxima carga.
  }
}
