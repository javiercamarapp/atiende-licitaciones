// REQ-044/064: helpers de step-up compartidos por ronda3-flujo-real.spec.ts
// y expediente-flujo-completo.spec.ts -- ambos aprueban ALGO (una tarifa,
// un expediente) con la MISMA cuenta `admin` del seed.
//
// El enrolamiento de 2FA ocurre UNA SOLA VEZ, en e2e/global-setup.ts (un
// único proceso Node), y el secreto TOTP queda persistido en
// `seed.json` -- NO en memoria de un test. Playwright puede reejecutar un
// test fallido en un worker COMPLETAMENTE NUEVO al reintentar (comportamiento
// documentado de Playwright), lo que perdería cualquier secreto guardado
// solo en memoria de un test o de un módulo compartido entre archivos de
// prueba; leer siempre de `seed.json` evita ese problema de raíz. Cada
// step-up recalcula un código TOTP VIGENTE en el momento de la llamada
// (nunca reutiliza uno ya usado) para que ni el rechazo de replay de
// apps/api ni un reintento de Playwright rompan el flujo.
import { generate as generateTotpCode } from "otplib";
import type { Page } from "@playwright/test";
import type { SeedData } from "./global-setup";

/** Código TOTP vigente en este instante para la cuenta `admin` del seed. */
export async function getAdminStepUpCode(seed: SeedData): Promise<string> {
  return generateTotpCode({ secret: seed.admin.twoFactor.secretBase32 });
}

/** Completa el modal de step-up (StepUpDialog, compartido por Aprobar tarifa y Aprobar expediente) con un código TOTP vigente. */
export async function completeStepUp(page: Page, code: string): Promise<void> {
  await page.getByLabel("Código TOTP o de respaldo").fill(code);
  await page.getByRole("button", { name: "Verificar y continuar" }).click();
}
