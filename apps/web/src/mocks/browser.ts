// Worker de MSW para el navegador (ronda 7, `/demo`). Importado SOLO por
// DemoPage.tsx (import dinámico, ver ese archivo) -- nunca por main.tsx ni
// por ningún otro punto de entrada, así que el resto de la aplicación
// (sesión real, datos reales) nunca corre bajo este worker.
import { setupWorker } from "msw/browser";

import { demoHandlers } from "./demoHandlers";

export const demoWorker = setupWorker(...demoHandlers);
