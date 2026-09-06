import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, DataTable, Callout, Title, CtaButton } from "../../components/blocks";
import { BaseVariablesSchema, formatFechaEs } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const TwoFactorEnabledVariablesSchema = BaseVariablesSchema.extend({
  activatedAtIso: z.string().min(1),
  method: z.enum(["app_autenticadora", "sms"]),
  securityUrl: z.string().url(),
});

export type TwoFactorEnabledVariables = z.infer<typeof TwoFactorEnabledVariablesSchema>;

const METODO_LABEL: Record<TwoFactorEnabledVariables["method"], string> = {
  app_autenticadora: "Aplicación autenticadora",
  sms: "Mensaje SMS",
};

export const twoFactorEnabledTemplate: TemplateDefinition<TwoFactorEnabledVariables> = {
  id: "two-factor-enabled",
  name: "2FA activado",
  category: "account_security",
  mandatory: true,
  schema: TwoFactorEnabledVariablesSchema,
  sampleData: {
    recipientName: "Paola Sánchez (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    activatedAtIso: "2026-09-06T18:30:00.000Z",
    method: "app_autenticadora",
    securityUrl: "https://app.atiende.mx/cuenta/seguridad",
  },
  async render(vars) {
    const subject = "Activaste la verificación en dos pasos";
    const fecha = formatFechaEs(vars.activatedAtIso);
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader="Tu cuenta ahora pide un segundo factor para iniciar sesión."
        tone="exito"
        reason="Te llegó este mensaje porque activaste la verificación en dos pasos en tu cuenta."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Verificación en dos pasos activada</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Activaste la verificación en dos pasos en tu cuenta de Atiende Licitaciones. A partir de ahora, además de tu
          contraseña, se te pedirá un código para iniciar sesión.
        </Paragraph>
        <DataTable
          rows={[
            { label: "Método", value: METODO_LABEL[vars.method] },
            { label: "Fecha", value: fecha },
          ]}
        />
        <CtaButton label="Revisar mi seguridad" href={vars.securityUrl} appUrl={vars.appUrl} />
        <Callout>
          Si tú no hiciste este cambio, entra a tu cuenta y revisa tu seguridad de inmediato, o escríbenos a{" "}
          {vars.supportEmail}.
        </Callout>
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
