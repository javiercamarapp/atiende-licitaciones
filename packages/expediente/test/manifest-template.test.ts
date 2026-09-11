import { describe, expect, it } from "vitest";
import {
  ManifestTemplateRegistry,
  compareSemver,
  type ManifestTemplateInput,
} from "../src/manifest-template.js";

/**
 * REQ-028: "Manifiestos 'bajo protesta' solo desde plantillas versionadas
 * (`manifest.json` con base legal, variables tipadas, semver, sha256); hueco
 * sin dato = bloqueo rojo, nunca texto inventado". Criterio verificable
 * literal: "0 manifiestos sin `doc_id` de respaldo; cambio de plantilla =
 * gate `legal-doc` → needs-human".
 */

const BASE: ManifestTemplateInput = {
  id: "manifiesto-economico-bajo-protesta",
  version: "1.0.0",
  legalBasis: "rules-licitaciones.pdf §manifiestos; BLUEPRINT L616-619 (REQ-028) — pendiente de cita de artículo definitiva, ver gate legal-doc.",
  variables: [
    { name: "razonSocial", type: "string", required: true },
    { name: "montoTotal", type: "number", required: true },
    { name: "moneda", type: "enum", required: true, enumValues: ["MXN", "USD"] },
    { name: "fechaFirma", type: "date", required: true },
    { name: "aceptaPenasConvencionales", type: "boolean", required: true },
    { name: "vigenciaDias", type: "number", required: false, defaultValue: 60 },
  ],
  body:
    "{{razonSocial}} manifiesta bajo protesta de decir verdad, al amparo de {{fechaFirma}}, que el importe total de su propuesta es de {{montoTotal}} {{moneda}}, con vigencia de {{vigenciaDias}} días, y que acepta penas convencionales: {{aceptaPenasConvencionales}}.",
};

function freshRegistry() {
  return new ManifestTemplateRegistry();
}

