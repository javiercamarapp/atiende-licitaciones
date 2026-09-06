// Handlers MSW reutilizables para el flujo de login con Google
// (REQ-172..180) — usados por GoogleAuthButton.test.tsx,
// GoogleCallbackPage.test.tsx y cualquier prueba futura que necesite
// simular `apps/api` real sin levantar un backend (ver `src/test/msw.ts`,
// "MSW solo en tests").
import { http, HttpResponse } from "@/test/msw";

interface ProblemJsonInput {
  status: number;
  title: string;
  type?: string;
  requestId?: string;
}

/** `application/problem+json` real (RFC 7807), mismo formato que `apps/api/src/plugins/error-handler.ts`. */
export function problemJson({ status, title, type, requestId }: ProblemJsonInput) {
  return HttpResponse.json(
    { type: type ?? `https://atiende.example/errors/http-${status}`, title, status, requestId },
    { status },
  );
}

export function mockGoogleStart(response: { authorizationUrl: string } | { status: number; title: string }) {
  return http.get("*/auth/google/start", () => {
    if ("authorizationUrl" in response) return HttpResponse.json(response);
    return problemJson(response);
  });
}

export function mockGoogleCallback(
  response:
    | { status: "ok" | "sin_acceso"; accessToken?: string; refreshToken?: string }
    | { status: "requires_2fa"; pendingToken: string }
    | { httpStatus: number; title: string; requestId?: string },
) {
  return http.get("*/auth/google/callback", () => {
    if ("httpStatus" in response) return problemJson({ status: response.httpStatus, title: response.title, requestId: response.requestId });
    if (response.status === "requires_2fa") return HttpResponse.json({ status: "requires_2fa", pendingToken: response.pendingToken });
    return HttpResponse.json({
      status: response.status,
      accessToken: response.accessToken ?? "google-access-token",
      refreshToken: response.refreshToken ?? "google-refresh-token",
    });
  });
}

export function mockGoogleVerify2fa(
  response: { status: "ok" | "sin_acceso"; accessToken?: string; refreshToken?: string } | { httpStatus: number; title: string },
) {
  return http.post("*/auth/google/verify-2fa", () => {
    if ("httpStatus" in response) return problemJson({ status: response.httpStatus, title: response.title });
    return HttpResponse.json({
      status: response.status,
      accessToken: response.accessToken ?? "google-2fa-access-token",
      refreshToken: response.refreshToken ?? "google-2fa-refresh-token",
    });
  });
}

/** `loginWithTokens()`/`login()` hidratan `/me` + `GET /organizations` justo después — sin estos, cualquier login (por Google o contraseña) revierte a "unauthenticated" en el `catch` de `completeSession`. */
export function mockSessionHydration(options?: { memberships?: Array<{ id: string; name: string; slug: string; role: string }> }) {
  return [
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "persona@empresa.com", fullName: null })),
    http.get("*/organizations", () => HttpResponse.json(options?.memberships ?? [])),
  ];
}
