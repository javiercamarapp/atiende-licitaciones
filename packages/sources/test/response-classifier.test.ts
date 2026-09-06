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
