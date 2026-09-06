import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createSeedClient } from "./seed-client";

// ESM real ("type": "module" en package.json): sin `__dirname` global.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Seed mínimo de la suite E2E "contra la API real" (ver
 * docs/REQUISITOS.md, tarea de ronda 3): dos organizaciones y dos usuarios
 * creados llamando a la propia apps/api (nunca insertados directo en la
 * base ni hardcodeados en el frontend) —
 *   - `admin`: owner de AMBAS organizaciones (org A y org B), para poder
 *     probar el selector de organización real y aprobar tarifas/tool_calls.
 *   - `writer`: solo miembro de la organización A, con rol `writer` (puede
 *     proponer tarifas pero no aprobarlas ni entrar a /backoffice/*
 *     — demuestra el 403 honesto de superadmin).
 *
 * Solo corre cuando `E2E_API_URL` está definida (ver
 * apps/web/scripts/e2e-full.mjs, que arranca apps/api real antes de
 * invocar Playwright). Sin esa variable, `npm run test:e2e` sigue
 * funcionando como suite "unauthenticated" limitada (ver playwright.config.ts).
 *
 * IMPORTANTE (evita el problema real que tuvo la primera versión de este
 * archivo): este seed YA NO inicia sesión por UI ni guarda ningún
 * `storageState` — `refresh_tokens` es de un solo uso con rotación real
 * (apps/api/src/modules/auth/routes.ts): si dos contextos de navegador
 * distintos reutilizaran el MISMO refresh token guardado en un archivo
 * estático, el primero en usarlo lo rota y el segundo recibe 401. La
 * autenticación real de cada test la resuelve `e2e/fixtures.ts` (login
 * fresco, una vez por worker, inyectado vía `addInitScript` en un contexto
 * de navegador compartido por ese worker) — este archivo solo crea el
 * seed y expone las credenciales en `seed.json`.
 */
const ARTIFACTS_DIR = path.resolve(__dirname, ".artifacts");

export interface SeedData {
  apiUrl: string;
  admin: { email: string; password: string };
  writer: { email: string; password: string };
  orgA: { id: string; name: string; slug: string };
  orgB: { id: string; name: string; slug: string };
}

export default async function globalSetup(): Promise<void> {
  const apiUrl = process.env.E2E_API_URL;
  if (!apiUrl) {
    // Suite "sin API" (ver playwright.config.ts): no hay nada que sembrar.
    return;
  }

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const client = createSeedClient(apiUrl);
  await client.waitForHealthz(30_000);

  const runId = Date.now().toString(36);
  const password = "ContraseñaSeguraE2E123";
  const admin = { email: `e2e-admin-${runId}@atiende.test`, password };
  const writer = { email: `e2e-writer-${runId}@atiende.test`, password };

  await client.register(admin.email, admin.password);
  await client.register(writer.email, writer.password);

  const adminTokens = await client.login(admin.email, admin.password);
  const orgA = await client.createOrganization(adminTokens.accessToken, `E2E Org A ${runId}`, `e2e-org-a-${runId}`);
  const orgB = await client.createOrganization(adminTokens.accessToken, `E2E Org B ${runId}`, `e2e-org-b-${runId}`);

  const invitation = await client.inviteMember(adminTokens.accessToken, orgA.id, writer.email, "writer");
  const writerTokens = await client.login(writer.email, writer.password);
  await client.acceptInvitation(writerTokens.accessToken, invitation.token);

  const seed: SeedData = { apiUrl, admin, writer, orgA, orgB };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "seed.json"), JSON.stringify(seed, null, 2));
}
