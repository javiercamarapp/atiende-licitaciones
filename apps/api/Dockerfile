# syntax=docker/dockerfile:1.7
#
# Imagen de apps/api (Fastify) — Atiende Licitaciones.
#
# CONTEXTO DE BUILD: la RAÍZ del monorepo (no apps/api/), por ejemplo:
#   docker build -f apps/api/Dockerfile -t atiende-api .
# (infra/compose/docker-compose.prod.yml ya lo hace así). Es obligatorio
# porque este es un monorepo con npm workspaces («workspaces»:
# ["apps/*","packages/*"] en el package.json raíz): `npm ci` en la raíz
# necesita ver TODOS los package.json de los workspaces para resolver
# package-lock.json y crear los symlinks de node_modules/@atiende/*, aunque
# esta imagen solo empaquete apps/api.
#
# LIMITACIÓN REAL VERIFICADA EN ESTE ENTORNO (no asumida — probada con
# `node`/`npx tsx` reales antes de escribir este Dockerfile, ver
# docs/logs/infra-ronda6.log): packages/db, packages/agents,
# packages/expediente y packages/sources declaran en su package.json
# "main"/"exports" apuntando directo a `./src/index.ts` (TypeScript SIN
# compilar; packages/db ni siquiera tiene script `build`). Correr
# `node dist/index.js` tras `tsc -p tsconfig.json` (el flujo que sugiere
# `docs/OPERACION.md` §1) falla en este árbol con
# `ERR_MODULE_NOT_FOUND: .../packages/db/src/driver.js` — Node ESM plano
# intenta resolver un import relativo `.js` de un paquete cuyo entrypoint
# real es un `.ts`, y no sabe cargar TypeScript sin loader. Por eso esta
# imagen NO usa `node dist/index.js`: ejecuta el código fuente directo con
# `tsx` (el mismo runner que este repo ya usa en CI para
# `scripts/db-postgres-migrate.mjs` contra Postgres real, ver
# .github/workflows/quality.yml — no es una herramienta nueva introducida
# aquí). Verificado localmente con `npx tsx apps/api/src/index.ts`: resuelve
# `@atiende/db` correctamente (a diferencia de `node` plano); el único error
# que quedó al probarlo fue un archivo de código de apps/api que falta en el
# árbol de trabajo actual («inconformidad.routes.ts», ajeno a esta ronda de
# infraestructura — ver docs/logs/infra-ronda6.log).
#
# Consecuencia de lo anterior: hace falta instalar también devDependencies
# (tsx vive ahí) y copiar código fuente en vez de solo un `dist/`, lo que
# hace esta imagen más grande de lo idealmente posible para una imagen
# "final mínima". Arreglarlo de raíz (mover tsx a dependencies del
# package.json de apps/api/apps/worker, o precompilar con un bundler real
# tipo esbuild que sí resuelva los workspaces) requeriría tocar
# package.json/tsconfig de packages/*/apps/*, fuera del ámbito de esta
# ronda (solo infra/**, Dockerfiles y docs — ver infra/README.md
# "Limitaciones conocidas").

FROM node:22-alpine AS deps
WORKDIR /app

# Solo manifiestos de TODOS los workspaces: esta capa se cachea mientras no
# cambien package*.json, sin invalidarse por cambios de código fuente.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/expediente/package.json packages/expediente/package.json
COPY packages/sources/package.json packages/sources/package.json
COPY packages/mail/package.json packages/mail/package.json
COPY packages/whatsapp/package.json packages/whatsapp/package.json

RUN npm ci

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/app/data/storage
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
# `npm ci` en la raíz NO siempre hoistea todo a node_modules/ raíz: en esta
# resolución concreta del lockfile, @fastify/swagger (y sus dependencias
# transitivas @fastify/json-schema-resolver, ajv-*, typescript) quedan
# anidadas en apps/api/node_modules/ en vez de la raíz -- verificado
# directamente (`docker run --entrypoint sh <imagen-deps> -c "ls
# apps/api/node_modules"`) al diagnosticar un ERR_MODULE_NOT_FOUND real en
# runtime que ninguna prueba de CI detecta (CI nunca ejecuta la imagen
# Docker, solo `npm run test`, que sí ve el node_modules anidado porque
# corre desde la raíz del repo con Node resolviendo hacia arriba). Sin esta
# copia, la imagen arranca y crashea en bucle. Si una futura regeneración
# de package-lock.json cambia esta decisión de hoisting, volver a verificar
# con el mismo comando antes de asumir que esta línea sigue haciendo falta.
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json package-lock.json ./

COPY apps/api/package.json apps/api/package.json
COPY apps/api/src apps/api/src
COPY apps/api/docs apps/api/docs

COPY packages/agents/package.json packages/agents/package.json
COPY packages/agents/src packages/agents/src

COPY packages/db/package.json packages/db/package.json
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations

COPY packages/expediente/package.json packages/expediente/package.json
COPY packages/expediente/src packages/expediente/src

COPY packages/sources/package.json packages/sources/package.json
COPY packages/sources/src packages/sources/src

COPY packages/mail/package.json packages/mail/package.json
COPY packages/mail/src packages/mail/src

COPY packages/whatsapp/package.json packages/whatsapp/package.json
COPY packages/whatsapp/src packages/whatsapp/src

# scripts/db-postgres-migrate.mjs: reutilizado por el servicio "migrate" de
# un solo uso en infra/compose/docker-compose.prod.yml (misma imagen que la
# API, solo cambia el comando) en vez de mantener una tercera imagen.
COPY scripts/db-postgres-migrate.mjs scripts/db-postgres-migrate.mjs

# Directorio de almacenamiento local (STORAGE_DIR, ver apps/api/.env.example)
# — en producción se monta como volumen (ver docker-compose.prod.yml); se
# crea aquí para que exista con el dueño correcto incluso antes del primer
# montaje.
RUN mkdir -p /app/data/storage && chown -R node:node /app

USER node
EXPOSE 3000

# Liveness/readiness reales de la propia API (ver docs/OPERACION.md §4):
# /healthz no toca la base de datos (apto para HEALTHCHECK de Docker/orquestador).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "apps/api/src/index.ts"]
