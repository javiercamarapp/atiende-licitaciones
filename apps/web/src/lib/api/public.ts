import { rawRequest } from "./http";

/**
 * REQ-196 (Ampliación 2 §4): formulario de contacto público. `POST
 * /public/contact` es anónimo por definición — es la puerta de entrada del
 * embudo, antes de que exista cuenta ni organización.
 *
 * `website` es el HONEYPOT que declara la API
 * (apps/api/src/modules/public/contact.routes.ts): un campo que el
 * formulario real pinta oculto y ninguna persona llena. Si llega con
 * contenido, la API descarta la petición EN SILENCIO — mismo 202, sin
 * registro ni correo. Se manda siempre (vacío en un envío legítimo) para
 * que el campo exista de verdad en el DOM y un bot lo llene.
 *
 * `retries = 0` a propósito (ver `mail.ts`): el límite de tasa del tier
 * `auth` (5/min por IP) es lo que impide usar este endpoint anónimo —que
 * MANDA CORREO— como cañón de spam. Un 429 aquí es una respuesta real que
 * el visitante debe ver, no algo que el cliente deba absorber reintentando.
 */
export interface ContactRequestPayload {
  name: string;
  email: string;
  company?: string;
  message: string;
  /** Honeypot: SIEMPRE cadena vacía en un envío legítimo. */
  website?: string;
}

export async function submitContactRequest(payload: ContactRequestPayload): Promise<void> {
  await rawRequest<unknown>(
    "/public/contact",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    0,
  );
}
