// REQ-044/064: helpers de 2FA/step-up compartidos por ronda3-flujo-real.spec.ts
// y expediente-flujo-completo.spec.ts -- ambos aprueban ALGO (una tarifa,
// un expediente) con la MISMA cuenta `admin` del seed. El enrolamiento de
// TOTP es de CUENTA, no de organización (ver
// apps/api/src/modules/twofa/routes.ts): apps/api rechaza un segundo
// enrolamiento con 409 mientras el primero siga vigente, así que esta
// cuenta solo puede enrolarse UNA vez por corrida de la suite completa
// (modo "full" fuerza `workers: 1`, ver playwright.config.ts -- todos los
// spec files de un mismo worker comparten el módulo de Node, así que este
// caché en memoria sobrevive entre archivos de prueba distintos dentro de
// la misma corrida).
import { generate as generateTotpCode } from "otplib";
import { expect, type Page } from "@playwright/test";

let cachedSecret: string | null = null;
let cachedBackupCodes: string[] = [];
let backupCodeCursor = 0;

/**
 * Enrola 2FA para `admin` si ningún spec de este worker lo hizo ya.
 * Idempotente: una segunda llamada (desde otro archivo/test) es un no-op
 * inmediato una vez que el secreto ya está cacheado.
 */
export async function ensureAdminTwoFactorEnrolled(page: Page): Promise<void> {
  if (cachedSecret) return;

  await page.goto("/configuracion");
  const alreadyEnrolledBadge = page.getByText("Enrolado", { exact: true });
  if (await alreadyEnrolledBadge.isVisible().catch(() => false)) {
    throw new Error(
      "La cuenta admin ya tiene 2FA enrolado pero este worker no cacheó su secreto/códigos de respaldo -- " +
        "algún test enroló por fuera de ensureAdminTwoFactorEnrolled(). Usa siempre este helper para aprobar con step-up.",
    );
  }

  await page.getByRole("button", { name: "Enrolar 2FA" }).click();
  const secret = (await page.locator('[aria-label="Secreto TOTP"]').textContent())?.trim();
  if (!secret) throw new Error("No se pudo leer el secreto TOTP recién generado en Configuración.");
  const backupCodes = await page.locator('[aria-label="Códigos de respaldo"] li').allTextContents();
  if (backupCodes.length === 0) throw new Error("No se pudieron leer los códigos de respaldo mostrados al enrolar.");

  const code = await generateTotpCode({ secret });
  await page.getByLabel("Código de 6 dígitos").fill(code);
  await page.getByRole("button", { name: "Confirmar enrolamiento" }).click();
  // `exact: true` -- sin esto también matchea el toast "2FA enrolado y
  // verificado..." (violación de "strict mode" real, no solo cosmética).
  await expect(page.getByText("Enrolado", { exact: true })).toBeVisible();

  cachedSecret = secret;
  cachedBackupCodes = backupCodes.map((c) => c.trim());
  backupCodeCursor = 0;
}

/** Un código de respaldo NUEVO (de un solo uso real) para el próximo step-up de `admin`. */
export function nextAdminBackupCode(): string {
  if (backupCodeCursor >= cachedBackupCodes.length) {
    throw new Error(`Se agotaron los ${cachedBackupCodes.length} códigos de respaldo cacheados de admin en este worker.`);
  }
  const code = cachedBackupCodes[backupCodeCursor];
  backupCodeCursor += 1;
  return code;
}

/** Completa el modal de step-up (StepUpDialog, compartido por Aprobar tarifa y Aprobar expediente) con un código de respaldo de un solo uso. */
export async function completeStepUp(page: Page, backupCode: string): Promise<void> {
  await page.getByLabel("Código TOTP o de respaldo").fill(backupCode);
  await page.getByRole("button", { name: "Verificar y continuar" }).click();
}
