#!/usr/bin/env node
// IN-01 (docs/auditoria-2/infra.md): `infra/compose/docker-compose.prod.yml`
// llegó a omitir variables reales que `apps/api`/`apps/worker` (y los
// paquetes que importan, `@atiende/mail`/`@atiende/whatsapp`) leen del
// entorno -- una de ellas (`MAIL_LINK_SECRET`) era obligatoria: la API no
// arrancaba. Este script cierra esa brecha de forma DURADERA (no solo para
// esta ronda): extrae, por LECTURA ESTÁTICA del código fuente real (nunca
// de documentación, que puede quedar desactualizada -- ver IN-08/IN-03),
// qué variables de entorno lee cada servicio, y falla si alguna no está
// declarada en el `environment:` de ese servicio en
// `infra/compose/docker-compose.prod.yml` o en `infra/env/.env.prod.example`
// (el archivo que documenta TODAS las variables para un operador humano).
//
// Uso:
//   node infra/scripts/check-env-parity.mjs
//
// Sale con código != 0 (y detalla exactamente qué falta y dónde) si hay
// divergencia. Pensado para correr en `scripts/ci-local.sh` y, a futuro,
// en CI -- ver docs/auditoria-2/infra.md IN-01.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const COMPOSE_PATH = join(REPO_ROOT, 'infra', 'compose', 'docker-compose.prod.yml');
const ENV_EXAMPLE_PATH = join(REPO_ROOT, 'infra', 'env', '.env.prod.example');

// ---------------------------------------------------------------------------
// 1. Qué variables lee CADA SERVICIO, por lectura estática de su código
//    fuente real (nunca de documentación).
// ---------------------------------------------------------------------------

/**
 * Directorios de código fuente que corren DENTRO del proceso de cada
 * servicio en producción (ver los `Dockerfile` respectivos: ambos copian
 * exactamente estos paquetes, ver `apps/api/Dockerfile`/`apps/worker/Dockerfile`).
 * `apps/worker` NO importa `@atiende/whatsapp` (solo `apps/api` lo hace,
 * ver `apps/api/src/lib/mail/whatsapp-channel.ts`) -- confirmado por
 * `grep -r createWhatsAppProviderFromEnv apps/`.
 */
// Bug real encontrado y corregido (10-sep-2026, ver docs/BLOQUEOS.md): este
// script nunca escaneaba `packages/db/src`, así que no detectaba que
// `createDbClientFromEnv` (D-11, commit e121b54) lee DATABASE_URL_NO_SSL /
// DATABASE_URL_POOL_MAX -- docker-compose.prod.yml nunca fijó
// DATABASE_URL_NO_SSL para `api`/`worker` y ambos revientan en cada query
// real contra el propio Postgres del compose (sin TLS) con "The server does
// not support SSL connections" (confirmado en vivo contra postgres:16-alpine
// real). Corregido fijando DATABASE_URL_NO_SSL="true" en los tres servicios
// que hablan con ese Postgres (`migrate`/`api`/`worker`) y agregando
// `packages/db/src` aquí para que esta clase de regresión no vuelva a pasar
// inadvertida.
const DB_DRIVER_ALLOW_MISSING = new Set([
  // DATABASE_URL_POOL_MAX: tiene un default seguro en código (3,
  // deliberadamente bajo para serverless -- ver packages/db/src/driver.ts) y
  // el valor por defecto también es correcto para este compose de un único
  // proceso por servicio; no hace falta que un operador la complete.
  'DATABASE_URL_POOL_MAX',
]);

const SERVICES = {
  api: {
    sourceDirs: ['apps/api/src', 'packages/mail/src', 'packages/whatsapp/src', 'packages/db/src'],
    composeServiceName: 'api',
    // Exclusiones deliberadas -- cualquier otra variable que el código real
    // lea debe estar en el compose Y en el .env.prod.example:
    // - OIDC_ISSUER_URL: NUNCA debe definirse en el compose de producción
    //   (decisión de diseño explícita, ver apps/api/src/modules/auth/google/env.ts
    //   y apps/api/.env.example: "NUNCA definir esta variable en producción").
    //   Sin ella, `loadGoogleOidcEnv` usa el default seguro (Google real).
    // - DATABASE_URL_POOL_MAX: ver DB_DRIVER_ALLOW_MISSING arriba.
    allowMissing: new Set(['OIDC_ISSUER_URL', ...DB_DRIVER_ALLOW_MISSING]),
  },
  worker: {
    sourceDirs: ['apps/worker/src', 'packages/mail/src', 'packages/db/src'],
    composeServiceName: 'worker',
    allowMissing: new Set([...DB_DRIVER_ALLOW_MISSING]),
  },
};

const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', 'dist', 'coverage', 'test', 'e2e', '.git']);

