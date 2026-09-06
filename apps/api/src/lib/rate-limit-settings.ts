import type { AppConfig } from '../config.js';

export interface RateLimitTier {
  max: number;
  timeWindow: string;
}

/**
 * Ronda 4 (docs/logs/api-ronda4.log): centraliza los límites de tasa reales
 * por "tier" en vez de números mágicos repartidos entre `app.ts` y cada
 * módulo de rutas.
 *
 *  - `global`: límite base por IP (protección anti-abuso general, `onRequest`
 *    -- antes de cualquier autenticación, así que solo puede depender de la
 *    IP, nunca de `X-Org-Id`/`Authorization` sin verificar: un atacante
 *    podría rotar esos valores libremente para esquivar el límite si se
 *    usaran como clave aquí).
 *  - `auth`: límite específico de `/auth/login` (anti fuerza bruta), más
 *    estricto que el global -- sin cambios de fondo respecto a rondas
 *    anteriores, solo ahora también escalable por perfil.
 *  - `sensitiveAction`: límite de acciones de aprobación/decisión
 *    (`/agents/tool-calls/:id/approve|deny`, `/admin/tool-calls/:id/approve|deny`)
 *    aplicado en el hook `preHandler` (DESPUÉS de `app.authenticate`/
 *    `app.requireOrg`/`app.requireSuperadmin`), así que su `keyGenerator`
 *    SÍ puede usar `request.orgId`/`request.userId` ya verificados --
 *    aislando el "presupuesto" de una organización (o de un superadmin) del
 *    de las demás, en vez de compartir el balde global por IP.
 */
export interface RateLimitSettings {
  global: RateLimitTier;
  auth: RateLimitTier;
  sensitiveAction: RateLimitTier;
}

const DEFAULT_SETTINGS: RateLimitSettings = {
  // 100/min (ronda 1-3) resultó demasiado ajustado para un back office real
  // que dispara varias peticiones de lectura por pantalla (memberships,
  // tenders, matching, agentes...) en menos de un minuto -- ver hallazgo de
  // apps/web (docs/logs/web-ronda3.log) sobre 429 durante navegación normal.
  global: { max: 300, timeWindow: '1 minute' },
  auth: { max: 5, timeWindow: '1 minute' },
  sensitiveAction: { max: 30, timeWindow: '1 minute' },
};

// Solo activo con RATE_LIMIT_PROFILE=e2e (ver config.ts). Órdenes de
// magnitud mayores a propósito: existe únicamente para que una suite E2E
// intensiva (Playwright con múltiples workers/logins) no confunda su propio
// volumen de tráfico con un fallo de producto real.
const E2E_SETTINGS: RateLimitSettings = {
  global: { max: 3000, timeWindow: '1 minute' },
  auth: { max: 300, timeWindow: '1 minute' },
  sensitiveAction: { max: 1000, timeWindow: '1 minute' },
};

export function getRateLimitSettings(profile: AppConfig['rateLimitProfile']): RateLimitSettings {
  return profile === 'e2e' ? E2E_SETTINGS : DEFAULT_SETTINGS;
}
