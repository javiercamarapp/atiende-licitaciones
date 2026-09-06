// Servidor MSW compartido para pruebas de componente/hook que necesitan
// simular respuestas reales de apps/api (éxito, 401→refresh→reintento, 403,
// 500 con request_id, red caída) sin levantar un backend real. La
// suite E2E (e2e/*.spec.ts) es la que corre contra la API real — MSW se usa
// SOLO aquí, en pruebas unitarias/de componente (ver docs/PROGRESO.md,
// "MSW solo en tests").
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export const server = setupServer();
export { http, HttpResponse };