/** Patrones de acceso a variables de entorno reconocidos en este código. */
const VAR_ACCESS_PATTERNS = [
  // env.VARIABLE / process.env.VARIABLE
  /\b(?:process\.)?env\.([A-Z][A-Z0-9_]*)\b/g,
  // env['VARIABLE'] / env["VARIABLE"]
  /\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  // num(env, 'VARIABLE', fallback) -- helper de apps/worker/src/config.ts
  /\bnum\(\s*env\s*,\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
];

function listTsFiles(absDir) {
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (EXCLUDED_DIR_SEGMENTS.has(entry)) continue;
    const abs = join(absDir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      files.push(...listTsFiles(abs));
    } else if (
      extname(entry) === '.ts' &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      files.push(abs);
    }
  }
  return files;
}

function extractEnvVarsFromSource(relDirs) {
  const vars = new Set();
  for (const relDir of relDirs) {
    const absDir = join(REPO_ROOT, relDir);
    for (const file of listTsFiles(absDir)) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of VAR_ACCESS_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          vars.add(match[1]);
        }
      }
    }
  }
  return vars;
}

// ---------------------------------------------------------------------------
// 2. Qué variables declara REALMENTE cada servicio en
//    infra/compose/docker-compose.prod.yml (`environment:`), por un parser
//    de indentación minimalista -- suficiente para el estilo de mapeo plano
//    (`CLAVE: valor`) que usa este archivo concreto, sin depender de una
//    librería YAML de terceros que podría no estar instalada como
//    dependencia directa (ver package-lock.json: `yaml`/`js-yaml` son
//    transitivas de otros workspaces, no una dependencia propia de
//    infra/**).
// ---------------------------------------------------------------------------

function leadingSpaces(line) {
  return line.match(/^ */)[0].length;
}

/** Devuelve { [nombreServicio]: Set<claveDeEnvironment> } */
function parseComposeServiceEnvironments(yamlText) {
  const lines = yamlText.split('\n');
  const result = {};

  let i = 0;
  while (i < lines.length && lines[i].trim() !== 'services:') i++;
  if (i >= lines.length) {
    throw new Error(`No se encontró la clave top-level "services:" en ${COMPOSE_PATH}`);
  }
  const servicesIndent = leadingSpaces(lines[i]);
  i++;

  let serviceIndent = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent <= servicesIndent) break; // salimos del bloque services:

    const serviceMatch = line.trim().match(/^([A-Za-z0-9_-]+):\s*$/);
    if (serviceIndent === null && serviceMatch) serviceIndent = indent;

    if (serviceMatch && indent === serviceIndent) {
      const serviceName = serviceMatch[1];
      result[serviceName] = new Set();
      i++;
      let envIndent = null;
      while (i < lines.length) {
        const l2 = lines[i];
        if (l2.trim() === '' || l2.trim().startsWith('#')) {
          i++;
          continue;
        }
        const ind2 = leadingSpaces(l2);
        if (ind2 <= serviceIndent) break; // siguiente servicio o fin de services:

        if (envIndent !== null && ind2 <= envIndent) {
          envIndent = null; // salimos del bloque environment: de este servicio
        }

        const t2 = l2.trim();
        if (envIndent === null && t2 === 'environment:') {
          envIndent = ind2;
          i++;
          continue;
        }
        if (envIndent !== null && ind2 > envIndent) {
          const keyMatch = t2.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*):/);
          if (keyMatch) result[serviceName].add(keyMatch[1]);
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return result;
}

