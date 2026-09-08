import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteClient } from '@atiende/db';
import type { DbClient } from '@atiende/db';
import type { FastifyInstance } from 'fastify';
import type { MailProvider } from '@atiende/mail';
import type { WhatsAppProvider } from '@atiende/whatsapp';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { generateTotpCodeForTesting } from '../src/lib/step-up.js';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-production-01234567890';
export const TEST_PLATFORM_API_KEY = 'test-platform-api-key-01234567890';
export const TEST_TOTP_ENCRYPTION_KEY = 'test-totp-encryption-key-do-not-use-01234567890';
// REQ-181..195: secreto de enlaces firmados de correo (verificación,
// invitación, restablecimiento de contraseña, baja de un clic) -- ver
// lib/mail/env.ts. `MAIL_PROVIDER` NO se fija aquí a propósito: cada
// suite decide (por defecto ninguna variable -> CaptureProvider, ver
// createMailProviderFromEnv).
export const TEST_MAIL_LINK_SECRET = 'test-mail-link-secret-do-not-use-01234567890';

export interface CreateTestAppOptions {
  /**
   * REQ-181..195: `MailProvider` explícito. Sin él se usa el que resuelve
   * `MAIL_PROVIDER` -- que ninguna suite define, así que es siempre el
   * `CaptureProvider` (nada sale a la red). Solo las pruebas que ejercen el
   * camino de FALLO del proveedor (reintentos agotados -> job `mail_retry`)
   * necesitan uno propio.
   */
  mailProvider?: MailProvider;
  /** Canal ADICIONAL de WhatsApp: `WhatsAppProvider` explícito -- mismo criterio que `mailProvider` (sin él, `CaptureProvider`, nunca sale a la red). */
  whatsappProvider?: WhatsAppProvider;
}

export async function createTestApp(
  overrides: Partial<AppConfig> = {},
  options: CreateTestAppOptions = {}
): Promise<{ app: FastifyInstance; db: DbClient }> {
  const db = await createPgliteClient();
  const config: AppConfig = {
    ...loadConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      NODE_ENV: 'test',
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'atiende-api-test-storage-')),
      PLATFORM_API_KEY: TEST_PLATFORM_API_KEY,
      TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY,
      MAIL_LINK_SECRET: TEST_MAIL_LINK_SECRET,
    }),
    port: 0,
    databaseUrl: undefined,
    autoMigrate: true,
    ...overrides,
  };
  const app = await buildApp({ db, config, logger: false, mailProvider: options.mailProvider, whatsappProvider: options.whatsappProvider });
  await app.ready();
  return { app, db };
}

export interface RegisteredUser {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  id: string;
}

export async function registerAndLogin(
  app: FastifyInstance,
  email: string,
  password = 'super-secret-password'
): Promise<RegisteredUser> {
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
  if (reg.statusCode !== 201) {
    throw new Error(`register failed: ${reg.statusCode} ${reg.body}`);
  }
  const { id } = reg.json();

  // REQ-181..195: el login por email+contraseña ahora exige
  // `email_verified_at` (ver modules/auth/routes.ts) -- este helper es
  // compartido por CIENTOS de pruebas de todo apps/api que no ejercen el
  // flujo de verificación de correo en sí (eso lo cubre
  // test/mail-email-verification.test.ts aparte), así que se marca
  // verificado directamente en la base de datos (como propietario de las
  // migraciones, sin pasar por RLS) para no acoplar cada test existente al
  // flujo completo de verificación.
  await app.db.query('update users set email_verified_at = now() where id = $1', [id]);

  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const { accessToken, refreshToken } = login.json();
  return { email, password, accessToken, refreshToken, id };
}

/**
 * R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md): `orgId`/`purpose`
 * son OBLIGATORIOS para crear cualquier sesión de step-up (`X-Org-Id` +
 * `purpose`, enum cerrado -- ver `lib/step-up.ts#STEP_UP_PURPOSES`); ya no
 * existe una sesión "genérica". Mismos valores usados en todo el resto de
 * `apps/api` (`company/routes.ts`, `expediente/approval.routes.ts`).
 */
export type TestStepUpPurpose =
  | 'company.rate_approval'
  | 'expediente.approval'
  | 'tool_call.approval'
  | 'admin.action'
  | 'expediente.contract_transition'
  | 'expediente.inconformidad_review'
  | 'twofa.disable'
  | 'twofa.backup_codes_regenerate'
  | 'auth.password_change'
  | 'auth.google_unlink';

export interface StepUpScope {
  orgId: string;
  purpose: TestStepUpPurpose;
}

