import { defineConfig, devices } from "@playwright/test";

// Suite E2E real (Playwright + axe-core sobre el navegador, no jsdom) exigida
// por REQ-049/REQ-065. Sirve el build de producción con `vite preview` — el
// mismo artefacto que llegaría a producción, no el servidor de desarrollo.
const PORT = 4173;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
