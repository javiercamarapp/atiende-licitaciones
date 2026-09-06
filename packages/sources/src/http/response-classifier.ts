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
 * Cloudflare (challenge-platform/"checking your browser"/Turnstile), Akamai
 * Bot Manager, Imperva/Incapsula, Zenedge (documentado por el README como
 * protección real de `plataformadigitalnacional.org`), los mensajes en
 * español que un usuario real vería en un formulario de verificación
 * mexicano, y un formulario de login genérico (SR-20: un login HTML sin
 * ninguna palabra "captcha"/"challenge" es igual de real como soft-block que
 * un captcha explícito -- p.ej. un endpoint que empezó a exigir sesión).
 *
 * SR-19/SR-20 (residuales de la ronda 2 de corrección): antes de esta ronda,
 * la palabra suelta "captcha" (p.ej. `{"error":"captcha"}`, un JSON
 * sintácticamente válido de un soft-block de aplicación) y vendors sin
 * marcador explícito (Akamai "Pardon Our Interruption", Imperva/Incapsula,
 * un login genérico) pasaban sin detectarse.
 */
const CHALLENGE_MARKERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /g-recaptcha/i, label: "g-recaptcha" },
  { pattern: /recaptcha/i, label: "recaptcha" },
  { pattern: /hcaptcha/i, label: "hcaptcha" },
  // SR-19: la palabra suelta "captcha" (sin vendor específico) -- cubre soft-blocks de aplicación
  // como `{"error":"captcha"}`, además de ser una red de seguridad genérica sobre los patrones de arriba.
  { pattern: /captcha/i, label: "captcha-generic" },
  { pattern: /cf-challenge|cf_chl_opt|challenge-platform|challenge-error-text|cf-turnstile/i, label: "cf-challenge" },
  { pattern: /checking your browser before accessing|just a moment\.{3}|attention required.{0,20}\|.{0,5}cloudflare/i, label: "cloudflare-checking-browser" },
  { pattern: /zenedge/i, label: "zenedge" },
  // SR-20: Akamai Bot Manager ("Pardon Our Interruption...", cookies `ak_bmsc`/`_abck`) -- vendor real no
  // reconocido por ningún marcador anterior, confirmado por la reverificación adversarial de la ronda 2.
  { pattern: /pardon our interruption|ak_bmsc|akamai bot manager|_abck=/i, label: "akamai-bot-manager" },
  // SR-20: Imperva/Incapsula (otro vendor de bot-protection común en portales gubernamentales).
  { pattern: /incapsula|imperva|_incapsula_resource/i, label: "imperva-incapsula" },
  { pattern: /verificar que no eres un robot|verifica que no eres un robot/i, label: "verificar-robot-es" },
  { pattern: /i'?m not a robot/i, label: "not-a-robot" },
  { pattern: /captcha-form|challenge-form/i, label: "challenge-form" },
  // SR-20: formulario de login genérico (campo de contraseña dentro de un documento HTML) -- un endpoint que
  // empezó a exigir sesión responde con una página de login real, sin ninguna palabra "captcha"/"challenge".
  { pattern: /<input[^>]*type\s*=\s*["']?password["']?/i, label: "generic-login-form" },
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

function stripTagsToPlainText(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Marcadores de un "cascarón" interstitial/de redirección genérico (SR-23,
 * residual de SR-20): a diferencia de `CHALLENGE_MARKERS` (vendors
 * conocidos: reCAPTCHA, Cloudflare, Akamai, Imperva...), esto detecta el
 * PATRÓN de un bloqueo que no se identifica con ningún vendor pero SÍ hace
 * lo que cualquier interstitial hace -- mostrar una página de espera y
 * redirigir por JS, o refrescar por meta tag -- mientras conserva intacto
 * el `<title>`/`id` estático del sitio real (por eso `minimalContentMarkers`
 * de la ronda anterior no lo detectaba: el "cascarón" HTML seguía
 * matcheando). Confirmado como vector real por la reverificación adversarial
 * de cierre: un interstitial "Verificando su navegador..." que preserva
 * `<title>DOF - Diario Oficial de la Federación</title>`/`id="DivDetalleNota"`
 * pasaba como `ok` con `coverage.emptyResult=true`.
 */
const INTERSTITIAL_SHELL_MARKERS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?/i, label: "meta-refresh" },
  {
    pattern: /<script[^>]*>[\s\S]*?(setTimeout\s*\(|location\.replace\s*\(|location\.href\s*=|window\.location(?:\.href)?\s*=)[\s\S]*?<\/script>/i,
    label: "script-redirect",
  },
];

/**
 * Devuelve la etiqueta del marcador de interstitial/redirección genérica
 * detectado, o `undefined` si no hay ninguno. Además de los marcadores
 * explícitos de arriba, un cuerpo con forma de documento HTML cuyo texto
 * ÚTIL (sin tags/scripts/estilos) es menor que `minUsefulTextBytes` se trata
 * como interstitial: una página real de contenido (nota del DOF, aviso de
 * licitación) siempre trae varios párrafos de texto; un cascarón que solo
 * conserva el `<title>`/`id` del sitio mientras "vacía" el cuerpo real no.
 */
function detectInterstitialShellMarker(body: string, minUsefulTextBytes: number): string | undefined {
  for (const { pattern, label } of INTERSTITIAL_SHELL_MARKERS) {
    if (pattern.test(body)) return label;
  }
  const usefulTextBytes = Buffer.byteLength(stripTagsToPlainText(body), "utf8");
  if (usefulTextBytes < minUsefulTextBytes) return "cuerpo-util-insuficiente";
  return undefined;
}

export interface AssertLegitimateResponseBodyContext {
  url: string;
  expected: ExpectedResponseFormat;
  /**
   * SR-23 (residual de SR-20): patrones que indican la FORMA/CONTENIDO
   * SEMÁNTICO real esperado de esta fuente (p.ej. "convocatoria"/
   * "licitación pública"/un patrón de número de procedimiento como
   * `LA-050GYN003-E1-2026`), NO marcadores de plantilla estática (título
   * exacto de la página, `id` del contenedor). Reemplaza a
   * `minimalContentMarkers` (ronda anterior): un marcador de PLANTILLA fija
   * genera falsos positivos si el formato real difiere levemente de la
   * muestra usada para construirlo (p.ej. `<title>D.O.F. - Diario Oficial
   * </title>` en vez de `"DOF - Diario Oficial de la Federación"`), y falsos
   * negativos ante un interstitial que preserva ese mismo cascarón HTML
   * mientras reemplaza el contenido útil (ver `detectInterstitialShellMarker`).
   * Opcional: sin esto, cualquier HTML sin marcador de captcha reconocido se
   * acepta (comportamiento previo preservado para fuentes que aún no
   * configuran marcadores semánticos).
   */
  semanticContentMarkers?: ReadonlyArray<RegExp>;
  /**
   * SR-23: bytes mínimos de texto útil (tras quitar tags/scripts/estilos)
   * por debajo de los cuales un HTML con `semanticContentMarkers`
   * configurado se trata como interstitial/challenge, incluso si por
   * casualidad matcheara algún marcador semántico. Default 120.
   */
  minUsefulTextBytes?: number;
}

/**
 * Valida el cuerpo de una respuesta HTTP "ok" (2xx) ANTES de que el
 * conector la interprete como datos legítimos.
 *
 * - Lanza `CaptchaDetectedError` si el cuerpo contiene un marcador
 *   reconocido de captcha/bot-challenge de un VENDOR conocido, SIN IMPORTAR
 *   `expected` (incluso un conector que espera texto/HTML, como DOF, debe
 *   distinguir una nota real de una página de bloqueo).
 * - Lanza `InterfaceChangedError` si se esperaba `json`/`csv` y el cuerpo
 *   tiene forma de documento HTML sin ningún marcador de captcha reconocido
 *   (cambio de interfaz de la fuente, o una página de error/bloqueo
 *   genérica no identificada como captcha); o si se esperaba `text` con
 *   `semanticContentMarkers` configurados y el cuerpo (con forma de HTML) es
 *   un interstitial/redirección genérica (SR-23) o no contiene ningún
 *   marcador semántico del contenido real esperado.
 *
 * `classifySourceFailure` (`pipeline/source-health.ts`) mapea ambos errores
 * a un `SourceHealthState` explícito (`captcha_detected`/`interface_changed`)
 * -- nunca `"ok"`.
 *
 * SR-23 (residual de SR-20, ver README/hallazgo en `docs/auditoria-1/
 * sources-cierre-final.md`): la ronda anterior validaba `expected: "text"`
 * contra marcadores de PLANTILLA fijos (`minimalContentMarkers`), lo que
 * producía (a) un falso positivo -- una nota real con una plantilla apenas
 * distinta de la muestra se rechazaba como `interface_changed` -- y (b) un
 * falso negativo -- un interstitial genérico ("Verificando su navegador...")
 * que conserva el `<title>`/`id` estático del sitio real pasaba como
 * contenido legítimo. Esta ronda separa la validación en dos ejes
 * independientes del texto de plantilla: ausencia de un cascarón
 * interstitial/de redirección (`detectInterstitialShellMarker`) y presencia
 * de al menos un marcador SEMÁNTICO configurable del contenido real
 * esperado (`semanticContentMarkers`).
 */
export function assertLegitimateResponseBody(body: string, context: AssertLegitimateResponseBodyContext): void {
  const marker = detectChallengeMarker(body);
  if (marker) {
    throw new CaptchaDetectedError(
      `Respuesta de ${context.url} contiene un marcador de captcha/bot-challenge ("${marker}") en un HTTP 200/2xx: ` +
        "posible bloqueo por CAPTCHA/anti-bot. Por política (REQ-079) este proyecto nunca intenta resolverlo.",
    );
  }
  if (context.expected !== "text") {
    if (looksLikeHtmlDocument(body)) {
      throw new InterfaceChangedError(
        `Respuesta de ${context.url}: se esperaba el formato "${context.expected}" pero el cuerpo tiene forma de ` +
          "documento HTML (posible cambio de interfaz de la fuente, o una página de error/bloqueo no reconocida como captcha).",
      );
    }
    return;
  }

  // expected === "text": un cuerpo HTML/texto es POR DISEÑO el formato legítimo (p.ej. una nota real del DOF),
  // así que no se rechaza solo por tener forma de documento HTML. Pero si el llamador declaró marcadores
  // SEMÁNTICOS del contenido real esperado (SR-23) y el cuerpo tiene forma de HTML, se exige ADEMÁS (a) que no
  // sea un cascarón interstitial/de redirección genérico y (b) que contenga al menos uno de esos marcadores --
  // ninguno de los dos depende de la plantilla exacta del sitio, así que una nota real con plantilla distinta
  // sigue pasando, y un interstitial que reutiliza el cascarón HTML del sitio real deja de hacerlo.
  if (context.semanticContentMarkers && context.semanticContentMarkers.length > 0 && looksLikeHtmlDocument(body)) {
    const minUsefulTextBytes = context.minUsefulTextBytes ?? 120;
    const interstitialLabel = detectInterstitialShellMarker(body, minUsefulTextBytes);
    const hasSemanticMarker = context.semanticContentMarkers.some((pattern) => pattern.test(body));
    if (interstitialLabel || !hasSemanticMarker) {
      throw new InterfaceChangedError(
        `Respuesta de ${context.url}: se esperaba texto/HTML con contenido semántico real de la fuente, pero ` +
          (interstitialLabel
            ? `el cuerpo tiene forma de interstitial/redirección genérica (marcador "${interstitialLabel}") sin contenido real, `
            : "no contiene ningún marcador semántico del contenido real esperado (p.ej. convocatoria/licitación pública/número de procedimiento), ") +
          "aunque conserve el título/estructura estática del sitio -- probable challenge/interstitial que reutiliza el cascarón HTML del sitio real, o cambio de interfaz de la fuente.",
      );
    }
  }
}
