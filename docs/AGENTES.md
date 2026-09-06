# Registro de agentes (modelo efectivo verificado)

Regla: Fable (claude-fable-5-1) solo orquesta. Cada despacho usa `Agent(subagent_type="general-purpose", model="sonnet")`; el prompt exige a descendientes `model="sonnet"`. Default global `~/.claude/settings.json` = sonnet (sin cambios).

| # | Fecha | Nombre/tarea | Modelo param | Evidencia de sesión | Estado |
|---|-------|--------------|--------------|---------------------|--------|
| 1 | 2026-09-05 | investigar-pdf-requisitos → docs/REQUISITOS.md, ACEPTACION.md, investigacion/pdf-resumen.md | model="sonnet" | pendiente (ID al completar) | en curso |
| 2 | 2026-09-05 | inventario-frontend-restaurantes → investigacion/frontend-restaurantes.md | model="sonnet" | pendiente | en curso |
| 3 | 2026-09-05 | investigar-likida-arquitectura → investigacion/likida-arquitectura.md | model="sonnet" | pendiente | en curso |
| 4 | 2026-09-05 | localizar-carpeta-empresas-agenticas → investigacion/ubicacion-empresas-agenticas.md | model="sonnet" | pendiente | en curso |
