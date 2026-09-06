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

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<{ app: FastifyInstance; db: DbClient }> {
  const db = await createPgliteClient();
  const config: AppConfig = {
    ...loadConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      NODE_ENV: 'test',
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'atiende-api-test-storage-')),
      PLATFORM_API_KEY: TEST_PLATFORM_API_KEY,
      TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY,
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

  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  if (login.statusCode !== 200) {
    throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  }
  const { accessToken, refreshToken } = login.json();
  return { email, password, accessToken, refreshToken, id };
}

/**
 * REQ-044/064: enrola 2FA (TOTP) para `accessToken` y devuelve un
 * `stepUpToken` VIGENTE (emitido por `verify-enrollment`, ver
 * `modules/twofa/routes.ts`) listo para usarse como encabezado
 * `X-Step-Up` en `POST .../approval/approve` o `POST .../rates/:id/approve`.
 */
export async function enrollTwoFactor(app: FastifyInstance, accessToken: string): Promise<{ secretBase32: string; stepUpToken: string }> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
  if (enroll.statusCode !== 201) {
    throw new Error(`2fa enroll failed: ${enroll.statusCode} ${enroll.body}`);
  }
  const { secretBase32 } = enroll.json();
  const code = await generateTotpCodeForTesting(secretBase32);
  const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code } });
  if (verify.statusCode !== 200) {
    throw new Error(`2fa verify-enrollment failed: ${verify.statusCode} ${verify.body}`);
  }
  return { secretBase32, stepUpToken: verify.json().stepUpToken };
}

/**
 * R5-05: variante de {@link enrollTwoFactor} que además devuelve los
 * `backupCodes` emitidos -- útiles para pedir MÁS de un `stepUpToken`
 * independiente para el mismo usuario dentro de un mismo test sin chocar
 * con el rechazo de replay de TOTP (un código de respaldo es de un solo
 * uso real, así que cada llamada a `stepUpWithCode` con un código distinto
 * produce una sesión nueva).
 */
export async function enrollTwoFactorFull(app: FastifyInstance, accessToken: string): Promise<{ secretBase32: string; backupCodes: string[]; stepUpToken: string }> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const enroll = await app.inject({ method: 'POST', url: '/auth/2fa/enroll', headers });
  if (enroll.statusCode !== 201) {
    throw new Error(`2fa enroll failed: ${enroll.statusCode} ${enroll.body}`);
  }
  const { secretBase32, backupCodes } = enroll.json();
  const code = await generateTotpCodeForTesting(secretBase32);
  const verify = await app.inject({ method: 'POST', url: '/auth/2fa/verify-enrollment', headers, payload: { code } });
  if (verify.statusCode !== 200) {
    throw new Error(`2fa verify-enrollment failed: ${verify.statusCode} ${verify.body}`);
  }
  return { secretBase32, backupCodes, stepUpToken: verify.json().stepUpToken };
}

/**
 * R5-05: pide un `stepUpToken` nuevo vía `POST /auth/2fa/step-up` usando un
 * código de RESPALDO (evita el rechazo de replay de un TOTP recién usado),
 * con `purpose`/`X-Org-Id` opcionales para atar la sesión resultante a una
 * acción/organización concreta (ver `lib/step-up.ts`).
 */
export async function stepUpWithBackupCode(
  app: FastifyInstance,
  accessToken: string,
  backupCode: string,
  opts: { purpose?: string; orgId?: string } = {}
): Promise<string> {
  const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
  if (opts.orgId) headers['x-org-id'] = opts.orgId;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/2fa/step-up',
    headers,
    payload: { code: backupCode, ...(opts.purpose ? { purpose: opts.purpose } : {}) },
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
