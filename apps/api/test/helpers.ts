import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteClient } from '@atiende/db';
import type { DbClient } from '@atiende/db';
import type { FastifyInstance } from 'fastify';
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

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<{ app: FastifyInstance; db: DbClient }> {
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
  const app = await buildApp({ db, config, logger: false });
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
  | 'expediente.inconformidad_review';

export interface StepUpScope {
  orgId: string;
  purpose: TestStepUpPurpose;
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
  const code = await generateTotpCodeForTesting(secretBase32);
  const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code, purpose: scope.purpose } });
  if (verify.statusCode !== 200) {
    throw new Error(`2fa verify-enrollment failed: ${verify.statusCode} ${verify.body}`);
  }
  return { secretBase32, stepUpToken: verify.json().stepUpToken };
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
  const code = await generateTotpCodeForTesting(secretBase32);
  const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code, purpose: scope.purpose } });
  if (verify.statusCode !== 200) {
    throw new Error(`2fa verify-enrollment failed: ${verify.statusCode} ${verify.body}`);
  }
  return { secretBase32, backupCodes, stepUpToken: verify.json().stepUpToken };
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
