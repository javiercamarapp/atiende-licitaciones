import { afterEach, describe, expect, it } from "vitest";
import { createOcrPortFromEnv } from "../src/factory.js";
import { FakeOcrAdapter } from "../src/fake-adapter.js";
import { TesseractOcrAdapter } from "../src/tesseract-adapter.js";

describe("createOcrPortFromEnv", () => {
  const created: Array<{ terminate: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(created.splice(0).map((p) => p.terminate()));
  });

  it("sin OCR_ENGINE, degrada a FakeOcrAdapter -- nunca activa un motor real por accidente (mismo criterio que MAIL_PROVIDER/capture)", () => {
    const port = createOcrPortFromEnv({});
    created.push(port);
    expect(port).toBeInstanceOf(FakeOcrAdapter);
  });

  it("con un OCR_ENGINE desconocido, también degrada a FakeOcrAdapter", () => {
    const port = createOcrPortFromEnv({ OCR_ENGINE: "azure-lo-que-sea" });
    created.push(port);
    expect(port).toBeInstanceOf(FakeOcrAdapter);
  });

  it("con OCR_ENGINE=tesseract explícito, arma un TesseractOcrAdapter real con el idioma/langPath pedidos", () => {
    const port = createOcrPortFromEnv({ OCR_ENGINE: "tesseract", OCR_LANGUAGE: "eng", OCR_LANG_PATH: "/tmp/no-existe" });
    created.push(port);
    expect(port).toBeInstanceOf(TesseractOcrAdapter);
  });
});
