import { describe, expect, it } from "vitest";
import { createMailProviderFromEnv } from "../../src/provider/factory";
import { CaptureProvider } from "../../src/provider/capture-provider";

describe("createMailProviderFromEnv", () => {
  it("sin MAIL_PROVIDER definido, usa CaptureProvider (default seguro)", () => {
    const provider = createMailProviderFromEnv({});
    expect(provider).toBeInstanceOf(CaptureProvider);
  });

  it("con un valor desconocido, usa CaptureProvider", () => {
    const provider = createMailProviderFromEnv({ MAIL_PROVIDER: "algo-raro" });
    expect(provider).toBeInstanceOf(CaptureProvider);
  });

  it("MAIL_PROVIDER=resend arma un ResendProvider", () => {
    const provider = createMailProviderFromEnv({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "k", RESEND_EMAIL_DOMAIN: "mail.atiende.mx" });
    expect(provider.name).toBe("resend");
  });

  it("MAIL_PROVIDER=postmark arma un PostmarkProvider", () => {
    const provider = createMailProviderFromEnv({ MAIL_PROVIDER: "postmark", POSTMARK_SERVER_TOKEN: "t", POSTMARK_FROM_ADDRESS: "a@b.mx" });
    expect(provider.name).toBe("postmark");
  });

  it("MAIL_PROVIDER=smtp arma un SmtpProvider", () => {
    const provider = createMailProviderFromEnv({ MAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.mx", SMTP_PORT: "587", SMTP_FROM_ADDRESS: "a@b.mx" });
    expect(provider.name).toBe("smtp");
  });

  it("MAIL_PROVIDER=capture arma un CaptureProvider con el archivo indicado", () => {
    const provider = createMailProviderFromEnv({ MAIL_PROVIDER: "capture", MAIL_CAPTURE_FILE: "/tmp/x.jsonl" });
    expect(provider).toBeInstanceOf(CaptureProvider);
  });
});
