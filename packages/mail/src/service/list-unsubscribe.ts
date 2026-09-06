import { safeUrl } from "../security/safe-url";

/**
 * Cabeceras `List-Unsubscribe` / `List-Unsubscribe-Post` (RFC 8058) — la
 * "baja de un clic" a NIVEL DE PROTOCOLO (el botón nativo que Gmail/Yahoo
 * pintan junto al remitente), distinta del enlace dentro del cuerpo del
 * correo que ya pinta `EmailLayout` (ML-02: antes solo existía el enlace en
 * el cuerpo, y el comentario de `EmailLayout.tsx` citaba RFC 8058 para algo
 * que en realidad no implementaba). Desde febrero de 2024, Gmail y Yahoo
 * EXIGEN estas cabeceras para remitentes de volumen; es buena práctica de
 * entregabilidad para cualquier volumen.
 *
 * Solo aplica a correos de categoría NO obligatoria: un correo de seguridad
 * de cuenta (verificación, contraseña, 2FA) o interno nunca debe ofrecer un
 * botón de "cancelar suscripción" nativo del cliente de correo — para eso
 * está `mandatory` en `TemplateDefinition`.
 */
export interface ListUnsubscribeInput {
  mandatory: boolean;
  /** `unsubscribeUrl` de las variables ya validadas contra
   *  `BaseVariablesSchema` — ausente por diseño en categorías obligatorias. */
  unsubscribeUrl?: string;
  supportEmail?: string;
}

export function buildListUnsubscribeHeaders(input: ListUnsubscribeInput): Record<string, string> | undefined {
  if (input.mandatory) return undefined;
  if (!input.unsubscribeUrl) return undefined;

  // Defensa en profundidad: el mismo criterio que ya aplica EmailLayout al
  // pintar el enlace en el cuerpo — un `unsubscribeUrl` que no sea http(s)
  // real (o que safeUrl rechace) nunca se manda como cabecera.
  const safe = safeUrl(input.unsubscribeUrl, "");
  if (!safe) return undefined;

  const targets = [`<${safe}>`];
  if (input.supportEmail) targets.push(`<mailto:${input.supportEmail}?subject=unsubscribe>`);

  return {
    "List-Unsubscribe": targets.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
