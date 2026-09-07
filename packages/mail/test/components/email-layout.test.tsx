import * as React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@react-email/render";
import { EmailLayout } from "../../src/components/EmailLayout";
import { Paragraph } from "../../src/components/blocks";

const BASE_PROPS = {
  documentTitle: "Título de prueba",
  preheader: "Avance de prueba",
  reason: "Por qué te llegó",
  appUrl: "https://app.atiende.mx",
  supportEmail: "soporte@atiende.mx",
};

describe("EmailLayout", () => {
  it("sin logoCid, usa el wordmark de texto (default seguro para todo cliente)", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).toContain(">atiende<");
    expect(html).not.toContain("cid:");
  });

  it("con logoCid, usa un <img> referenciando cid: con alt con estilo de respaldo", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS} logoCid="logo-atiende">
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).toContain('src="cid:logo-atiende"');
    expect(html).toContain('alt="atiende"');
  });

  it("sin preferencesUrl/unsubscribeUrl, no muestra esos enlaces (caso de correo obligatorio)", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).not.toContain("Administrar preferencias de notificación");
    expect(html).not.toContain("Darme de baja de estos correos");
  });

  it("con preferencesUrl y unsubscribeUrl, los muestra", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS} preferencesUrl="https://app.atiende.mx/preferencias" unsubscribeUrl="https://app.atiende.mx/baja">
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).toContain("Administrar preferencias de notificación");
    expect(html).toContain("Darme de baja de estos correos");
  });

  it("un tono con rótulo (atencion/urgente/exito) pinta el micro-rótulo; neutral no pinta nada", async () => {
    const conRotulo = await render(
      <EmailLayout {...BASE_PROPS} tone="urgente">
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(conRotulo).toContain("Urgente");

    const neutral = await render(
      <EmailLayout {...BASE_PROPS}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(neutral).not.toContain("Urgente");
    expect(neutral).not.toContain("Requiere atención");
    expect(neutral).not.toContain("Completado");
  });

  it("un href que no es http(s) en preferencesUrl cae al appUrl (safeUrl)", async () => {
    const html = await render(
      <EmailLayout {...BASE_PROPS} preferencesUrl={"javascript:alert(1)" as string}>
        <Paragraph>Cuerpo</Paragraph>
      </EmailLayout>,
    );
    expect(html).not.toContain("javascript:alert");
  });

  describe("ML-09: respaldo real de modo oscuro (no solo el meta tag)", () => {
    it("declara soporte de modo oscuro en los meta tags (ya no 'light only')", async () => {
      const html = await render(
        <EmailLayout {...BASE_PROPS}>
          <Paragraph>Cuerpo</Paragraph>
        </EmailLayout>,
      );
      expect(html).toContain('name="color-scheme" content="light dark"');
      expect(html).toContain('name="supported-color-schemes" content="light dark"');
      expect(html).not.toContain("light only");
    });

    it("inyecta un <style> real con la media query prefers-color-scheme: dark (no solo el meta tag)", async () => {
      const html = await render(
        <EmailLayout {...BASE_PROPS}>
          <Paragraph>Cuerpo</Paragraph>
        </EmailLayout>,
      );
      expect(html).toMatch(/<style[^>]*>[\s\S]*@media \(prefers-color-scheme:\s*dark\)[\s\S]*<\/style>/);
      // También cubre el recoloreado automático de Gmail (apps iOS/Android),
      // que ignora `prefers-color-scheme` y usa sus propios atributos.
      expect(html).toContain("[data-ogsc]");
    });

    it("el fondo, la tarjeta, los bordes y el texto llevan las clases am-* que el <style> oscuro pisa", async () => {
      const html = await render(
        <EmailLayout {...BASE_PROPS} preferencesUrl="https://app.atiende.mx/preferencias" unsubscribeUrl="https://app.atiende.mx/baja">
          <Paragraph>Cuerpo</Paragraph>
        </EmailLayout>,
      );
      expect(html).toContain("am-canvas");
      expect(html).toContain("am-card");
      expect(html).toContain("am-muted");
      expect(html).toContain("am-faint");
    });

    it("cada tono con rótulo lleva su propia clase am-tone-* (warning/danger/success pierden contraste sobre tarjeta oscura)", async () => {
      const urgente = await render(
        <EmailLayout {...BASE_PROPS} tone="urgente">
          <Paragraph>Cuerpo</Paragraph>
        </EmailLayout>,
      );
      expect(urgente).toContain("am-tone-urgente");

      const exito = await render(
        <EmailLayout {...BASE_PROPS} tone="exito">
          <Paragraph>Cuerpo</Paragraph>
        </EmailLayout>,
      );
      expect(exito).toContain("am-tone-exito");
    });
  });
});
