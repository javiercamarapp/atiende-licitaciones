# syntax=docker/dockerfile:1.7
#
# Imagen de apps/worker (cola de jobs sobre Postgres) — Atiende Licitaciones.
#
# CONTEXTO DE BUILD: la RAÍZ del monorepo, igual que apps/api/Dockerfile
# (ver ese archivo para la explicación completa de por qué). Resumen: este
# es un monorepo con npm workspaces, así que `npm ci` necesita ver todos
# los package.json de apps/*/packages/* aunque esta imagen solo empaquete
# apps/worker.
#
# MISMA LIMITACIÓN VERIFICADA que apps/api/Dockerfile: packages/db,
# packages/agents y packages/sources exportan TypeScript sin compilar
# (`main`/`exports` -> `./src/index.ts`), y `node dist/index.js` tras `tsc`
# falla en este árbol con `ERR_MODULE_NOT_FOUND` al no poder resolver esas
# importaciones. Por eso esta imagen ejecuta el código fuente con `tsx`
# (igual que apps/api/Dockerfile y que `scripts/db-postgres-migrate.mjs` en
# CI, ver .github/workflows/quality.yml) en vez de `node dist/index.js` —
# ver la nota extendida y la verificación real en apps/api/Dockerfile y en
# docs/logs/infra-ronda6.log.
#
# apps/worker NO expone puerto HTTP propio en esta ronda (ver
# docs/OPERACION.md §4/§10: "apps/worker no expone healthcheck HTTP
# propio") — por eso esta imagen no declara HEALTHCHECK basado en HTTP; su
# salud se observa vía logs estructurados y la tabla `jobs`/`source_runs`
# (mismo límite documentado en el repo, no una omisión de esta imagen).

FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/expediente/package.json packages/expediente/package.json
COPY packages/sources/package.json packages/sources/package.json
COPY packages/mail/package.json packages/mail/package.json

RUN npm ci

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

COPY apps/worker/package.json apps/worker/package.json
COPY apps/worker/src apps/worker/src

COPY packages/agents/package.json packages/agents/package.json
COPY packages/agents/src packages/agents/src

COPY packages/db/package.json packages/db/package.json
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations

COPY packages/sources/package.json packages/sources/package.json
COPY packages/sources/src packages/sources/src

COPY packages/mail/package.json packages/mail/package.json
COPY packages/mail/src packages/mail/src

RUN chown -R node:node /app

USER node

CMD ["node_modules/.bin/tsx", "apps/worker/src/index.ts"]
