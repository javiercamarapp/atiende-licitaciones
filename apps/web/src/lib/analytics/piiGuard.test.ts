import { describe, expect, it } from "vitest";

import { assertNoPii, checkForPii, guardAnalyticsSink, PiiDetectedError } from "@/lib/analytics/piiGuard";
import { FakeAnalyticsSink } from "@/lib/analytics/fakeAnalyticsSink";

/**
 * REQ-198: "Analítica de páginas públicas sin captura de datos personales
 * identificables (sin PII en eventos...)". Hoy `apps/web` no tiene NINGUNA
 * analítica (ver `src/test/no-analytics-sdk.test.ts`), así que el criterio
 * se cumple de forma pasiva -- pero nada fallaba automáticamente si algún
 * día se agregara analítica que sí mandara PII. Esta suite blinda esa
 * hipótesis: prueba la lógica de negocio REAL (`assertNoPii`/
 * `guardAnalyticsSink`) con un adaptador FAKE (`FakeAnalyticsSink`) que
 * nunca sale a la red -- el patrón "puerto real + fake solo en el borde"
 * documentado en `piiGuard.ts`.
 */
describe("checkForPii / assertNoPii (REQ-198)", () => {
  it("caso negativo: un evento sin PII pasa limpio", () => {
    const result = checkForPii({
      name: "page_view",
      properties: {
        path: "/dashboard",
        referrerDomain: "google.com",
        locale: "es-MX",
        viewportWidth: 390,
        organizationId: "b3f1c2b0-1234-4a11-9c1a-abcdef012345",
        durationMs: 1234,
        amount: 150000,
      },
    });
    expect(result).toEqual({ ok: true, reasons: [] });
    expect(() =>
      assertNoPii({
        name: "page_view",
        properties: { path: "/dashboard", amount: 150000 },
      }),
    ).not.toThrow();
  });

  it("caso negativo: un evento sin properties pasa limpio", () => {
    expect(checkForPii({ name: "cta_click" })).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    ["email", { email: "ana.perez@example.com" }],
    ["nombre", { nombre: "Ana Pérez" }],
    ["telefono", { telefono: "5512345678" }],
    ["rfc", { rfc: "PEPJ800101ABC" }],
    ["direccion", { direccion: "Calle Falsa 123" }],
    ["ip", { ip: "201.155.12.34" }],
    ["password", { password: "hunter2" }],
    ["tarjeta", { tarjeta: "4111111111111111" }],
  ])("campo denylisted por nombre: %s", (_label, properties) => {
    const result = checkForPii({ name: "signup", properties });
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(() => assertNoPii({ name: "signup", properties })).toThrow(PiiDetectedError);
  });

  it("campo denylisted por nombre compuesto: codigoPostal (camelCase)", () => {
    const result = checkForPii({ name: "checkout", properties: { codigoPostal: "06600" } });
    expect(result.ok).toBe(false);
  });

  it("no marca falso positivo por substring: 'relatedId' no contiene el token 'lat'", () => {
    const result = checkForPii({ name: "link_click", properties: { relatedId: "abc-123", translation: "hola" } });
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("defensa en profundidad: un correo escondido bajo un nombre de campo inocuo también se atrapa", () => {
    const result = checkForPii({ name: "contact_form", properties: { contacto: "ana.perez@example.com" } });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("correo"))).toBe(true);
  });

  it("defensa en profundidad: un teléfono de 10 dígitos embebido en texto libre bajo un campo inocuo se atrapa", () => {
    const result = checkForPii({ name: "support_note", properties: { nota: "llámame al 5512345678 antes de las 6" } });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("teléfono"))).toBe(true);
  });

  it("defensa en profundidad: una IP embebida en texto bajo un campo inocuo se atrapa", () => {
    const result = checkForPii({ name: "debug_log", properties: { detalle: "conectado desde 201.155.12.34 vía VPN" } });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("dirección IP"))).toBe(true);
  });

  it("un monto o ID numérico corto no dispara el detector de teléfono (evita falso positivo típico)", () => {
    const result = checkForPii({ name: "purchase", properties: { amount: "150000", orderId: "998877" } });
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it("PII anidada en un objeto adentro de properties se atrapa por path completo", () => {
    const result = checkForPii({
      name: "profile_view",
      properties: { user: { rfc: "PEPJ800101ABC" } },
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes('properties.user.rfc'))).toBe(true);
  });

  it("PII anidada dentro de un arreglo de objetos se atrapa por path con índice", () => {
    const result = checkForPii({
      name: "batch_event",
      properties: { items: [{ note: "ok" }, { contacto: { email: "a@b.com" } }] },
    });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("properties.items[1].contacto.email"))).toBe(true);
  });

  it("CURP con forma válida se atrapa por patrón de valor incluso sin nombre de campo sospechoso", () => {
    const result = checkForPii({ name: "kyc_event", properties: { valor: "PEPJ800101HDFRRN09" } });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("CURP"))).toBe(true);
  });

  it("fail-closed: un payload anidado más allá de la profundidad máxima se rechaza sin importar el contenido", () => {
    // 8 niveles de anidación (> MAX_DEPTH = 6), con PII escondida hasta el fondo.
    const deeplyNested = { a: { b: { c: { d: { e: { f: { g: { h: { email: "oculto@example.com" } } } } } } } } };
    const result = checkForPii({ name: "deep_event", properties: deeplyNested });
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.includes("profundidad máxima"))).toBe(true);
  });

  it("assertNoPii lanza PiiDetectedError con el nombre del evento y las razones", () => {
    try {
      assertNoPii({ name: "signup", properties: { email: "x@y.com" } });
      expect.fail("se esperaba que lanzara");
    } catch (error) {
      expect(error).toBeInstanceOf(PiiDetectedError);
      const piiError = error as PiiDetectedError;
      expect(piiError.eventName).toBe("signup");
      expect(piiError.reasons.length).toBeGreaterThan(0);
      expect(piiError.message).toContain("REQ-198");
    }
  });
});

