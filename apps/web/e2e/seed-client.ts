// Cliente HTTP mínimo, independiente del código de producción, para
// crear el seed de la suite E2E "contra la API real" llamando a la propia
// apps/api (nunca insertando filas directo en la base de datos, y nunca
// datos ficticios embebidos en el frontend — ver global-setup.ts). Solo se
// usa desde infraestructura de pruebas (global-setup.ts).
import { generate as generateTotpCode } from "otplib";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export class SeedApiError extends Error {
  constructor(
    method: string,
    path: string,
    public status: number,
    body: unknown,
  ) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`);
  }
}

export function createSeedClient(apiUrl: string) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // Solo agrega `Content-Type: application/json` cuando de verdad hay un
    // cuerpo -- algunas rutas (p. ej. `POST /auth/2fa/enroll`, sin schema de
    // body) responden 400 real "Body cannot be empty when content-type is
    // set to 'application/json'" si el header llega sin cuerpo.
    const headers = init.body !== undefined ? { "Content-Type": "application/json", ...init.headers } : { ...init.headers };
    const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text();
      }
      throw new SeedApiError(init.method ?? "GET", path, response.status, body);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    async register(email: string, password: string): Promise<void> {
      await request("/auth/register", { method: "POST", body: JSON.stringify({ email, password }) });
    },
    async login(email: string, password: string): Promise<Tokens> {
      return request<Tokens>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    },
    async createOrganization(accessToken: string, name: string, slug: string): Promise<{ id: string; name: string; slug: string }> {
      return request("/organizations", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name, slug }),
      });
    },
    async inviteMember(accessToken: string, orgId: string, email: string, role: string): Promise<{ token: string }> {
      return request("/organizations/invitations", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "X-Org-Id": orgId },
        body: JSON.stringify({ email, role }),
      });
    },
    async acceptInvitation(accessToken: string, token: string): Promise<{ orgId: string; role: string }> {
      return request("/organizations/invitations/accept", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ token }),
      });
    },
    /**
     * Siembra UNA convocatoria real vía `POST /internal/tenders/ingest`
     * (la única ruta que puede crear `tenders`, ver
     * apps/api/README.md/apps/api/src/modules/tenders/internal-ingest.routes.ts)
     * -- nunca se inserta directo en la base de datos. Requiere
     * `PLATFORM_API_KEY` (ver e2e-full.mjs); usada por
     * e2e/expediente-flujo-completo.spec.ts para tener una convocatoria
     * real sobre la que ejercitar bases→matriz→propuesta→checklist→
     * revisión→paquete. `submissionDeadline` es obligatorio en la práctica:
     * sin él, `POST .../proposal/technical|economic/generate` responde 422
     * (AE-01, ver apps/api/src/lib/expediente/dates.ts).
     */
    async ingestTender(
      platformApiKey: string,
      organizationId: string,
      record: { title: string; submissionDeadline: string; publishedAt: string },
    ): Promise<{ tenderId: string }> {
      const response = await request<{ results: { tenderId: string }[] }>("/internal/tenders/ingest", {
        method: "POST",
        headers: { "X-Platform-Api-Key": platformApiKey },
        body: JSON.stringify({
          organizationIds: [organizationId],
          records: [
            {
              source: "e2e-seed",
              externalId: `e2e-tender-${Date.now()}`,
              title: record.title,
              sourceVersion: `v1-${Date.now()}`,
              submissionDeadline: record.submissionDeadline,
              publishedAt: record.publishedAt,
              currency: "MXN",
            },
          ],
        }),
      });
      return { tenderId: response.results[0].tenderId };
    },
    /**
     * REQ-044/064: enrola 2FA (TOTP) de `admin` de una sola vez, en
     * `global-setup.ts` -- corre en un ÚNICO proceso Node (a diferencia de
     * los tests, que Playwright puede reejecutar en un worker NUEVO al
     * reintentar, perdiendo cualquier estado en memoria). El secreto queda
     * en `seed.json`: los specs recalculan un código TOTP vigente en el
     * momento de cada step-up (nunca reutilizan uno viejo, así que ni el
     * rechazo de replay de apps/api ni un reintento de Playwright rompen
     * el flujo).
     *
     * `enrolledAtMs` (instante justo antes de generar el código de
     * `verify-enrollment`) queda en `seed.json` para que
     * `e2e/two-factor-helpers.ts` pueda evitar el "time step" (ventana TOTP
     * de 30s) que este código YA consumió del lado del servidor -- apps/api
     * rechaza SIEMPRE un código de un time step <= al último aceptado
     * (protección de replay, ver `apps/api/src/lib/step-up.ts`), así que un
     * primer step-up real demasiado pronto tras el enrolamiento (dentro de
     * la MISMA ventana de 30s) recibiría un 403 real aunque el código sea
     * "fresco" desde la perspectiva del cliente.
     */
    async enrollTwoFactor(accessToken: string): Promise<{ secretBase32: string; backupCodes: string[]; enrolledAtMs: number }> {
      const enrollment = await request<{ secretBase32: string; otpauthUrl: string; backupCodes: string[] }>("/auth/2fa/enroll", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const enrolledAtMs = Date.now();
      const code = await generateTotpCode({ secret: enrollment.secretBase32 });
      await request("/auth/2fa/verify-enrollment", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ code }),
      });
      return { secretBase32: enrollment.secretBase32, backupCodes: enrollment.backupCodes, enrolledAtMs };
    },
    async waitForHealthz(timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${apiUrl}/healthz`);
          if (res.ok) return;
        } catch (err) {
          lastError = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`apps/api no respondió en ${apiUrl}/healthz dentro de ${timeoutMs}ms: ${String(lastError)}`);
    },
  };
}
