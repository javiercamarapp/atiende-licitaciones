// Proveedor OIDC FALSO **para navegador real**, usado solo por
// `npm run -w apps/web test:e2e:full` (ver scripts/e2e-full.mjs). Implementa
// discovery, JWKS, `/authorize` y `token_endpoint` con la misma forma que un
// proveedor OIDC real, firmando `id_token`s con una clave RSA generada en
// memoria en cada corrida. NUNCA toca la red real ni credenciales de Google.
//
// ¿Por qué no reutilizar `apps/api/test/helpers/fake-oidc.ts`? Porque aquel
// está pensado para pruebas de integración de la API (`app.inject`), donde
// el test llama a `issueAuthorizationCode()` a mano y golpea
// `/auth/google/callback` directamente: su `/authorize` responde texto plano
// y NO redirige. En una suite de navegador real el usuario hace clic en
// "Continuar con Google" y el navegador NAVEGA de verdad al `/authorize` del
// proveedor, que debe responder un 302 hacia `redirect_uri?code&state` para
// que el flujo continúe solo. Este servidor sí lo hace. (No se modifica el
// helper de apps/api: es de otro agente/ámbito.)
//
// La identidad que "inicia sesión" la decide el propio test antes de hacer
// clic, vía `POST /__control/next-identity` — un endpoint de control que
// solo existe en este doble, jamás en un IdP real.
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

function base64url(buffer) {
  return buffer.toString("base64url");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

/**
 * @returns {Promise<{ issuerUrl: string, controlUrl: string, close: () => Promise<void> }>}
 */
export async function startBrowserFakeOidcProvider() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = "fake-oidc-e2e-key-1";
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };

  /** Códigos de autorización pendientes de canje (un solo uso, como un IdP real). */
  const pendingCodes = new Map();

  /**
   * Identidad que devolverá el PRÓXIMO `/authorize`. El test la fija con
   * `POST /__control/next-identity`; sin fijarla, `/authorize` responde 409
   * en vez de inventar un usuario (nunca se inventan datos, ni en pruebas).
   */
  let nextIdentity = null;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => sendJson(res, 500, { error: "server_error", error_description: String(err) }));
  });

  function issuerUrl() {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake-oidc: servidor sin puerto asignado");
    return `http://127.0.0.1:${address.port}`;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "POST" && url.pathname === "/__control/next-identity") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.sub || !body.email) {
        sendJson(res, 400, { error: "invalid_request", error_description: "sub y email son obligatorios" });
        return;
      }
      nextIdentity = { sub: body.sub, email: body.email, emailVerified: body.emailVerified !== false };
      sendJson(res, 200, { ok: true, identity: nextIdentity });
      return;
    }

    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      const base = issuerUrl();
      sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/jwks") {
      sendJson(res, 200, { keys: [publicJwk] });
      return;
    }

    // Aquí aterriza el NAVEGADOR de verdad tras "Continuar con Google".
    // Un IdP real mostraría la pantalla de consentimiento; este doble
    // aprueba de inmediato con la identidad que el test fijó y redirige de
    // vuelta a `redirect_uri` (la SPA), igual que Google.
    if (req.method === "GET" && url.pathname === "/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const codeChallenge = url.searchParams.get("code_challenge");
      if (!redirectUri || !state || !nonce) {
        sendJson(res, 400, { error: "invalid_request", error_description: "faltan redirect_uri/state/nonce" });
        return;
      }
      if (!nextIdentity) {
        sendJson(res, 409, {
          error: "no_identity_configured",
          error_description: "El test debe fijar la identidad con POST /__control/next-identity antes de iniciar el flujo.",
        });
        return;
      }

      const code = `fake-code-${randomBytes(16).toString("hex")}`;
      pendingCodes.set(code, { claims: { ...nextIdentity, nonce, codeChallenge } });
      nextIdentity = null;

      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/token") {
      const params = new URLSearchParams(await readBody(req));
      const code = params.get("code");
      const pending = code ? pendingCodes.get(code) : undefined;
      if (!code || !pending) {
        sendJson(res, 400, { error: "invalid_grant", error_description: "code desconocido o ya utilizado" });
        return;
      }
      // Un solo uso: mismo criterio anti-replay que un IdP real.
      pendingCodes.delete(code);

      // PKCE S256 real: sin esto, la suite pasaría aunque apps/api dejara
      // de mandar el `code_verifier` correcto.
      if (pending.claims.codeChallenge) {
        const computed = base64url(createHash("sha256").update(params.get("code_verifier") ?? "").digest());
        if (computed !== pending.claims.codeChallenge) {
          sendJson(res, 400, { error: "invalid_grant", error_description: "code_verifier no coincide con code_challenge (PKCE)" });
          return;
        }
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        email: pending.claims.email,
        email_verified: pending.claims.emailVerified,
        nonce: pending.claims.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject(pending.claims.sub)
        .setIssuer(issuerUrl())
        .setAudience(params.get("client_id") ?? "")
        .setIssuedAt(nowSeconds)
        .setExpirationTime(nowSeconds + 300)
        .sign(privateKey);

      sendJson(res, 200, {
        access_token: `fake-access-token-${randomUUID()}`,
        token_type: "Bearer",
        expires_in: 3600,
        id_token: idToken,
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = issuerUrl();
  return {
    issuerUrl: base,
    controlUrl: `${base}/__control/next-identity`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
