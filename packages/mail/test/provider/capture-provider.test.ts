import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureProvider } from "../../src/provider/capture-provider";
import type { OutboundEmail } from "../../src/provider/types";

const MESSAGE: OutboundEmail = {
  to: ["persona@ejemplo.mx"],
  subject: "Asunto",
  html: "<p>hola</p>",
  text: "hola",
};

describe("CaptureProvider", () => {
  it("guarda el correo en memoria y devuelve un id", async () => {
    const provider = new CaptureProvider();
    const result = await provider.send(MESSAGE);
    expect(result.ok).toBe(true);
    expect(provider.list()).toHaveLength(1);
    expect(provider.list()[0]?.to).toEqual(["persona@ejemplo.mx"]);
  });

  it("findLastTo encuentra el último correo capturado para un destinatario", async () => {
    const provider = new CaptureProvider();
    await provider.send({ ...MESSAGE, subject: "Primero" });
    await provider.send({ ...MESSAGE, subject: "Segundo" });
    expect(provider.findLastTo("persona@ejemplo.mx")?.subject).toBe("Segundo");
    expect(provider.findLastTo("nadie@ejemplo.mx")).toBeUndefined();
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

    it("agrega cada correo como una línea JSONL en disco", async () => {
      dir = mkdtempSync(join(tmpdir(), "atiende-mail-capture-"));
      const filePath = join(dir, "capturados.jsonl");
      const provider = new CaptureProvider({ filePath });
      await provider.send({ ...MESSAGE, subject: "Uno" });
      await provider.send({ ...MESSAGE, subject: "Dos" });
      const lines = readFileSync(filePath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).subject).toBe("Uno");
      expect(JSON.parse(lines[1]!).subject).toBe("Dos");
    });
  });
});
