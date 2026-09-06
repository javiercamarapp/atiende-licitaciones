import { describe, expect, it } from "vitest";
import {
  assertLegitimateResponseBody,
  CaptchaDetectedError,
  detectChallengeMarker,
  InterfaceChangedError,
} from "../src/http/response-classifier.js";
import { classifySourceFailure } from "../src/pipeline/source-health.js";

describe("detectChallengeMarker (SR-14)", () => {
  it("reconoce marcadores reales de reCAPTCHA/hCaptcha/Cloudflare/Zenedge/mensajes en español", () => {
    expect(detectChallengeMarker('<div class="g-recaptcha"></div>')).toBe("g-recaptcha");
    expect(detectChallengeMarker("hCaptcha challenge")).toBe("hcaptcha");
    expect(detectChallengeMarker("Checking your browser before accessing the site.")).toBe("cloudflare-checking-browser");
    expect(detectChallengeMarker("Powered by Zenedge")).toBe("zenedge");
    expect(detectChallengeMarker("Verifica que no eres un robot")).toBe("verificar-robot-es");
  });

  it("no marca contenido legítimo sin ningún indicio de captcha/challenge", () => {
    expect(detectChallengeMarker("<html><body>Convocatoria pública LA-000-2026</body></html>")).toBeUndefined();
    expect(detectChallengeMarker('{"data":[{"registros":[]}]}')).toBeUndefined();
  });
});

describe("assertLegitimateResponseBody (SR-14)", () => {
  it("lanza CaptchaDetectedError ante un marcador de captcha, sin importar el formato esperado", () => {
    const body = "<div class='g-recaptcha'></div>";
    expect(() => assertLegitimateResponseBody(body, { url: "https://example.gob.mx", expected: "json" })).toThrow(CaptchaDetectedError);
    expect(() => assertLegitimateResponseBody(body, { url: "https://example.gob.mx", expected: "text" })).toThrow(CaptchaDetectedError);
  });

  it("lanza InterfaceChangedError si se esperaba json/csv pero el cuerpo tiene forma de documento HTML sin marcador de captcha", () => {
    const body = "<!doctype html><html><body>Error 500 interno del servidor</body></html>";
    expect(() => assertLegitimateResponseBody(body, { url: "https://example.gob.mx", expected: "json" })).toThrow(InterfaceChangedError);
    expect(() => assertLegitimateResponseBody(body, { url: "https://example.gob.mx", expected: "csv" })).toThrow(InterfaceChangedError);
  });

  it("NO lanza si se esperaba texto/HTML (p.ej. DOF) y el cuerpo es HTML legítimo sin captcha", () => {
    const body = "<html><body>DEPENDENCIA.-Convocatoria pública</body></html>";
    expect(() => assertLegitimateResponseBody(body, { url: "https://dof.gob.mx", expected: "text" })).not.toThrow();
  });

  it("NO lanza para un JSON/CSV legítimo sin marcadores de captcha", () => {
    expect(() => assertLegitimateResponseBody('{"data":[]}', { url: "https://example.gob.mx", expected: "json" })).not.toThrow();
    expect(() => assertLegitimateResponseBody("a,b\n1,2\n", { url: "https://example.gob.mx", expected: "csv" })).not.toThrow();
  });
});

describe("detectChallengeMarker: SR-19/SR-20 (residuales de la ronda 2 de corrección)", () => {
  it("SR-19: reconoce la palabra suelta 'captcha' sin vendor específico (soft-block de aplicación, p.ej. JSON)", () => {
    expect(detectChallengeMarker('{"success":false,"error":"captcha"}')).toBe("captcha-generic");
  });

  it("SR-20: reconoce Akamai Bot Manager ('Pardon Our Interruption', cookie ak_bmsc)", () => {
    expect(detectChallengeMarker("Pardon Our Interruption! You've been momentarily blocked.")).toBe("akamai-bot-manager");
    expect(detectChallengeMarker("document.cookie = 'ak_bmsc=abc123'")).toBe("akamai-bot-manager");
  });

  it("SR-20: reconoce Imperva/Incapsula", () => {
    expect(detectChallengeMarker("Request unsuccessful. Incapsula incident ID: 123-456")).toBe("imperva-incapsula");
  });

  it("SR-20: reconoce Cloudflare Turnstile y 'Just a moment...'", () => {
    expect(detectChallengeMarker('<div class="cf-turnstile"></div>')).toBe("cf-challenge");
    expect(detectChallengeMarker("Just a moment...")).toBe("cloudflare-checking-browser");
  });

  it("SR-20: reconoce un formulario de login genérico (campo de contraseña dentro de HTML)", () => {
    expect(detectChallengeMarker('<form><input type="password" name="pwd"></form>')).toBe("generic-login-form");
  });
});

