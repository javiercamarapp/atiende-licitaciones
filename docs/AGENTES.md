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
| 7 | 2026-09-05 | impl-agents-ronda1 → packages/agents (ToolRegistry, autorización, guardrails, AgentRunner, idempotencia, reintentos, presupuesto, rate limit, LLMProvider/Router, OpenAI Responses pendiente credenciales) | model="sonnet" | pendiente | en curso |
| 8 | 2026-09-05 | impl-sources-ronda1 → packages/sources (TenderRecord, conectores ComprasMX/OCDS-SHCP/DOF/PDN-S6/estatales, DiscoveryPipeline, MatchingEngine) | model="sonnet" | pendiente | en curso |
| 9 | 2026-09-05 | requisitos-ampliacion-backoffice → docs/REQUISITOS.md secc. 29–33 (REQ-141+), docs/ACEPTACION.md, docs/BACKLOG.md | model="sonnet" | notificación de tarea completada (12 tool uses, 106k tokens, 253 s); commit ad1573f | COMPLETADO: REQ-141..171, A1–A15, 12 épicas |
| 10 | 2026-09-05 | impl-expediente-ronda1 → packages/expediente (matriz de requisitos, resolver de datos reales, propuesta técnica/económica, checklist, aprobaciones con invalidación, paquete ZIP draft/ready) — E6/E7/E8/E9, pruebas A6–A15 | model="sonnet" | pendiente | en curso |
