import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureProvider } from "../../src/provider/capture-provider";
import type { OutboundWhatsAppMessage } from "../../src/provider/types";

const MESSAGE: OutboundWhatsAppMessage = {
  to: "+525512345678",
  templateName: "nuevo_match_licitacion",
  templateParams: { "1": "Suministro de uniformes", "2": "18 sep 2026" },
};

describe("CaptureProvider", () => {
  it("guarda el mensaje en memoria y devuelve un id, sin llamar red", async () => {
    const provider = new CaptureProvider();
    const result = await provider.send(MESSAGE);
    expect(result.ok).toBe(true);
    expect(provider.list()).toHaveLength(1);
    expect(provider.list()[0]?.to).toBe("+525512345678");
    expect(provider.list()[0]?.templateName).toBe("nuevo_match_licitacion");
  });

  it("findLastTo encuentra el último mensaje capturado para un número", async () => {
    const provider = new CaptureProvider();
    await provider.send({ ...MESSAGE, templateName: "primero" });
    await provider.send({ ...MESSAGE, templateName: "segundo" });
    expect(provider.findLastTo("+525512345678")?.templateName).toBe("segundo");
    expect(provider.findLastTo("+525500000000")).toBeUndefined();
  });

  it("clear() vacía lo capturado", async () => {
    const provider = new CaptureProvider();
    await provider.send(MESSAGE);
    provider.clear();
    expect(provider.list()).toHaveLength(0);
  });

  describe("con filePath", () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("agrega cada mensaje como una línea JSONL en disco", async () => {
      dir = mkdtempSync(join(tmpdir(), "atiende-whatsapp-capture-"));
      const filePath = join(dir, "capturados.jsonl");
      const provider = new CaptureProvider({ filePath });
      await provider.send({ ...MESSAGE, templateName: "uno" });
      await provider.send({ ...MESSAGE, templateName: "dos" });
      const lines = readFileSync(filePath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).templateName).toBe("uno");
      expect(JSON.parse(lines[1]!).templateName).toBe("dos");
    });
  });
});