describe("guardAnalyticsSink (REQ-198) — el borde externo se mockea, la lógica de negocio no", () => {
  it("un evento limpio SÍ llega al sink real (aquí, el fake de pruebas)", () => {
    const fakeSink = new FakeAnalyticsSink();
    const guarded = guardAnalyticsSink(fakeSink);

    guarded.send({ name: "page_view", properties: { path: "/demo" } });

    expect(fakeSink.events).toHaveLength(1);
    expect(fakeSink.events[0]).toEqual({ name: "page_view", properties: { path: "/demo" } });
  });

  it("un evento con PII NUNCA llega al sink: la guardia lanza antes de reenviar", () => {
    const fakeSink = new FakeAnalyticsSink();
    const guarded = guardAnalyticsSink(fakeSink);

    expect(() => guarded.send({ name: "signup", properties: { email: "ana@example.com" } })).toThrow(PiiDetectedError);

    // La prueba adversarial real: el sink de destino se queda VACÍO. Si la
    // guardia alguna vez se reescribiera para "enviar y luego avisar" en vez
    // de "validar antes de enviar", esta aserción es la que lo atraparía.
    expect(fakeSink.events).toHaveLength(0);
  });

  it("múltiples eventos: uno limpio y uno con PII -- solo el limpio llega al sink", () => {
    const fakeSink = new FakeAnalyticsSink();
    const guarded = guardAnalyticsSink(fakeSink);

    guarded.send({ name: "page_view", properties: { path: "/" } });
    expect(() => guarded.send({ name: "lead_capture", properties: { telefono: "5512345678" } })).toThrow();
    guarded.send({ name: "page_view", properties: { path: "/demo" } });

    expect(fakeSink.events.map((e) => e.name)).toEqual(["page_view", "page_view"]);
  });
});
