import { z } from "zod";

/**
 * Campos que trae TODA plantilla: quién la recibe, la base de la app para
 * armar enlaces relativos y de dónde escribir si algo falla. `preferencesUrl`
 * y `unsubscribeUrl` son opcionales aquí a propósito — cada plantilla decide
 * si los expone (`mandatory: true` en su `TemplateDefinition` normalmente no
 * los necesita) y `EmailLayout` solo pinta el bloque si llega el dato.
 */
export const BaseVariablesSchema = z.object({
  recipientName: z.string().min(1, "El nombre del destinatario es obligatorio."),
  appUrl: z.string().url("appUrl debe ser una URL absoluta."),
  supportEmail: z.string().email("supportEmail debe ser un correo válido."),
  preferencesUrl: z.string().url().optional(),
  unsubscribeUrl: z.string().url().optional(),
});

export type BaseVariables = z.infer<typeof BaseVariablesSchema>;

/** Formatea una fecha ISO a `d de mmmm de yyyy` en español de México, sin
 *  depender de que el runtime tenga el locale `es-MX` de ICU completo (los
 *  contenedores mínimos de Node solo traen `en-US` por defecto): la lista de
 *  meses va literal aquí, no vía `Intl`. */
const MESES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

export function formatFechaEs(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} de ${MESES_ES[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}
