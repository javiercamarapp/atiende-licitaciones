/**
 * Enlaces firmados con HMAC-SHA256: verificación de correo, invitación,
 * restablecimiento de contraseña, baja de un clic. Sin estado en servidor
 * (no hay tabla de "tokens vigentes" que consultar) — la validez viaja
 * dentro del propio enlace, firmada, con su fecha de expiración.
 *
 * Formato del querystring: `?d=<payload base64url>&s=<firma base64url>`.
 * `d` es el JSON del payload (incluye `exp`, epoch en segundos) codificado
 * en base64url; `s` es el HMAC-SHA256 de `d` con la llave del servicio. La
 * comparación de la firma usa `timingSafeEqual` — comparar con `===` una
 * firma atacante-controlada abre a un ataque de temporización.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignedLinkPayload = Record<string, string | number | boolean | null>;

export type VerifySignedLinkResult<T extends SignedLinkPayload = SignedLinkPayload> =
  | { ok: true; payload: T }
  | { ok: false; reason: "malformado" | "firma_invalida" | "expirado" };

export interface LinkSigner {
  /**
   * Arma una URL absoluta `${baseUrl}${path}` con el payload firmado y una
   * expiración de `ttlSeconds` segundos a partir de ahora.
   */
  signedLink(baseUrl: string, path: string, payload: SignedLinkPayload, ttlSeconds: number): string;
  /** Verifica una URL previamente firmada por este mismo `LinkSigner`. */
  verifySignedLink<T extends SignedLinkPayload = SignedLinkPayload>(url: string): VerifySignedLinkResult<T>;
}

function toBase64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function sign(data: string, secret: string): string {
  return toBase64Url(createHmac("sha256", secret).update(data).digest());
}

/**
 * Crea un firmador con una llave secreta dada. La llave debe venir de una
 * variable de entorno (`MAIL_LINK_SECRET`, ver README) — nunca hardcodeada,
 * y debe ser estable entre despliegues: rotarla invalida todos los enlaces
 * ya emitidos que aún no hayan expirado.
 */
export function createLinkSigner(secret: string): LinkSigner {
  if (!secret || secret.length < 16) {
    throw new Error("createLinkSigner requiere un secreto de al menos 16 caracteres.");
  }

  return {
    signedLink(baseUrl, path, payload, ttlSeconds) {
      // Sin piso artificial: un `ttlSeconds` <= 0 arma deliberadamente un
      // enlace YA expirado (útil para pruebas y para el caso legítimo de
      // invalidar algo de inmediato). El llamador es quien decide el TTL.
      const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
      const body = { ...payload, exp: expiresAt };
      const data = toBase64Url(Buffer.from(JSON.stringify(body), "utf8"));
      const signature = sign(data, secret);
      const url = new URL(path, baseUrl);
      url.searchParams.set("d", data);
      url.searchParams.set("s", signature);
      return url.toString();
    },

    verifySignedLink<T extends SignedLinkPayload = SignedLinkPayload>(url: string): VerifySignedLinkResult<T> {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return { ok: false, reason: "malformado" };
      }
      const data = parsedUrl.searchParams.get("d");
      const signature = parsedUrl.searchParams.get("s");
      if (!data || !signature) return { ok: false, reason: "malformado" };

      const expected = sign(data, secret);
      const provided = Buffer.from(signature);
      const expectedBuf = Buffer.from(expected);
      const validSignature = provided.length === expectedBuf.length && timingSafeEqual(provided, expectedBuf);
      if (!validSignature) return { ok: false, reason: "firma_invalida" };

      let payload: T & { exp: number };
      try {
        payload = JSON.parse(fromBase64Url(data).toString("utf8")) as T & { exp: number };
      } catch {
        return { ok: false, reason: "malformado" };
      }
      if (typeof payload.exp !== "number" || Number.isNaN(payload.exp)) {
        return { ok: false, reason: "malformado" };
      }
      if (Math.floor(Date.now() / 1000) > payload.exp) {
        return { ok: false, reason: "expirado" };
      }
      return { ok: true, payload };
    },
  };
}
