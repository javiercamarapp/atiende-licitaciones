# Registro de agentes (modelo efectivo verificado)

Regla: Fable (claude-fable-5-1) solo orquesta. Cada despacho usa `Agent(subagent_type="general-purpose", model="sonnet")`; el prompt exige a descendientes `model="sonnet"`. Default global `~/.claude/settings.json` = sonnet (sin cambios).

| # | Fecha | Nombre/tarea | Modelo param | Evidencia de sesión | Estado |
|---|-------|--------------|--------------|---------------------|--------|
| 1 | 2026-09-05 | investigar-pdf-requisitos → /Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging/docs/REQUISITOS.md, ACEPTACION.md, investigacion/pdf-resumen.md | model="sonnet" | notificación de tarea completada (128 tool uses, 179k tokens subagente, 981 s; hasta 3 descendientes sonnet) | COMPLETADO: 140 REQ / 28 módulos |
| 2 | 2026-09-05 | inventario-frontend-restaurantes → /Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging/docs/investigacion/frontend-restaurantes.md | model="sonnet" | notificación de tarea completada (24 tool uses, 117k tokens subagente, 293 s) | COMPLETADO |
| 3 | 2026-09-05 | investigar-likida-arquitectura → /Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging/docs/investigacion/likida-arquitectura.md | model="sonnet" | notificación de tarea completada (62 tool uses, 249k tokens subagente, 837 s) | COMPLETADO |
| 4 | 2026-09-05 | localizar-carpeta-empresas-agenticas → /Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging/docs/investigacion/ubicacion-empresas-agenticas.md | model="sonnet" | notificación de tarea completada (10 tool uses, 73k tokens subagente, 111 s) | COMPLETADO: NO ENCONTRADA |

Nota: la herramienta Agent de esta versión no expone el ID de modelo del subagente en la notificación; la evidencia es el parámetro `model="sonnet"` de cada llamada (registrado aquí) más la notificación de completado. Cuando la sesión no puede garantizar Sonnet, no se despacha con herencia.
| 5 | 2026-09-05 | impl-web-ronda1 → apps/web (Vite+React+TS+Tailwind+shadcn, shell, sidebar, móvil, a11y, vitest) | model="sonnet" | pendiente | en curso |
| 6 | 2026-09-05 | impl-api-db-ronda1 → packages/db (migraciones Postgres + RLS sobre PGlite, tests adversariales) y apps/api (Fastify, auth JWT, orgs, idempotencia, rate limit, audit) | model="sonnet" | pendiente | en curso |
