/* eslint-disable react-refresh/only-export-components -- exporta a propósito useAuth()/describeApiError() junto a AuthProvider (mismo patrón que components/ui/package-status-badge.tsx) */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ApiError,
  clearTokens,
  getMe,
  getTokens,
  isRateLimited,
  listMyOrganizations,
  login as apiLogin,
  logout as apiLogout,
  readStoredOrgId,
  refreshSessionOnce,
  setTokens,
  writeStoredOrgId,
  type AuthTokens,
  type LoginPayload,
  type MyOrg,
  type UserPublic,
} from "@/lib/api";
import { clearUnscopedQueries, queryClient } from "@/lib/queryClient";

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthContextValue {
  status: AuthStatus;
  user: UserPublic | null;
  memberships: MyOrg[];
  /** Organización activa (X-Org-Id). `null` mientras no hay ninguna seleccionable. */
  currentOrgId: string | null;
  /** Membresía (rol incluido) de la organización activa, si existe. */
  currentMembership: MyOrg | null;
  login: (payload: LoginPayload) => Promise<void>;
  /**
   * Ronda 8 (REQ-172..176): completa la sesión a partir de un par de tokens
   * YA emitidos por `apps/api` fuera del flujo de contraseña — hoy solo
   * `GoogleCallbackPage`/`GoogleTwoFactorPage` lo usan (`status: "ok"` |
   * `"sin_acceso"` de `GET /auth/google/callback` o `POST
   * /auth/google/verify-2fa`, REQ-175: mismo esquema de tokens que
   * `POST /auth/login`). Comparte toda la hidratación de usuario/
   * membresías con `login()` — la única diferencia es que aquí los tokens
   * ya existen, no hay que pedirlos con `apiLogin`.
   */
  loginWithTokens: (tokens: AuthTokens) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (orgId: string) => void;
  refreshMemberships: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function hydrateUserAndMemberships(): Promise<{ user: UserPublic; memberships: MyOrg[] }> {
  const [user, memberships] = await Promise.all([getMe(), listMyOrganizations()]);
  return { user, memberships };
}

function pickInitialOrgId(memberships: MyOrg[]): string | null {
  const stored = readStoredOrgId();
  if (stored && memberships.some((m) => m.id === stored)) return stored;
  return memberships[0]?.id ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<UserPublic | null>(null);
  const [memberships, setMemberships] = useState<MyOrg[]>([]);
  const [currentOrgId, setCurrentOrgId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      const { refreshToken } = getTokens();
      if (!refreshToken) {
        setStatus("unauthenticated");
        return;
      }
      try {
        // RF-02 (docs/auditoria-2/ronda5-final.md): `refreshSessionOnce()`
        // comparte el MISMO mutex que el reintento automático tras un 401
        // de `apiRequest` -- si ambos disparan casi al mismo tiempo, este
        // espera la promesa YA en curso en vez de pedir su propio refresh
        // con el mismo refresh token de un solo uso (ver docstring en
        // lib/api/client.ts).
        await refreshSessionOnce();
        const { user: hydratedUser, memberships: hydratedMemberships } = await hydrateUserAndMemberships();
        if (cancelled) return;
        setUser(hydratedUser);
        setMemberships(hydratedMemberships);
        setCurrentOrgId(pickInitialOrgId(hydratedMemberships));
        setStatus("authenticated");
      } catch {
        if (cancelled) return;
        clearTokens();
        setStatus("unauthenticated");
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Núcleo compartido de `login()`/`loginWithTokens()`: persiste el par de
   * tokens y solo entonces hidrata usuario/membresías reales — nunca se
   * finge una sesión autenticada sin esos datos (si `/me`/`GET
   * /organizations` fallan justo después, se revierte a sin sesión en vez
   * de dejar un estado a medias).
   */
  const completeSession = useCallback(async (tokens: AuthTokens) => {
    setTokens(tokens);
    try {
      const { user: hydratedUser, memberships: hydratedMemberships } = await hydrateUserAndMemberships();
      setUser(hydratedUser);
      setMemberships(hydratedMemberships);
      setCurrentOrgId(pickInitialOrgId(hydratedMemberships));
      setStatus("authenticated");
    } catch (err) {
      clearTokens();
      setStatus("unauthenticated");
      throw err;
    }
  }, []);

  const login = useCallback(
    async (payload: LoginPayload) => {
      const tokens = await apiLogin(payload);
      await completeSession(tokens);
    },
    [completeSession],
  );

  const loginWithTokens = useCallback(
    async (tokens: AuthTokens) => {
      await completeSession(tokens);
    },
    [completeSession],
  );

  const logout = useCallback(async () => {
    const { refreshToken } = getTokens();
    if (refreshToken) {
      try {
        await apiLogout(refreshToken);
      } catch {
        // Logout es best-effort del lado del cliente: si la red falla, la
        // sesión local se limpia igual (el refresh token seguirá siendo
        // válido en el servidor hasta que expire, pero deja de usarse aquí).
      }
    }
    clearTokens();
    writeStoredOrgId(null);
    setUser(null);
    setMemberships([]);
    setCurrentOrgId(null);
    setStatus("unauthenticated");
    // WI-03 (docs/auditoria-2/web-integrado.md): sin esto, las queries
    // admin/globales (sin `currentOrgId` en su `queryKey`) sobrevivían en
    // caché tras un logout real — en un navegador compartido, la siguiente
    // sesión (aunque sea de otro usuario) podía pintar por un instante
    // datos de la sesión anterior antes del refetch en segundo plano. Un
    // logout limpia TODO el caché de react-query, no solo lo admin/global:
    // ningún dato de la sesión que termina debe sobrevivir a la siguiente.
    queryClient.clear();
  }, []);

  const switchOrg = useCallback(
    (orgId: string) => {
      if (!memberships.some((m) => m.id === orgId)) return;
      setCurrentOrgId(orgId);
      writeStoredOrgId(orgId);
      // WI-03: las queries de negocio (empresa/convocatorias/matching/...)
      // ya incluyen `currentOrgId` en su clave, así que un cambio de
      // organización no las filtra entre sí. Pero las admin/globales no
      // tienen ninguna clave por organización — se eliminan explícitamente
      // para que un cambio de organización nunca pinte, ni brevemente, un
      // dato que en realidad pertenece a la vista admin de otra sesión.
      clearUnscopedQueries();
    },
    [memberships],
  );

  const refreshMemberships = useCallback(async () => {
    const hydratedMemberships = await listMyOrganizations();
    setMemberships(hydratedMemberships);
    setCurrentOrgId((current) => (current && hydratedMemberships.some((m) => m.id === current) ? current : pickInitialOrgId(hydratedMemberships)));
  }, []);

  const currentMembership = useMemo(
    () => memberships.find((m) => m.id === currentOrgId) ?? null,
    [memberships, currentOrgId],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, memberships, currentOrgId, currentMembership, login, loginWithTokens, logout, switchOrg, refreshMemberships }),
    [status, user, memberships, currentOrgId, currentMembership, login, loginWithTokens, logout, switchOrg, refreshMemberships],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}

/**
 * Ronda 8b: mensaje propio para el 429. El límite de tasa lo aplica
 * `@fastify/rate-limit` en apps/api, NUNCA un `AppError` con texto
 * cuidado, así que el `title` que llega es el literal en inglés del plugin
 * ("Rate limit exceeded, retry in 1 minute") — mostrarlo tal cual sería
 * enseñarle al usuario el mensaje interno de una dependencia. Se traduce
 * aquí, en el único lugar por el que pasan todos los errores de API que la
 * UI pinta.
 */
export const RATE_LIMIT_MESSAGE =
  "Demasiados intentos desde esta conexión. Espera un minuto e inténtalo de nuevo: estas rutas están limitadas a 5 peticiones por minuto para que nadie las use para mandar correo en volumen.";

/** Extrae un mensaje honesto de cualquier error de la capa API (incluye el request_id si la API lo trae). */
export function describeApiError(err: unknown): string {
  if (isRateLimited(err)) return RATE_LIMIT_MESSAGE;
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message} (request_id: ${err.requestId})` : err.message;
  }
  return err instanceof Error ? err.message : "Ocurrió un error inesperado.";
}
