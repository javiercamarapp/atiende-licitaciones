import { describe, expect, it } from "vitest";
import { listTemplates } from "../../src/templates/registry";

/**
 * REQ-185 exige, entre otras cosas, "0 menciones a Likida" en las
 * plantillas de correo. La evidencia hasta ahora era un `grep` manual
 * sobre `packages/mail/preview/*.html` registrado en un log — nunca un
 * test committeado que guarde el criterio.
 *
 * Este test renderiza las 16 plantillas del catálogo con sus datos de
 * ejemplo y confirma 0 menciones de "Likida" en la SALIDA RENDERIZADA
 * (asunto, HTML y texto plano) — el contenido que de verdad le llega a un
 * destinatario.
 *
 * Fuera de alcance A PROPÓSITO: los comentarios de código fuente en
 * `packages/mail/src/**` y `packages/mail/README.md` que documentan que
 * un patrón viene de Likida (procedencia legítima, nunca contenido de
 * correo real) — REQ-185 habla de las plantillas, no de los comentarios
 * que las documentan, y ese texto nunca se renderiza ni se envía.
 */
describe("REQ-185: 0 menciones a Likida en la salida renderizada de las plantillas", () => {
  const templates = listTemplates();

  it("hay 16 plantillas registradas para cubrir con este test", () => {
    expect(templates.length).toBe(16);
  });

  it.each(templates.map((t) => [t.id, t] as const))("«%s» no menciona Likida en asunto/HTML/texto renderizado", async (_id, template) => {
    const rendered = await template.render(template.sampleData);

    expect(rendered.subject.toLowerCase()).not.toContain("likida");
    expect(rendered.html.toLowerCase()).not.toContain("likida");
    expect(rendered.text.toLowerCase()).not.toContain("likida");
  });
});