/**
 * R6-13 (docs/auditoria-2/api-ronda6-reverificacion.md, MEDIA): la suite
 * completa de `apps/api` resultó intermitente por un flake de reloj aquí --
 * `generateTotpCodeForTesting` calcula el código en el reloj de pared T y
 * el servidor lo verifica en T+Δ; `verifyTotpCode` (`lib/step-up.ts`) no da
 * NINGUNA tolerancia de ventana (`otplib.verify` sin `epochTolerance`), así
 * que si Δ cruza el límite de 30s del `timeStep` (plausible bajo la suite
 * completa corriendo en paralelo, 285-388s medidos), el código deja de ser
 * válido y el servidor responde 403 con un mensaje AMBIGUO ("inválido O ya
 * utilizado"). El usuario de esta función es SIEMPRE nuevo y verifica una
 * sola vez -- nunca es un replay real, así que el único motivo posible de
 * ese 403 es el borde de ventana. Se reintenta UNA vez con un código
 * RECIÉN generado (nunca se reutiliza el que ya falló, que seguiría siendo
 * inválido) -- si el segundo intento también falla, se propaga el error
 * real tal cual, nunca se oculta ni se reintenta sin límite. No se fija el
 * reloj (`vi.setSystemTime`) porque `enrollTwoFactor`/`enrollTwoFactorFull`
 * son helpers de integración compartidos por decenas de tests fuera de
 * este archivo, que sí dependen del reloj real para JWT/expiración de
 * sesiones; regenerar el código es más simple y no tiene ese riesgo.
 */
async function verifyTotpEnrollment(
  app: FastifyInstance,
  headers: Record<string, string>,
  secretBase32: string,
  purpose: TestStepUpPurpose
): Promise<{ stepUpToken: string }> {
  let lastFailure: { statusCode: number; body: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const code = await generateTotpCodeForTesting(secretBase32);
    const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code, purpose } });
    if (verify.statusCode === 200) {
      return { stepUpToken: verify.json().stepUpToken };
    }
    lastFailure = { statusCode: verify.statusCode, body: verify.body };
  }
  throw new Error(`2fa verify-enrollment failed: ${lastFailure!.statusCode} ${lastFailure!.body}`);
}

/**
 * REQ-044/064: enrola 2FA (TOTP) para `accessToken` y devuelve un
 * `stepUpToken` VIGENTE (emitido por `verify-enrollment`, ver
 * `modules/twofa/routes.ts`), atado a `scope.orgId`/`scope.purpose`
 * (R5-09, ambos obligatorios), listo para usarse como encabezado
 * `X-Step-Up` en la acción correspondiente. R5-09: la sesión es de UN SOLO
 * USO -- solo sirve para UNA acción; pida una sesión nueva por cada
 * acción que deba autorizar (ver {@link enrollTwoFactorFull}/
 * {@link stepUpWithBackupCode} para pedir sesiones adicionales del mismo
 * usuario sin volver a enrolar).
 */
export async function enrollTwoFactor(
  app: FastifyInstance,
  accessToken: string,
  scope: StepUpScope
): Promise<{ secretBase32: string; stepUpToken: string }> {
  const headers = { authorization: `Bearer ${accessToken}`, 'x-org-id': scope.orgId };
  const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
  if (enroll.statusCode !== 201) {
    throw new Error(`2fa enroll failed: ${enroll.statusCode} ${enroll.body}`);
  }
  const { secretBase32 } = enroll.json();
  const { stepUpToken } = await verifyTotpEnrollment(app, headers, secretBase32, scope.purpose);
  return { secretBase32, stepUpToken };
}

/**
 * Variante de {@link enrollTwoFactor} que además devuelve los
 * `backupCodes` emitidos -- útiles para pedir MÁS de un `stepUpToken`
 * independiente para el mismo usuario dentro de un mismo test sin chocar
 * con el rechazo de replay de TOTP (un código de respaldo es de un solo
 * uso real, así que cada llamada a {@link stepUpWithBackupCode} con un
 * código distinto produce una sesión nueva) -- necesario porque, desde
 * R5-09, cada sesión de step-up es de un solo uso.
 */
export async function enrollTwoFactorFull(
  app: FastifyInstance,
  accessToken: string,
  scope: StepUpScope
): Promise<{ secretBase32: string; backupCodes: string[]; stepUpToken: string }> {
  const headers = { authorization: `Bearer ${accessToken}`, 'x-org-id': scope.orgId };
  const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
  if (enroll.statusCode !== 201) {
    throw new Error(`2fa enroll failed: ${enroll.statusCode} ${enroll.body}`);
  }
  const { secretBase32, backupCodes } = enroll.json();
  const { stepUpToken } = await verifyTotpEnrollment(app, headers, secretBase32, scope.purpose);
  return { secretBase32, backupCodes, stepUpToken };
}

/**
 * Pide un `stepUpToken` nuevo vía `POST /auth/2fa/step-up` usando un
 * código de RESPALDO (evita el rechazo de replay de un TOTP recién usado),
 * atado a `scope.orgId`/`scope.purpose` (R5-09, ambos obligatorios).
 */
export async function stepUpWithBackupCode(app: FastifyInstance, accessToken: string, backupCode: string, scope: StepUpScope): Promise<string> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, 'x-org-id': scope.orgId };
  const res = await app.inject({
    method: 'POST',
    url: '/auth/2fa/step-up',
    headers,
    payload: { code: backupCode, purpose: scope.purpose },
  });
  if (res.statusCode !== 201) {
    throw new Error(`2fa step-up failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().stepUpToken;
}

export async function createOrgFor(
  app: FastifyInstance,
  user: RegisteredUser,
  name: string,
  slug: string
): Promise<{ id: string; name: string; slug: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/organizations',
    headers: { authorization: `Bearer ${user.accessToken}` },
    payload: { name, slug },
  });
  if (res.statusCode !== 201) {
    throw new Error(`create org failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}
