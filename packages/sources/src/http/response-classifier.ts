/**
 * Clasificador de contenido de respuesta, común a todos los conectores
 * (SR-14): detecta cuerpos de captcha/bot-challenge y cambios de formato
 * ANTES de que un conector interprete un HTTP 200 real como datos
 * legítimos. Sin esto, un `fetchImpl` que devuelve 200 con un cuerpo HTML
 * de reCAPTCHA/Zenedge/Cloudflare (documentado como real por el README para
 * ComprasMX/PDN-S6) hace que el parser de turno simplemente no encuentre
 * nada, y `DiscoveryPipeline` reporta `health.state = "ok"` / "0 nuevas" --
 * indistinguible de una corrida real sin novedades (el antipatrón que
 * REQ-148 prohíbe explícitamente), solo que disparado por CONTENIDO en vez
 * de por ausencia de configuración (ver SR-03).
 */

export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptchaDetectedError";
  }
}

export class InterfaceChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterfaceChangedError";
  }
}

export type ExpectedResponseFormat = "json" | "csv" | "text";

/**
 * Marcadores de contenido de páginas de captcha/bot-challenge conocidas.
 * Heurística por CONTENIDO (no por status HTTP): el vector real de SR-14 es
 * un 200 legítimo con este cuerpo. Incluye reCAPTCHA/hCaptcha (Google),
 * Cloudflare (challenge-platform/"checking your browser"), Zenedge
 * (documentado por el README como protección real de
 * `plataformadigitalnacional.org`) y los mensajes en español que un usuario
 * real vería en un formulario de verificación mexicano.
 */
const CHALLENGE_MARKERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /g-recaptcha/i, label: "g-recaptcha" },
  { pattern: /recaptcha/i, label: "recaptcha" },
  { pattern: /hcaptcha/i, label: "hcaptcha" },
  { pattern: /cf-challenge|cf_chl_opt|challenge-platform|challenge-error-text/i, label: "cf-challenge" },
  { pattern: /checking your browser before accessing/i, label: "cloudflare-checking-browser" },
  { pattern: /zenedge/i, label: "zenedge" },
  { pattern: /verificar que no eres un robot|verifica que no eres un robot/i, label: "verificar-robot-es" },
  { pattern: /i'?m not a robot/i, label: "not-a-robot" },
  { pattern: /captcha-form|challenge-form/i, label: "challenge-form" },
];

/** Devuelve la etiqueta del primer marcador de captcha/bot-challenge reconocido en `body`, o `undefined` si no hay ninguno. */
export function detectChallengeMarker(body: string): string | undefined {
  for (const { pattern, label } of CHALLENGE_MARKERS) {
    if (pattern.test(body)) return label;
  }
  return undefined;
}

function looksLikeHtmlDocument(body: string): boolean {
  return /<!doctype html/i.test(body) || /<html[\s>]/i.test(body);
}

/**
 * Valida el cuerpo de una respuesta HTTP "ok" (2xx) ANTES de que el
 * conector la interprete como datos legítimos.
 *
 * - Lanza `CaptchaDetectedError` si el cuerpo contiene un marcador
 *   reconocido de captcha/bot-challenge, SIN IMPORTAR `expected` (incluso un
 *   conector que espera texto/HTML, como DOF, debe distinguir una nota real
 *   de una página de bloqueo).
 * - Lanza `InterfaceChangedError` si se esperaba `json`/`csv` y el cuerpo
 *   tiene forma de documento HTML sin ningún marcador de captcha reconocido
 *   (cambio de interfaz de la fuente, o una página de error/bloqueo
 *   genérica no identificada como captcha).
 *
 * `classifySourceFailure` (`pipeline/source-health.ts`) mapea ambos errores
 * a un `SourceHealthState` explícito (`captcha_detected`/`interface_changed`)
 * -- nunca `"ok"`.
 */
export function assertLegitimateResponseBody(body: string, context: { url: string; expected: ExpectedResponseFormat }): void {
  const marker = detectChallengeMarker(body);
  if (marker) {
    throw new CaptchaDetectedError(
      `Respuesta de ${context.url} contiene un marcador de captcha/bot-challenge ("${marker}") en un HTTP 200/2xx: ` +
        "posible bloqueo por CAPTCHA/anti-bot. Por política (REQ-079) este proyecto nunca intenta resolverlo.",
    );
  }
  if (context.expected !== "text" && looksLikeHtmlDocument(body)) {
    throw new InterfaceChangedError(
      `Respuesta de ${context.url}: se esperaba el formato "${context.expected}" pero el cuerpo tiene forma de ` +
        "documento HTML (posible cambio de interfaz de la fuente, o una página de error/bloqueo no reconocida como captcha).",
    );
  }
}