describe("ManifestTemplateRegistry — REQ-028: esquema, validación y migración de manifest.json versionado", () => {
  it("registerVersion nace SIEMPRE en needs_human, sin importar lo que declare el llamador (gate legal-doc)", () => {
    const registry = freshRegistry();
    const tpl = registry.registerVersion(BASE);
    expect(tpl.reviewStatus).toBe("needs_human");
    expect(tpl.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("render() bloquea (ok:false) una plantilla needs_human — nunca genera texto sin aprobación humana", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    const result = registry.render(
      { id: BASE.id, version: "1.0.0" },
      { razonSocial: "ACME SA de CV", montoTotal: 100000, moneda: "MXN", fechaFirma: "2026-10-20T12:00:00-06:00", aceptaPenasConvencionales: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gaps).toEqual([
        expect.objectContaining({ variable: "__template__", reason: "template_not_approved" }),
      ]);
    }
  });

  it("render() con latest_approved bloquea cuando NO existe ninguna versión aprobada (aunque exista needs_human)", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    const result = registry.render({ id: BASE.id, version: "latest_approved" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gaps[0].reason).toBe("template_not_found");
  });

  it("render() con una plantilla inexistente bloquea con template_not_found", () => {
    const registry = freshRegistry();
    const result = registry.render({ id: "no-existe", version: "1.0.0" }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gaps[0].reason).toBe("template_not_found");
  });

  it("camino feliz: plantilla aprobada + todas las variables presentes produce texto Y doc_id de respaldo trazable", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    const approved = registry.approveVersion(BASE.id, "1.0.0", "javiercamaraportepetit@gmail.com");
    expect(approved.reviewStatus).toBe("approved");
    expect(approved.approvedBy).toBe("javiercamaraportepetit@gmail.com");

    const result = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "ACME SA de CV", montoTotal: 100000, moneda: "MXN", fechaFirma: "2026-10-20T12:00:00-06:00", aceptaPenasConvencionales: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("ACME SA de CV manifiesta bajo protesta de decir verdad");
      expect(result.text).toContain("100000 MXN");
      expect(result.text).toContain("60 días"); // defaultValue aplicado
      expect(result.text).toContain("Sí"); // boolean formateado
      // doc_id de respaldo: criterio "0 manifiestos sin doc_id de respaldo".
      expect(result.docId).toEqual({ templateId: BASE.id, templateVersion: "1.0.0", templateSha256: approved.sha256 });
    }
  });

  it("hueco sin dato (variable requerida faltante) BLOQUEA en rojo — nunca sustituye por texto inventado", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    registry.approveVersion(BASE.id, "1.0.0", "revisor-legal@atiende.mx");

    const result = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "ACME SA de CV", moneda: "MXN", fechaFirma: "2026-10-20T12:00:00-06:00", aceptaPenasConvencionales: true },
      // montoTotal ausente
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gaps).toEqual([expect.objectContaining({ variable: "montoTotal", reason: "missing" })]);
    }
  });

  it("acumula TODOS los huecos/errores de tipo a la vez, no solo el primero", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    registry.approveVersion(BASE.id, "1.0.0", "revisor-legal@atiende.mx");

    const result = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "", montoTotal: "cien mil" as unknown as number, moneda: "EUR", fechaFirma: "no-es-fecha", aceptaPenasConvencionales: "si" as unknown as boolean },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const byVar = Object.fromEntries(result.gaps.map((g) => [g.variable, g.reason]));
      expect(byVar).toEqual({
        razonSocial: "wrong_type",
        montoTotal: "wrong_type",
        moneda: "invalid_enum_value",
        fechaFirma: "wrong_type",
        aceptaPenasConvencionales: "wrong_type",
      });
    }
  });

  it("valor de enum fuera de catálogo bloquea con invalid_enum_value", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    registry.approveVersion(BASE.id, "1.0.0", "revisor-legal@atiende.mx");
    const result = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "ACME", montoTotal: 1, moneda: "GBP", fechaFirma: "2026-10-20T12:00:00-06:00", aceptaPenasConvencionales: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.gaps).toEqual([expect.objectContaining({ variable: "moneda", reason: "invalid_enum_value" })]);
  });

  it("migración de versión: un semver menor o igual al ya registrado se rechaza (no se puede retroceder ni duplicar)", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    expect(() => registry.registerVersion({ ...BASE, version: "1.0.0" })).toThrow(/ya está registrada/);
    expect(() => registry.registerVersion({ ...BASE, version: "0.9.0" })).toThrow(/no es mayor/);
  });

  it("migración de versión: un semver mayor se acepta y nace needs_human — la versión aprobada anterior NO se ve afectada", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    registry.approveVersion(BASE.id, "1.0.0", "revisor-legal@atiende.mx");

    const v2Input: ManifestTemplateInput = {
      ...BASE,
      version: "1.1.0",
      body: BASE.body + " (texto legal actualizado)",
    };
    const v2 = registry.registerVersion(v2Input);
    expect(v2.reviewStatus).toBe("needs_human");
    expect(v2.sha256).not.toBe(registry.getVersion(BASE.id, "1.0.0")!.sha256);

    // "latest_approved" sigue devolviendo 1.0.0 mientras 1.1.0 no se apruebe
    // explícitamente — cambiar de plantilla NUNCA promueve producción sola.
    const result = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "ACME", montoTotal: 1, moneda: "MXN", fechaFirma: "2026-10-20T12:00:00-06:00", aceptaPenasConvencionales: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.docId.templateVersion).toBe("1.0.0");

    registry.approveVersion(BASE.id, "1.1.0", "revisor-legal@atiende.mx");
    const result2 = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "ACME", montoTotal: 1, moneda: "MXN", fechaFirma: "2026-10-20T12:00:00-06:00", aceptaPenasConvencionales: false },
    );
    expect(result2.ok).toBe(true);
    if (result2.ok) expect(result2.docId.templateVersion).toBe("1.1.0");
  });

  it("approveVersion es idempotente-cerrado: no se puede volver a aprobar una plantilla ya aprobada, ni con approvedBy vacío", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    registry.approveVersion(BASE.id, "1.0.0", "revisor-legal@atiende.mx");
    expect(() => registry.approveVersion(BASE.id, "1.0.0", "otro-revisor@atiende.mx")).toThrow(/ya está aprobada/);

    registry.registerVersion({ ...BASE, version: "1.1.0" });
    expect(() => registry.approveVersion(BASE.id, "1.1.0", "  ")).toThrow(/no puede estar vacío/);
  });

  it("approveVersion sobre una plantilla inexistente lanza", () => {
    const registry = freshRegistry();
    expect(() => registry.approveVersion("no-existe", "1.0.0", "quien-sea@atiende.mx")).toThrow(/no existe/);
  });

  it("adversarial: un placeholder en body sin variable declarada se rechaza AL REGISTRAR (nunca en cada render)", () => {
    const registry = freshRegistry();
    expect(() =>
      registry.registerVersion({
        ...BASE,
        version: "1.0.0",
        body: BASE.body + " {{campoNoDeclarado}}",
      }),
    ).toThrow(/no declarada.*campoNoDeclarado|campoNoDeclarado/);
  });

  it("adversarial: variable opcional sin defaultValue que SÍ aparece en el body se rechaza al registrar (evita un hueco garantizado en cada render)", () => {
    const registry = freshRegistry();
    expect(() =>
      registry.registerVersion({
        id: "otra-plantilla",
        version: "1.0.0",
        legalBasis: "test",
        variables: [{ name: "x", type: "string", required: false }],
        body: "texto con {{x}}",
      }),
    ).toThrow(/opcional sin "defaultValue"/);
  });

  it("adversarial: legalBasis vacío se rechaza — texto sin fundamento legal es, por definición, inventado", () => {
    const registry = freshRegistry();
    expect(() => registry.registerVersion({ ...BASE, legalBasis: "   " })).toThrow(/legalBasis/);
  });

  it("adversarial: semver con formato inválido se rechaza", () => {
    const registry = freshRegistry();
    expect(() => registry.registerVersion({ ...BASE, version: "1.0" })).toThrow(/semver/);
    expect(() => registry.registerVersion({ ...BASE, version: "v1.0.0" })).toThrow(/semver/);
  });

  it("adversarial: variable enum sin enumValues, o variable no-enum con enumValues, se rechazan", () => {
    const registry = freshRegistry();
    expect(() =>
      registry.registerVersion({
        id: "p2",
        version: "1.0.0",
        legalBasis: "test",
        variables: [{ name: "moneda", type: "enum", required: true }],
        body: "{{moneda}}",
      }),
    ).toThrow(/enumValues/);
    expect(() =>
      registry.registerVersion({
        id: "p3",
        version: "1.0.0",
        legalBasis: "test",
        variables: [{ name: "x", type: "string", required: true, enumValues: ["a"] }],
        body: "{{x}}",
      }),
    ).toThrow(/enumValues/);
  });

  it("adversarial: nombre de variable duplicado se rechaza", () => {
    const registry = freshRegistry();
    expect(() =>
      registry.registerVersion({
        id: "p4",
        version: "1.0.0",
        legalBasis: "test",
        variables: [
          { name: "x", type: "string", required: true },
          { name: "x", type: "number", required: true },
        ],
        body: "{{x}}",
      }),
    ).toThrow(/más de una vez/);
  });

  it("sha256 es determinista y solo depende de (legalBasis, variables, body), no del reviewStatus", () => {
    const registryA = freshRegistry();
    const registryB = freshRegistry();
    const a = registryA.registerVersion(BASE);
    const b = registryB.registerVersion(BASE);
    expect(a.sha256).toBe(b.sha256);

    const approved = registryA.approveVersion(BASE.id, "1.0.0", "revisor@atiende.mx");
    expect(approved.sha256).toBe(a.sha256);
  });

  it("compareSemver ordena correctamente mayor/menor/patch e igualdad", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("formatea date con formatMexicoCityDateTime y rechaza fechas sin offset explícito", () => {
    const registry = freshRegistry();
    registry.registerVersion(BASE);
    registry.approveVersion(BASE.id, "1.0.0", "revisor@atiende.mx");
    const badDate = registry.render(
      { id: BASE.id, version: "latest_approved" },
      { razonSocial: "ACME", montoTotal: 1, moneda: "MXN", fechaFirma: "2026-10-20T12:00:00", aceptaPenasConvencionales: false },
    );
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.gaps[0]).toEqual(expect.objectContaining({ variable: "fechaFirma", reason: "wrong_type" }));
  });
});
