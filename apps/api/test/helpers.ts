import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteClient } from '@atiende/db';
import type { DbClient } from '@atiende/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-production-01234567890';
export const TEST_PLATFORM_API_KEY = 'test-platform-api-key-01234567890';

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<{ app: FastifyInstance; db: DbClient }> {
  const db = await createPgliteClient();
  const config: AppConfig = {
    ...loadConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      NODE_ENV: 'test',
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'atiende-api-test-storage-')),
      PLATFORM_API_KEY: TEST_PLATFORM_API_KEY,
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
