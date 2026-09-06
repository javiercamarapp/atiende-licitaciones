/* eslint-disable react-refresh/only-export-components -- exporta a propósito useAuth()/describeApiError() junto a AuthProvider (mismo patrón que components/ui/package-status-badge.tsx) */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ApiError,
  clearTokens,
  getMe,
  getTokens,
  listMyOrganizations,
  login as apiLogin,
  logout as apiLogout,
  readStoredOrgId,
  refreshSession,
  setTokens,
  writeStoredOrgId,
  type LoginPayload,
  type MyOrg,
  type UserPublic,
} from "@/lib/api";

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
        await refreshSession();
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

  const login = useCallback(async (payload: LoginPayload) => {
    const tokens = await apiLogin(payload);
    setTokens(tokens);
    try {
      const { user: hydratedUser, memberships: hydratedMemberships } = await hydrateUserAndMemberships();
      setUser(hydratedUser);
      setMemberships(hydratedMemberships);
      setCurrentOrgId(pickInitialOrgId(hydratedMemberships));
      setStatus("authenticated");
    } catch (err) {
      // Login fue exitoso pero /me o /organizations fallaron (p. ej. red
      // caída justo después): no se finge una sesión autenticada sin datos
      // reales de usuario/organizaciones.
      clearTokens();
      setStatus("unauthenticated");
      throw err;
    }
  }, []);

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
  }, []);

  const switchOrg = useCallback(
    (orgId: string) => {
      if (!memberships.some((m) => m.id === orgId)) return;
      setCurrentOrgId(orgId);
      writeStoredOrgId(orgId);
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
    () => ({ status, user, memberships, currentOrgId, currentMembership, login, logout, switchOrg, refreshMemberships }),
    [status, user, memberships, currentOrgId, currentMembership, login, logout, switchOrg, refreshMemberships],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}

/** Extrae un mensaje honesto de cualquier error de la capa API (incluye el request_id si la API lo trae). */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.requestId ? `${err.message} (request_id: ${err.requestId})` : err.message;
  }
  return err instanceof Error ? err.message : "Ocurrió un error inesperado.";
}