function parseEnvExampleKeys(text) {
  const keys = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * IN-03 (docs/auditoria-2/infra.md): variables que el propio
 * docker-compose.prod.yml espera recibir de `infra/compose/.env` --
 * cualquier `${VARIABLE}` / `${VARIABLE:-default}` / `${VARIABLE:?msg}`
 * referenciado en el YAML. A propósito NO es lo mismo que "toda variable
 * que el código lee": muchos valores del `environment:` de cada servicio
 * son LITERALES (`PORT: "3000"`, `NODE_ENV: production`) o DERIVADOS de
 * otra variable ya cubierta (`DATABASE_URL` se arma con `${POSTGRES_USER}`/
 * `${POSTGRES_PASSWORD}`/`${POSTGRES_DB}`, no tiene su propio `${DATABASE_URL}`
 * en ningún lado) -- exigir que ESAS aparezcan también como clave propia en
 * `.env.prod.example` sería un falso positivo (no hay nada que un operador
 * deba completar para ellas).
 */
function extractComposeVarReferences(yamlText) {
  const refs = new Set();
  const pattern = /\$\{([A-Z][A-Z0-9_]*)(?::[-?][^}]*)?\}/g;
  for (const rawLine of yamlText.split('\n')) {
    // Descarta comentarios ANTES de buscar ${VARIABLE} -- este archivo usa
    // `#` solo para comentarios (nunca dentro de un valor real), y varios de
    // esos comentarios documentan el propio mecanismo `${VAR}`/`${VAR:-x}`
    // como ejemplo de prosa (falso positivo si se escanea literal).
    const hashIndex = rawLine.indexOf('#');
    const codeOnly = hashIndex === -1 ? rawLine : rawLine.slice(0, hashIndex);
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(codeOnly)) !== null) {
      refs.add(match[1]);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 3. Comparación y reporte.
// ---------------------------------------------------------------------------

function main() {
  const composeText = readFileSync(COMPOSE_PATH, 'utf8');
  const envExampleText = readFileSync(ENV_EXAMPLE_PATH, 'utf8');

  const composeEnvsByService = parseComposeServiceEnvironments(composeText);
  const envExampleKeys = parseEnvExampleKeys(envExampleText);
  const composeVarReferences = extractComposeVarReferences(composeText);

  let failed = false;
  const lines = [];

  lines.push('[check-env-parity] comparando variables leídas por el código real de cada');
  lines.push('servicio contra infra/compose/docker-compose.prod.yml e infra/env/.env.prod.example.');
  lines.push('');

  for (const [serviceKey, cfg] of Object.entries(SERVICES)) {
    const codeVars = extractEnvVarsFromSource(cfg.sourceDirs);
    const composeVars = composeEnvsByService[cfg.composeServiceName];
    if (!composeVars) {
      lines.push(`[check-env-parity] ERROR: el servicio "${cfg.composeServiceName}" no existe en ${COMPOSE_PATH}.`);
      failed = true;
      continue;
    }

    // IN-01: toda variable que el código de este servicio lee debe recibir
    // un valor real dentro del contenedor -- estar declarada en su
    // `environment:` (sea como ${VAR} interpolada o como literal).
    const missingFromCompose = [...codeVars]
      .filter((v) => !composeVars.has(v) && !cfg.allowMissing.has(v))
      .sort();
    // Informativo, no bloqueante: variables declaradas en el compose de este
    // servicio que ningún archivo fuente real lee hoy (p. ej. SENTRY_DSN,
    // reservada -- ver docs/auditoria-2/infra.md rubro 3). Puede ser
    // deliberado (variable reservada) o deuda -- se reporta para que un
    // humano lo revise, nunca falla el script por sí solo.
    const declaredButUnused = [...composeVars].filter((v) => !codeVars.has(v)).sort();

    lines.push(`--- servicio: ${serviceKey} (${cfg.sourceDirs.join(', ')}) ---`);
    lines.push(`  variables leídas por el código: ${codeVars.size}`);
    lines.push(`  variables declaradas en compose (${cfg.composeServiceName}): ${composeVars.size}`);

    if (missingFromCompose.length > 0) {
      failed = true;
      lines.push(`  FALTAN en infra/compose/docker-compose.prod.yml -> environment: de "${cfg.composeServiceName}":`);
      for (const v of missingFromCompose) lines.push(`    - ${v}`);
    } else {
      lines.push('  OK: todas las variables del código están en el compose.');
    }

    if (declaredButUnused.length > 0) {
      lines.push('  INFO (no bloqueante): declaradas en compose pero sin lectura detectada en el código (revisar si son reservadas/deuda):');
      for (const v of declaredButUnused) lines.push(`    - ${v}`);
    }
    lines.push('');
  }

  // IN-03: toda variable que docker-compose.prod.yml espera recibir de
  // `infra/compose/.env` (cualquier `${VARIABLE...}` en el YAML) debe estar
  // documentada en infra/env/.env.prod.example -- si no, un operador que
  // siga el runbook de infra/README.md al pie de la letra no sabría que
  // existe.
  const missingFromExample = [...composeVarReferences].filter((v) => !envExampleKeys.has(v)).sort();
  lines.push(`--- infra/env/.env.prod.example vs. \${VARIABLE} referenciadas en el compose ---`);
  lines.push(`  variables referenciadas con \${...} en el compose: ${composeVarReferences.size}`);
  if (missingFromExample.length > 0) {
    failed = true;
    lines.push('  FALTAN en infra/env/.env.prod.example:');
    for (const v of missingFromExample) lines.push(`    - ${v}`);
  } else {
    lines.push('  OK: todas están documentadas en .env.prod.example.');
  }
  lines.push('');

  console.log(lines.join('\n'));

  if (failed) {
    console.error('[check-env-parity] FALLÓ: hay divergencia entre el código y infra/** (ver detalle arriba).');
    process.exit(1);
  }
  console.log('[check-env-parity] OK: el código y infra/** (compose + .env.prod.example) coinciden.');
  process.exit(0);
}

main();
