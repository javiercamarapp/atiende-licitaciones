# Operación del bucle — Atiende Licitaciones (continuidad real)

Versión de Claude Code verificada: **2.1.261**. Sesión de orquestación: `session_01PF5QyVoZ1Z35Mi9Xt9ehd8`.
Mecanismos inspeccionados en esta instalación (no inventados): skill `/loop` (sin intervalo = modo dinámico autoprogramado vía `ScheduleWakeup`), `CronCreate/CronList/CronDelete` (solo sesión), `Monitor`, `Agent` con parámetro `model`.
La sintaxis antigua de Likida (`/loop 0 6 * * * /auditoria-diaria`) NO se reutilizó: se invocó `/loop` real en esta versión y se siguieron sus instrucciones.
Este bucle es NUEVO y separado del de Atiende Hoteles (cron `f24bfd35`, que no se toca).

## Mecanismo primario — `/loop` dinámico (ScheduleWakeup)
- **Identificador:** no emite ID; su evidencia es la llamada `ScheduleWakeup` al cierre de cada turno y el despertar registrado en `docs/logs/bucle.log`.
- **Frecuencia:** autoprogramada, 60–3600 s (clamp de la herramienta). Fable elige 1200–1800 s cuando hay agentes Sonnet corriendo (sus notificaciones despiertan antes) y más corto si hay trabajo inmediato.
- **Persistencia:** SOLO SESIÓN. Muere si la sesión de Claude Code se cierra. No se promete ejecución con la sesión cerrada.

## Mecanismo de respaldo — CronCreate
- **ID:** `a1c165a2`
- **Cron:** `13 */2 * * *` (cada 2 h al minuto 13, hora local). Recurrente. Solo dispara con la sesión ociosa.
- **Persistencia:** solo sesión (no se escribe en disco). **Autoexpira a los 7 días** (dispara una última vez y se borra) → fecha límite aprox. 2026-09-12.
- **Prompt:** rutas absolutas de `/Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging`; reanuda el ciclo Likida si el bucle dinámico murió; si sigue vivo, solo registra latido.

## Modelos efectivos
- Orquestador: Fable (`claude-fable-5-1`) SOLO en esta sesión. Default global de `~/.claude/settings.json` = `sonnet` (no modificado).
- Ejecutores: `Agent(subagent_type=general-purpose, model="sonnet")` en cada despacho; se exige a descendientes pasar `model="sonnet"`. Registro en `docs/AGENTES.md`.
- Respaldo (D-10, autorizado por el usuario 2026-09-06): si Sonnet está limitado (429 repetido), se despacha con `model="opus"` explícito y se anota el modelo efectivo en `docs/AGENTES.md`.

## Estado persistente de reanudación (leer SIEMPRE al despertar o tras compactar)
1. `docs/AMPLIACION-BACKOFFICE.md` y `docs/AMPLIACION-2-SALIDA.md` — ampliaciones prioritarias del usuario (back office completo; salida a promoción con Google, correos, onboarding, landing, despliegue) (ciclo completo back office; reglas duras: nunca inventar datos/precios/firmas, nunca enviar/firmar/actuar en portales). Es parte del alcance obligatorio.
2. `docs/REQUISITOS.md` + `docs/ACEPTACION.md` (REQ-001..140 + REQ-141+ de la ampliación) y `docs/BACKLOG.md` (orden de trabajo).
3. `docs/PROGRESO.md` (último paso), `docs/BLOQUEOS.md`, `docs/DECISIONES.md`, `docs/AGENTES.md`, `docs/auditoria-N/`, `git log`.
Regla: no repetir trabajo validado; no rehacer investigación (completa); verificación puntual solo de fuentes/API/reglas que cambian.

## Alcance del ciclo (patrón Likida adaptado)
implementación (Sonnet) → pruebas (Sonnet, salida real guardada en `docs/logs/`) → auditoría adversarial (Sonnet, contexto independiente, un archivo por rubro en `docs/auditoria-N/`, hallazgo separado de reparación, registrar también lo correcto) → corrección (Sonnet, un hallazgo = un commit) → reverificación (Sonnet). Fable despacha, verifica y decide; nunca construye.

## Condición de parada
1. Todos los criterios de `docs/ACEPTACION.md` satisfechos con evidencia (comando + salida) y sin defectos críticos/altos abiertos; o
2. Bloqueo externo real sin trabajo independiente restante: 3 intentos sin progreso documentados en `docs/BLOQUEOS.md`.
Al parar: `ScheduleWakeup(stop:true)`, `CronDelete a1c165a2`, `PushNotification`, entrada final en `docs/PROGRESO.md`. No dejar ciclo consumiendo recursos.

## Reanudación tras cierre de sesión
```
cd /Users/javiercamaraportepetit/Documents/Codex/atiende-licitaciones-staging   # o la ruta definitiva de empresas agénticas cuando se verifique
claude --model fable
# dentro de la sesión:
/loop
# y pegar: "Lee docs/operacion-bucle.md (sección Estado persistente), docs/AMPLIACION-BACKOFFICE.md, docs/BACKLOG.md, docs/PROGRESO.md, docs/BLOQUEOS.md y docs/AGENTES.md y reanuda el ciclo Likida de Atiende Licitaciones; solo agentes model=sonnet; crea cron de respaldo nuevo con CronCreate y verifica con CronList."
```
Reanudar desde archivos: `docs/PROGRESO.md` (último paso), `docs/BLOQUEOS.md`, `docs/auditoria-N/`, `git log`. No repetir trabajo validado.

## Evidencia de ejecución
- 2026-09-05 18:2x — `CronCreate` → `Scheduled recurring job a1c165a2 (Every 2 hours at :13). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days.`
- 2026-09-05 18:2x — `CronList` → `a1c165a2 — Every 2 hours at :13 (recurring) [session-only]` (único job de esta sesión; el de Hoteles vive en otra sesión).
- Latidos y despertares ScheduleWakeup: ver `docs/logs/bucle.log`.
