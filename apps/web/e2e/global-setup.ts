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
  /**
   * Ronda 5 (e2e/expediente-flujo-completo.spec.ts): organización DEDICADA
   * a la suite del expediente completo (bases→matriz→propuesta→checklist→
   * revisión→paquete), con una convocatoria real ya sembrada. Aislada de
   * orgA/orgB a propósito: ronda3-flujo-real.spec.ts asume que `writer` ve
   * "Aún no hay convocatorias" en orgA, y recorrido.spec.ts asume que el
   * paquete de la organización por defecto de `admin` (orgA) arranca sin
   * ninguna convocatoria seleccionable -- sembrar la convocatoria en una
   * organización nueva evita romper esos supuestos ya probados.
   */
  orgC: { id: string; name: string; slug: string };
  /** `null` si `PLATFORM_API_KEY` no está configurada (ver e2e-full.mjs) -- en ese caso expediente-flujo-completo.spec.ts se salta entero. */
  tender: { id: string; title: string } | null;
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

  // Ronda 5: organización C, dedicada al flujo completo del expediente.
  // `writer` reutiliza el login/tokens ya obtenidos arriba -- no cuenta
  // como una tercera llamada a `POST /auth/login` (5/min por IP, ver
  // e2e/fixtures.ts).
  const orgC = await client.createOrganization(adminTokens.accessToken, `E2E Org C ${runId}`, `e2e-org-c-${runId}`);
  const invitationC = await client.inviteMember(adminTokens.accessToken, orgC.id, writer.email, "writer");
  await client.acceptInvitation(writerTokens.accessToken, invitationC.token);

  const platformApiKey = process.env.PLATFORM_API_KEY;
  let tender: SeedData["tender"] = null;
  if (platformApiKey) {
    const now = Date.now();
    const submissionDeadline = new Date(now + 60 * 24 * 60 * 60 * 1000).toISOString(); // +60 días
    // Posterior al 17-abr-2025 (vigor LAASSP nueva Art. 73, ver
    // docs/legal/verificacion-legal.md REQ-105/REQ-050) para que el
    // seguimiento post-adjudicación de tipo "pago" use el régimen de 17
    // días hábiles, no el abrogado.
    const publishedAt = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const ingestResult = await client.ingestTender(platformApiKey, orgC.id, {
      title: `Convocatoria E2E ${runId}`,
      submissionDeadline,
      publishedAt,
    });
    tender = { id: ingestResult.tenderId, title: `Convocatoria E2E ${runId}` };
  }

  const seed: SeedData = { apiUrl, admin, writer, orgA, orgB, orgC, tender };
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "seed.json"), JSON.stringify(seed, null, 2));
}
