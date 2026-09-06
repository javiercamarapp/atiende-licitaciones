import * as React from "react";
import { z } from "zod";
import { EmailLayout } from "../../components/EmailLayout";
import { Paragraph, CtaButton, Title } from "../../components/blocks";
import { BaseVariablesSchema } from "../common";
import { renderEmailParts } from "../render-html";
import type { TemplateDefinition } from "../types";

export const WelcomeOnboardingVariablesSchema = BaseVariablesSchema.extend({
  organizationName: z.string().min(1),
  onboardingUrl: z.string().url(),
  checklist: z.array(z.string().min(1)).min(1),
});

export type WelcomeOnboardingVariables = z.infer<typeof WelcomeOnboardingVariablesSchema>;

export const welcomeOnboardingTemplate: TemplateDefinition<WelcomeOnboardingVariables> = {
  id: "welcome-onboarding",
  name: "Bienvenida / onboarding",
  category: "account_security",
  mandatory: true,
  schema: WelcomeOnboardingVariablesSchema,
  sampleData: {
    recipientName: "Diana Castillo (ejemplo)",
    appUrl: "https://app.atiende.mx",
    supportEmail: "soporte@atiende.mx",
    organizationName: "Constructora Ejemplo S.A. de C.V. (ejemplo)",
    onboardingUrl: "https://app.atiende.mx/onboarding",
    checklist: [
      "Completa el perfil de tu empresa (giro, RFC, capacidades)",
      "Invita a tu equipo",
      "Configura tus alertas de convocatorias",
      "Revisa tu primera convocatoria recomendada",
    ],
  },
  async render(vars) {
    const subject = `Bienvenido a Atiende Licitaciones, ${vars.recipientName}`;
    const element = (
      <EmailLayout
        documentTitle={subject}
        preheader={`Tu cuenta en ${vars.organizationName} ya está activa. Estos son los siguientes pasos.`}
        reason="Te llegó este mensaje porque activaste tu cuenta en Atiende Licitaciones."
        appUrl={vars.appUrl}
        supportEmail={vars.supportEmail}
      >
        <Title>Bienvenido a Atiende Licitaciones</Title>
        <Paragraph>Hola {vars.recipientName}:</Paragraph>
        <Paragraph>
          Tu cuenta en {vars.organizationName} ya está lista. Atiende Licitaciones te ayuda a encontrar convocatorias
          relevantes, dar seguimiento a sus plazos y preparar tu documentación — siempre con una persona revisando
          antes de que salga algo en automático.
        </Paragraph>
        <Paragraph>Para arrancar, esto es lo que falta:</Paragraph>
        <ul style={{ margin: "0 0 16px 0", paddingLeft: 20, color: "#3f4a5c", fontSize: 15, lineHeight: "24px", fontFamily: "inherit" }}>
          {vars.checklist.map((item) => (
            <li key={item} style={{ marginBottom: 6 }}>
              {item}
            </li>
          ))}
        </ul>
        <CtaButton label="Ir a mi checklist de arranque" href={vars.onboardingUrl} appUrl={vars.appUrl} />
      </EmailLayout>
    );
    const { html, text } = await renderEmailParts(element);
    return { subject, html, text };
  },
};
