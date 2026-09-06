import { rawRequest } from "./http";
import { apiRequest } from "./client";
import { authTokensSchema, userPublicSchema, type AuthTokens } from "./schemas";

export interface LoginPayload {
  email: string;
  password: string;
}

export async function login(payload: LoginPayload): Promise<AuthTokens> {
  const raw = await rawRequest<unknown>("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return authTokensSchema.parse(raw);
}

export interface RegisterPayload {
  email: string;
  password: string;
  fullName?: string;
}

export async function register(payload: RegisterPayload): Promise<{ id: string; email: string }> {
  return rawRequest("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function logout(refreshToken: string): Promise<void> {
  await rawRequest<void>("/auth/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
}

export async function getMe() {
  const raw = await apiRequest<unknown>("/me");
  return userPublicSchema.parse(raw);
}
