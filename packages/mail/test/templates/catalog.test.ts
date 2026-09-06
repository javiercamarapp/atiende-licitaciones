import { describe, expect, it } from "vitest";
import { listTemplates, requireTemplate } from "../../src/templates/registry";
import { createEmailHtmlValidator } from "../support/html-validate-config";

const validator = createEmailHtmlValidator();

describe("catálogo de plantillas de correo", () => {
  const templates = listTemplates();

  it("tiene al menos 15 plantillas registradas (una por cada evento del catálogo, REQ-181 + ampliación)", () => {
    expect(templates.length).toBeGreaterThanOrEqual(15);
  });

  it("cada id de plantilla es único", () => {
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(templates.map((t) => [t.id, t] as const))("«%s» valida sus propios datos de ejemplo contra su esquema", (_id, template) => {
    const parsed = template.schema.safeParse(template.sampleData);
    expect(parsed.success).toBe(true);
  });

  it.each(templates.map((t) => [t.id, t] as const))("«%s» renderiza sin errores y produce asunto/HTML/texto no vacíos", async (_id, template) => {
    const rendered = await template.render(template.sampleData);
    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it.each(templates.map((t) => [t.id, t] as const))("«%s» contiene el wordmark de marca y el pie con motivo de envío", async (_id, template) => {
    const rendered = await template.render(template.sampleData);
    expect(rendered.html).toContain(">atiende<");
    expect(rendered.html).toMatch(/Atiende\s*·\s*Licitaciones/);
    expect(rendered.html).toContain("Razón social pendiente");
  });

  it.each(templates.filter((t) => !t.mandatory).map((t) => [t.id, t] as const))(
    "«%s» (no obligatoria) incluye enlace de preferencias y de baja cuando la muestra los trae",
    async (_id, template) => {
      const rendered = await template.render(template.sampleData);
      const sample = template.sampleData as Record<string, unknown>;
      if (typeof sample.preferencesUrl === "string") {
        expect(rendered.html).toContain("Administrar preferencias de notificación");
      }
      if (typeof sample.unsubscribeUrl === "string") {
        expect(rendered.html).toContain("Darme de baja de estos correos");
      }
    },
  );

  it.each(templates.filter((t) => t.mandatory).map((t) => [t.id, t] as const))(
    "«%s» (obligatoria/seguridad) NO ofrece darse de baja",
    async (_id, template) => {
      const rendered = await template.render(template.sampleData);
      expect(rendered.html).not.toContain("Darme de baja de estos correos");
    },
  );

  it.each(templates.map((t) => [t.id, t] as const))("«%s» produce HTML válido para correo (ver test/support/html-validate-config.ts)", async (_id, template) => {
    const rendered = await template.render(template.sampleData);
    const result = await validator.validateString(rendered.html);
    if (!result.valid) {
      const detail = result.results[0]?.messages.map((m) => `${m.ruleId}: ${m.message}`).join("\n");
      throw new Error(`HTML inválido en «${template.id}»:\n${detail}`);
    }
    expect(result.valid).toBe(true);
  });

  it("requireTemplate lanza para un id inexistente", () => {
    expect(() => requireTemplate("no-existe")).toThrow(/No existe la plantilla/);
  });

  it("cada plantilla con CTA incluye un botón cuyo texto no está vacío", async () => {
    for (const template of templates) {
      const rendered = await template.render(template.sampleData);
      // Todas las plantillas del catálogo (salvo avisos puros de seguridad)
      // llevan un CTA — se verifica que exista al menos un <a> con texto.
      const hasLink = /<a\s[^>]*href="https?:\/\/[^"]+"[^>]*>[^<]+</.test(rendered.html);
      expect(hasLink).toBe(true);
    }
  });
});
