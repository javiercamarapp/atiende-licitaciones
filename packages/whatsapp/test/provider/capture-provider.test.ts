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

  it("REQ-080: rechaza más de 3 buttonPayloads igual que MetaCloudProvider (mismo contrato, sin importar el proveedor)", async () => {
    const provider = new CaptureProvider();
    const result = await provider.send({ ...MESSAGE, buttonPayloads: ["a", "b", "c", "d"] });
    expect(result).toMatchObject({ ok: false, kind: "permanent" });
    expect(provider.list()).toHaveLength(0);
  });

  it("acepta hasta 3 buttonPayloads y los guarda en el mensaje capturado", async () => {
    const provider = new CaptureProvider();
    await provider.send({ ...MESSAGE, buttonPayloads: ["GO:t1", "NOGO:t1"] });
    expect(provider.list()[0]?.buttonPayloads).toEqual(["GO:t1", "NOGO:t1"]);
  });

  describe("sendInteractiveList", () => {
    const LIST_MESSAGE = {
      to: "+525512345678",
      bodyText: "¿Por qué decides No-Go?",
      buttonText: "Elegir razón",
      sections: [{ rows: [{ id: "r1", title: "Plazo insuficiente" }] }],
    };

    it("guarda la lista en memoria y devuelve éxito", async () => {
      const provider = new CaptureProvider();
      const result = await provider.sendInteractiveList(LIST_MESSAGE);
      expect(result.ok).toBe(true);
      expect(provider.listInteractiveLists()).toHaveLength(1);
      expect(provider.findLastInteractiveListTo("+525512345678")?.buttonText).toBe("Elegir razón");
    });

    it("REQ-080: rechaza más de 10 filas", async () => {
      const provider = new CaptureProvider();
      const result = await provider.sendInteractiveList({
        ...LIST_MESSAGE,
        sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `R${i}` })) }],
      });
      expect(result).toMatchObject({ ok: false, kind: "permanent" });
      expect(provider.listInteractiveLists()).toHaveLength(0);
    });
  });

  describe("sendText", () => {
    it("guarda el texto en memoria y devuelve éxito", async () => {
      const provider = new CaptureProvider();
      const result = await provider.sendText("+525512345678", "Listo: registramos tu decisión.");
      expect(result.ok).toBe(true);
      expect(provider.listTexts()).toHaveLength(1);
      expect(provider.findLastTextTo("+525512345678")?.body).toBe("Listo: registramos tu decisión.");
    });
  });

  it("clear() también vacía listas interactivas y textos", async () => {
    const provider = new CaptureProvider();
    await provider.send(MESSAGE);
    await provider.sendInteractiveList({ to: "+525512345678", bodyText: "b", buttonText: "Elegir", sections: [{ rows: [{ id: "r1", title: "t" }] }] });
    await provider.sendText("+525512345678", "hola");
    provider.clear();
    expect(provider.list()).toHaveLength(0);
    expect(provider.listInteractiveLists()).toHaveLength(0);
    expect(provider.listTexts()).toHaveLength(0);
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
