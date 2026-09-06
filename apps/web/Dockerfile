# syntax=docker/dockerfile:1.7
#
# Imagen de apps/web (back office estático, React + Vite) — Atiende
# Licitaciones.
#
# CONTEXTO DE BUILD: la RAÍZ del monorepo (npm workspaces), igual que
# apps/api/Dockerfile y apps/worker/Dockerfile — necesario para que
# `npm ci` resuelva package-lock.json contra todos los workspaces.
#
# A diferencia de apps/api/apps/worker, apps/web NO depende de ningún
# paquete @atiende/* en tiempo de ejecución (ver apps/web/package.json:
# solo dependencias de terceros) ni tiene el problema de resolución de
# TypeScript sin compilar descrito en apps/api/Dockerfile — es un sitio
# 100% estático tras `vite build` (`apps/web/dist/`), servido aquí por
# nginx sin ningún runtime de Node.
#
# VITE_API_URL se hornea en tiempo de BUILD (Vite embebe `import.meta.env.*`
# en el bundle final, no se puede cambiar después con una variable de
# entorno del contenedor en marcha) — se pasa como build-arg. El patrón de
# despliegue documentado en infra/README.md usa un subdominio propio para
# la API (p. ej. https://api.<dominio>) + CORS_ORIGINS en apps/api
# apuntando al dominio de este front, en vez del proxy same-origin interno
# que usa apps/web/scripts/e2e-full.mjs solo para su propia suite E2E.
ARG VITE_API_URL=""

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/expediente/package.json packages/expediente/package.json
COPY packages/sources/package.json packages/sources/package.json

RUN npm ci

COPY apps/web apps/web

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

RUN npm run build --workspace=apps/web

FROM nginx:1.27-alpine AS runtime

# nginx.conf reescrito por completo (no parcheado con `sed` sobre el de la
# imagen base -- ver infra/docker/nginx.conf para el porqué) para poder
# correr TODO el proceso (master incluido) como usuario no-root "nginx".
COPY infra/docker/nginx.conf /etc/nginx/nginx.conf
COPY infra/docker/nginx.web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# Puerto 8080 (no root, ver infra/docker/nginx.web.conf) — el usuario
# "nginx" (ya existe en la imagen base) necesita poder leer los estáticos;
# pid/temp de nginx ya apuntan a /tmp (mundialmente escribible, ver
# infra/docker/nginx.conf), así que no hace falta chown ahí.
RUN chown -R nginx:nginx /usr/share/nginx/html

USER nginx
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/index.html >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
