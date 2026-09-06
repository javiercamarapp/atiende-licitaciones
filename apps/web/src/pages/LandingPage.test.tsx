import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

import { renderWithProviders } from "@/test/utils";
import { setTokens } from "@/lib/api/session";
import { server, http, HttpResponse } from "@/test/msw";
import LandingPage from "@/pages/LandingPage";

describe("LandingPage", () => {
  it("muestra el hero, cómo funciona, seguridad, casos, planes y FAQ", async () => {
    renderWithProviders(<LandingPage />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(/licitación/i);
    expect(screen.getByRole("heading", { name: "Cómo funciona" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Seguridad y reglas de no actuación" })).toBeInTheDocument();
    expect(screen.getByText(/Nunca envía ni presenta una propuesta/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Casos por perfil de empresa" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Planes" })).toBeInTheDocument();
    expect(screen.getAllByText("Próximamente").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Preguntas frecuentes" })).toBeInTheDocument();
  });

  /**
   * REQ-196 (ronda 8b): el formulario de contacto ya NO está deshabilitado
   * — `POST /public/contact` existe de verdad en apps/api. Se comprueba el
   * cuerpo exacto, incluido el honeypot vacío que el servidor espera.
   */
  it("REQ-196: envía el contacto real a POST /public/contact con el honeypot vacío", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("*/public/contact", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true }, { status: 202 });
      }),
    );

    renderWithProviders(<LandingPage />);
    await user.type(await screen.findByLabelText("Nombre"), "Ana Pérez");
    await user.type(screen.getByLabelText("Correo de trabajo"), "ana@constructora.mx");
    await user.type(screen.getByLabelText("Empresa (opcional)"), "Constructora Ana");
    await user.type(screen.getByLabelText(/convocatorias te interesan/), "Obra pública federal en Jalisco.");
    await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

    expect(await screen.findByText("Recibimos tu mensaje.")).toBeInTheDocument();
    expect(bodies).toEqual([
      {
        name: "Ana Pérez",
        email: "ana@constructora.mx",
        message: "Obra pública federal en Jalisco.",
        company: "Constructora Ana",
        website: "",
      },
    ]);
  }, 15000);

  /**
   * El honeypot tiene que EXISTIR en el DOM real (un campo oculto que solo
   * un bot rellena). Si desapareciera, la capa 2 del anti-abuso de apps/api
   * dejaría de funcionar sin que nada fallara a gritos.
   */
  it("REQ-196: el honeypot `website` existe en el DOM, fuera del alcance de una persona", async () => {
    renderWithProviders(<LandingPage />);
    const honeypot = (await screen.findByLabelText("No llenes este campo")) as HTMLInputElement;

    expect(honeypot).toHaveAttribute("name", "website");
    expect(honeypot).toHaveAttribute("tabindex", "-1");
    expect(honeypot).toHaveValue("");
    expect(honeypot.closest("[aria-hidden='true']")).not.toBeNull();
  }, 15000);

  it("REQ-196: valida las longitudes REALES del esquema del servidor antes de gastar una petición", async () => {
    const user = userEvent.setup();
    let llamadas = 0;
    server.use(
      http.post("*/public/contact", () => {
        llamadas += 1;
        return HttpResponse.json({ ok: true }, { status: 202 });
      }),
    );

    renderWithProviders(<LandingPage />);
    await user.type(await screen.findByLabelText("Nombre"), "A");
    await user.type(screen.getByLabelText("Correo de trabajo"), "no-es-un-correo");
    await user.type(screen.getByLabelText(/convocatorias te interesan/), "corto");
    await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

    expect(await screen.findByText("Escribe tu nombre.")).toBeInTheDocument();
    expect(screen.getByText("Escribe un correo válido.")).toBeInTheDocument();
    expect(screen.getByText(/Cuéntanos un poco más/)).toBeInTheDocument();
    expect(llamadas).toBe(0);
  }, 15000);

  /**
   * ADVERSARIAL (429). El límite del tier `auth` (5/min por IP) es lo que
   * impide usar este endpoint anónimo —que MANDA CORREO— como cañón de
   * spam, así que el cliente no lo reintenta por su cuenta y la pantalla
   * no dice "recibimos tu mensaje" cuando el servidor lo rechazó.
   */
  it("REQ-196 adversarial: un 429 se muestra claro, sin reintentar ni fingir que se recibió", async () => {
    const user = userEvent.setup();
    let intentos = 0;
    server.use(
      http.post("*/public/contact", () => {
        intentos += 1;
        return HttpResponse.json({ title: "Rate limit exceeded, retry in 1 minute", status: 429 }, { status: 429 });
      }),
    );

    renderWithProviders(<LandingPage />);
    await user.type(await screen.findByLabelText("Nombre"), "Ana Pérez");
    await user.type(screen.getByLabelText("Correo de trabajo"), "ana@constructora.mx");
    await user.type(screen.getByLabelText(/convocatorias te interesan/), "Obra pública federal en Jalisco.");
    await user.click(screen.getByRole("button", { name: "Enviar solicitud" }));

    expect(await screen.findByText(/Demasiados intentos desde esta conexión/)).toBeInTheDocument();
    expect(intentos).toBe(1);
    expect(screen.queryByText("Recibimos tu mensaje.")).not.toBeInTheDocument();
  }, 15000);

  it("enlaza a la demo, al login y a las páginas legales", async () => {
    renderWithProviders(<LandingPage />);
    expect((await screen.findAllByRole("link", { name: /Ver demo sin cuenta/ }))[0]).toHaveAttribute("href", "/demo");
    expect(screen.getAllByRole("link", { name: "Iniciar sesión" })[0]).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Aviso de privacidad" })).toHaveAttribute("href", "/privacidad");
    expect(screen.getByRole("link", { name: "Términos de servicio" })).toHaveAttribute("href", "/legal/terminos");
  });

  it("deja de mostrar la landing en cuanto hay una sesión activa (redirige a /panel)", async () => {
    setTokens({ accessToken: null, refreshToken: "ref-1" });
    server.use(
      http.post("*/auth/refresh", () => HttpResponse.json({ accessToken: "acc-1", refreshToken: "ref-1" })),
      http.get("*/me", () => HttpResponse.json({ id: "user-1", email: "admin@empresa.com", fullName: "Admin" })),
      http.get("*/organizations", () => HttpResponse.json([{ id: "org-a", name: "Organización A", slug: "org-a", role: "owner" }])),
    );

    renderWithProviders(<LandingPage />);

    // Mientras la sesión se resuelve ("loading"), LandingPage sigue
    // mostrando la landing normal (no hay nada más que mostrar todavía);
    // en cuanto AuthProvider resuelve "authenticated", <Navigate/> desmonta
    // todo el contenido de la landing (no hay ninguna <Route path="/panel">
    // en este árbol de prueba -- solo se verifica que deja de renderizarse).
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument());
  });

  it("no tiene violaciones de accesibilidad detectables por axe", async () => {
    renderWithProviders(<LandingPage />);
    await screen.findByRole("main");
    const results = await axe(document.body);
    expect(results).toHaveNoViolations();
  }, 15000);
});
