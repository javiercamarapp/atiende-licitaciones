// Handlers de MSW para la demo pública (ronda 7, `/demo`). Namespace propio
// `/demo-api/*` (nunca las rutas reales `/tenders`, `/matching`, etc.) para
// que sea IMPOSIBLE que estos mocks intercepten por accidente una petición
// real del resto de la aplicación (que usa `lib/api/client.ts` con
// `VITE_API_URL`, nunca rutas bajo `/demo-api`). Ver mocks/browser.ts, que
// solo arranca este worker mientras `/demo` está montada.
import { http, HttpResponse } from "msw";

import { DEMO_ORG, DEMO_TENDERS, DEMO_MATCHES, DEMO_POST_AWARD_ALERTS, DEMO_AUDIT_LOG } from "./demoFixtures";

export const demoHandlers = [
  http.get("/demo-api/organization", () => HttpResponse.json(DEMO_ORG)),
  http.get("/demo-api/tenders", () => HttpResponse.json({ items: DEMO_TENDERS, nextCursor: null })),
  http.get("/demo-api/matching", () => HttpResponse.json({ items: DEMO_MATCHES })),
  http.get("/demo-api/post-award-alerts", () => HttpResponse.json(DEMO_POST_AWARD_ALERTS)),
  http.get("/demo-api/audit-log", () => HttpResponse.json({ items: DEMO_AUDIT_LOG, nextCursor: null })),
];
