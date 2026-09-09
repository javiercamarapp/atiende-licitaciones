import { describe, expect, it } from "vitest";
import { createWhatsAppProviderFromEnv } from "../../src/provider/factory";
import { CaptureProvider } from "../../src/provider/capture-provider";

describe("createWhatsAppProviderFromEnv", () => {
  it("sin WHATSAPP_PROVIDER definido, usa CaptureProvider (default seguro)", () => {
    const provider = createWhatsAppProviderFromEnv({});
    expect(provider).toBeInstanceOf(CaptureProvider);
  });

  it("con un valor desconocido, usa CaptureProvider", () => {
    const provider = createWhatsAppProviderFromEnv({ WHATSAPP_PROVIDER: "algo-raro" });
    expect(provider).toBeInstanceOf(CaptureProvider);
  });

  it("WHATSAPP_PROVIDER=meta arma un MetaCloudProvider", () => {
    const provider = createWhatsAppProviderFromEnv({
      WHATSAPP_PROVIDER: "meta",
      WHATSAPP_ACCESS_TOKEN: "token",
      WHATSAPP_PHONE_NUMBER_ID: "123456",
    });
    expect(provider.name).toBe("meta");
  });

  it("WHATSAPP_PROVIDER=meta sin credenciales igual arma el provider (falla en send, no en la factory)", () => {
    const provider = createWhatsAppProviderFromEnv({ WHATSAPP_PROVIDER: "meta" });
    expect(provider.name).toBe("meta");
  });

  it("WHATSAPP_PROVIDER=capture arma un CaptureProvider con el archivo indicado", () => {
    const provider = createWhatsAppProviderFromEnv({ WHATSAPP_PROVIDER: "capture", WHATSAPP_CAPTURE_FILE: "/tmp/x.jsonl" });
    expect(provider).toBeInstanceOf(CaptureProvider);
  });
});