describe("assertLegitimateResponseBody: SR-19 (JSON válido pero soft-block) y SR-20 (expected:'text' con marcadores mínimos)", () => {
  it("SR-19: un JSON con la palabra suelta 'captcha' lanza CaptchaDetectedError aunque sea sintácticamente válido", () => {
    expect(() => assertLegitimateResponseBody('{"success":false,"error":"captcha"}', { url: "https://example.gob.mx", expected: "json" })).toThrow(
      CaptchaDetectedError,
    );
  });

  it("SR-20/SR-23: expected:'text' con semanticContentMarkers -- un login genérico (HTML sin ningún marcador semántico) lanza InterfaceChangedError", () => {
    const loginHtml = "<!doctype html><html><body><h1>Inicia sesión</h1><p>Sesión requerida para continuar</p></body></html>";
    expect(() =>
      assertLegitimateResponseBody(loginHtml, {
        url: "https://dof.gob.mx/nota_detalle.php",
        expected: "text",
        semanticContentMarkers: [/convocatoria/i, /licitaci[oó]n\s+p[uú]blica/i],
      }),
    ).toThrow(InterfaceChangedError);
  });

  it("SR-20: expected:'text' con semanticContentMarkers -- Akamai Bot Manager se clasifica como captcha, no como interface_changed", () => {
    const akamaiHtml = "<!doctype html><html><body><h1>Pardon Our Interruption</h1></body></html>";
    expect(() =>
      assertLegitimateResponseBody(akamaiHtml, {
        url: "https://dof.gob.mx/nota_detalle.php",
        expected: "text",
        semanticContentMarkers: [/convocatoria/i],
      }),
    ).toThrow(CaptchaDetectedError);
  });

  it("SR-23: expected:'text' con semanticContentMarkers -- un HTML que SÍ trae el marcador SEMÁNTICO esperado NO lanza, aunque la plantilla (título/id) sea distinta de la muestra", () => {
    const notaPlantillaDistinta =
      "<html><head><title>D.O.F. - Diario Oficial</title></head><body><div id=\"contenedorNota\">" +
      "DEPENDENCIA.-Convocatoria número LA-050GYN003-E1-2026 relativa a la licitación pública de prueba. " +
      "Objeto de la licitación: adquisición de equipo de prueba. Junta de aclaraciones: 10/09/2026.</div></body></html>";
    expect(() =>
      assertLegitimateResponseBody(notaPlantillaDistinta, {
        url: "https://dof.gob.mx/nota_detalle.php",
        expected: "text",
        semanticContentMarkers: [/convocatoria/i, /licitaci[oó]n\s+p[uú]blica/i, /\b(?:LA|IA|IO|LO)-[0-9A-Z]{3,}-[A-Z0-9]{2,}-\d{4}\b/],
      }),
    ).not.toThrow();
  });

  it("SR-23: un interstitial genérico con <script> de redirección (setTimeout/location.replace) que SÍ matchea el marcador semántico igual lanza InterfaceChangedError (el cascarón no basta)", () => {
    const interstitial =
      "<html><head><title>DOF - Diario Oficial de la Federación</title></head><body>" +
      "<p>Convocatoria en revisión, verificando su navegador...</p>" +
      "<script>setTimeout(function(){ location.replace('/nota_detalle.php?codigo=1&continue=1'); }, 3000);</script>" +
      "</body></html>";
    expect(() =>
      assertLegitimateResponseBody(interstitial, {
        url: "https://dof.gob.mx/nota_detalle.php",
        expected: "text",
        semanticContentMarkers: [/convocatoria/i],
      }),
    ).toThrow(InterfaceChangedError);
  });

  it("SR-23: un meta-refresh lanza InterfaceChangedError igual que un <script> de redirección", () => {
    const metaRefresh =
      '<html><head><meta http-equiv="refresh" content="3;url=/nota_detalle.php?codigo=1"><title>DOF - Diario Oficial de la Federación</title></head>' +
      "<body>Convocatoria en revisión...</body></html>";
    expect(() =>
      assertLegitimateResponseBody(metaRefresh, { url: "https://dof.gob.mx/nota_detalle.php", expected: "text", semanticContentMarkers: [/convocatoria/i] }),
    ).toThrow(InterfaceChangedError);
  });

  it("SR-23: un cuerpo HTML con texto útil por debajo de minUsefulTextBytes lanza InterfaceChangedError aunque no traiga script/meta-refresh", () => {
    const cascaronVacio = "<html><head><title>DOF - Diario Oficial de la Federación</title></head><body><div id=\"DivDetalleNota\"></div></body></html>";
    expect(() =>
      assertLegitimateResponseBody(cascaronVacio, { url: "https://dof.gob.mx/nota_detalle.php", expected: "text", semanticContentMarkers: [/convocatoria/i] }),
    ).toThrow(InterfaceChangedError);
  });

  it("expected:'text' SIN semanticContentMarkers sigue sin lanzar por cualquier HTML legítimo (comportamiento previo preservado)", () => {
    const html = "<html><body>DEPENDENCIA.-Convocatoria pública</body></html>";
    expect(() => assertLegitimateResponseBody(html, { url: "https://dof.gob.mx", expected: "text" })).not.toThrow();
  });
});

describe("classifySourceFailure integra CaptchaDetectedError/InterfaceChangedError (SR-14)", () => {
  it("clasifica CaptchaDetectedError como captcha_detected", () => {
    const error = new CaptchaDetectedError("cuerpo con g-recaptcha");
    expect(classifySourceFailure(error).state).toBe("captcha_detected");
  });

  it("clasifica InterfaceChangedError como interface_changed", () => {
    const error = new InterfaceChangedError("se esperaba json pero llegó HTML");
    expect(classifySourceFailure(error).state).toBe("interface_changed");
  });
});
