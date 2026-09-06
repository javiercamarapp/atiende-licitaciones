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
// prueba; leer siempre de `seed.json` evita ese problema de raíz.
//
// PROTECCIÓN DE REPLAY POR "TIME STEP" (apps/api/src/lib/step-up.ts): un
// código de un time step (ventana TOTP de 30s) MENOR O IGUAL al último
// aceptado para ese usuario se rechaza SIEMPRE -- incluso si sigue siendo
// válido según la tolerancia de otplib. La verificación de enrolamiento
// (`POST /auth/2fa/verify-enrollment`, en global-setup.ts) YA consume un
// time step; sin cuidado, el primer step-up real de la suite -- si cae en
// la MISMA ventana de 30s -- recibiría un 403 real de replay aunque el
// código sea "fresco" desde la perspectiva del cliente. `getAdminStepUpCode`
// evita esto: nunca entrega un código de un time step <= al de la
// verificación de enrolamiento NI <= al del último código que ella misma
// entregó en este proceso -- esperando al siguiente time step si hiciera
// falta.
import { generate as generateTotpCode } from "otplib";
import type { Page } from "@playwright/test";
import type { SeedData } from "./global-setup";

const TOTP_TIME_STEP_SECONDS = 30;

function timeStepOf(epochMs: number): number {
  return Math.floor(epochMs / 1000 / TOTP_TIME_STEP_SECONDS);
}

/** Último time step ya entregado por este helper en ESTE proceso (worker) -- ver protección de replay arriba. */
let lastIssuedTimeStep: number | null = null;

/**
 * Código TOTP vigente en este instante para la cuenta `admin` del seed,
 * garantizando que su time step sea ESTRICTAMENTE mayor al de la
 * verificación de enrolamiento y al del último código que este helper ya
 * entregó -- espera al siguiente time step (máx. 30s) si hiciera falta en
 * vez de arriesgar un 403 real de replay.
 */
export async function getAdminStepUpCode(seed: SeedData): Promise<string> {
  const forbiddenTimeStep = Math.max(timeStepOf(seed.admin.twoFactor.enrolledAtMs), lastIssuedTimeStep ?? -Infinity);

  let currentStep = timeStepOf(Date.now());
  while (currentStep <= forbiddenTimeStep) {
    const msUntilNextStep = TOTP_TIME_STEP_SECONDS * 1000 - (Date.now() % (TOTP_TIME_STEP_SECONDS * 1000)) + 50;
    await new Promise((resolve) => setTimeout(resolve, msUntilNextStep));
    currentStep = timeStepOf(Date.now());
  }

  lastIssuedTimeStep = currentStep;
  return generateTotpCode({ secret: seed.admin.twoFactor.secretBase32 });
}

/** Completa el modal de step-up (StepUpDialog, compartido por Aprobar tarifa y Aprobar expediente) con un código TOTP vigente. */
export async function completeStepUp(page: Page, code: string): Promise<void> {
  await page.getByLabel("Código TOTP o de respaldo").fill(code);
  await page.getByRole("button", { name: "Verificar y continuar" }).click();
}
