import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { server, http, HttpResponse } from "@/test/msw";
import { setTokens } from "@/lib/api/session";
import AceptarInvitacionPage from "@/pages/auth/AceptarInvitacionPage";

const ENLACE = "/invitaciones/aceptar?d=payload-firmado&s=firma-hmac";

/** Sesión real de prueba: el mismo camino que hace `AuthProvider` al arrancar. */
function mockSesionActiva() {
  setTokens({ accessToken: null, refreshToken: "ref-1" });
  server.use(
    http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
    http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "ana@empresa.com", fullName: "Ana" })),
    http.get("*/organizations", () => HttpResponse.json([])),
  );
}

function renderConRutas(ruta: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/invitaciones/aceptar" element={<AceptarInvitacionPage />} />
      <Route path="/login" element={<p>pantalla de acceso</p>} />
      <Route path="/registro" element={<p>pantalla de registro</p>} />
      <Route path="/panel" element={<p>panel real</p>} />
    </Routes>,
    { route: ruta },
  );
}

describe("AceptarInvitacionPage (REQ-186)", () => {
  it("con sesión activa acepta la invitación mandando d/s tal cual", async () => {
    mockSesionActiva();
    const bodies: unknown[] = [];
    server.use(
      http.post("*/organizations/invitations/accept", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ orgId: "org-a", role: "writer" });
      }),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "Ya eres parte de la organización" })).toBeInTheDocument();
    expect(screen.getByText(/Tu rol es "writer"/)).toBeInTheDocument();
    expect(bodies).toEqual([{ d: "payload-firmado", s: "firma-hmac" }]);
  });

  /**
   * Sin este refresco, `RequireOrganization` (que mira `memberships`)
   * rebotaría a /sin-acceso al recién invitado justo después de aceptar.
   */
  it("recarga las membresías tras aceptar, para que el panel ya sea alcanzable", async () => {
    mockSesionActiva();
    let vecesOrganizaciones = 0;
    server.use(
      http.get("*/organizations", () => {
        vecesOrganizaciones += 1;
        return HttpResponse.json(vecesOrganizaciones === 1 ? [] : [{ id: "org-a", name: "Org A", slug: "org-a", role: "writer" }]);
      }),
      http.post("*/organizations/invitations/accept", () => HttpResponse.json({ orgId: "org-a", role: "writer" })),
    );

    renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "Ya eres parte de la organización" });

    expect(vecesOrganizaciones).toBeGreaterThanOrEqual(2);
  });

  /**
   * ADVERSARIAL: aceptar EXIGE sesión (la API valida que el correo de la
   * sesión coincida con el de la invitación). Sin sesión, la pantalla no
   * intenta la llamada ni pierde el enlace: manda a /login o /registro con
   * la ubicación COMPLETA en `state.from`.
   */
  it("sin sesión no llama a la API y ofrece entrar o crear cuenta conservando el enlace", async () => {
    let llamadas = 0;
    server.use(
      http.post("*/organizations/invitations/accept", () => {
        llamadas += 1;
        return HttpResponse.json({ orgId: "org-a", role: "writer" });
      }),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "Entra o crea tu cuenta para aceptarla" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ya tengo cuenta: iniciar sesión" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Crear mi cuenta" })).toHaveAttribute("href", "/registro");
    expect(llamadas).toBe(0);
  });

  it("con el enlace incompleto no llama a la API", async () => {
    mockSesionActiva();
    let llamadas = 0;
    server.use(
      http.post("*/organizations/invitations/accept", () => {
        llamadas += 1;
        return HttpResponse.json({ orgId: "org-a", role: "writer" });
      }),
    );

    renderConRutas("/invitaciones/aceptar?d=solo-el-payload");

    expect(await screen.findByRole("heading", { level: 1, name: "Este enlace llegó incompleto" })).toBeInTheDocument();
    expect(llamadas).toBe(0);
  });

  /**
   * ADVERSARIAL: invitación emitida para OTRO correo (401 real de la API).
   * El mensaje del servidor se muestra tal cual — nunca se traduce a "algo
   * salió mal" que ocultaría la causa real.
   */
  it("muestra el 401 real cuando la invitación era para otro correo", async () => {
    mockSesionActiva();
    server.use(
      http.post("*/organizations/invitations/accept", () =>
        HttpResponse.json(
          { title: "Esta invitación fue emitida para otro correo electrónico", status: 401, requestId: "req-401" },
          { status: 401 },
        ),
      ),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByRole("heading", { level: 1, name: "No se pudo aceptar la invitación" })).toBeInTheDocument();
    expect(screen.getByText(/Esta invitación fue emitida para otro correo electrónico/)).toBeInTheDocument();
  });

  it("muestra el 409 real cuando la invitación ya se aceptó o expiró", async () => {
    mockSesionActiva();
    server.use(
      http.post("*/organizations/invitations/accept", () =>
        HttpResponse.json({ title: "La invitación ya fue aceptada o revocada", status: 409, requestId: "req-409" }, { status: 409 }),
      ),
    );

    renderConRutas(ENLACE);

    expect(await screen.findByText(/La invitación ya fue aceptada o revocada/)).toBeInTheDocument();
    expect(screen.getByText(/request_id: req-409/)).toBeInTheDocument();
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    mockSesionActiva();
    server.use(http.post("*/organizations/invitations/accept", () => HttpResponse.json({ orgId: "org-a", role: "writer" })));
    renderConRutas(ENLACE);
    await screen.findByRole("heading", { level: 1, name: "Ya eres parte de la organización" });
    expect(await axe(document.body)).toHaveNoViolations();
  }, 15000);
});
