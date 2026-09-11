# @atiende/evals

Gate real de evals (REQ-087/REQ-097/REQ-138): runner de evals + su
integración en CI (`.github/workflows/quality.yml`, job `evals-gate`) que
**falla el build** si la calidad cae bajo el umbral configurado — no un
script suelto sin gate.

## Cómo correrlo

```bash
npm run evals --workspace=packages/evals   # el gate real (CLI, process.exit real)
npm run test --workspace=packages/evals    # pruebas del propio runner/graders (vitest)
npm run test:coverage --workspace=packages/evals
```

`bash scripts/ci-local.sh` (raíz del repo) reproduce el mismo paso que CI
(`evals-gate`) localmente, igual que hace con cada workspace.

## Qué evalúa (mapeo requisito → mecanismo)

| Categoría | REQ | Grader | Lógica de negocio real reutilizada |
|---|---|---|---|
| `anticorrupcion_anticolusion` | REQ-087 | `gradeAnticorruption` | `AntiCorruptionGuardrail` (packages/agents) — la MISMA clase que usa `AgentRunner` en producción |
| `inyeccion_prompt` | REQ-097 | `gradeAnticorruption` sobre payloads envueltos en técnicas de inyección | idem, con fixtures que envuelven el mismo contenido prohibido en override de rol, tags de sistema falsos, Unicode de ancho completo/ancho cero |
| `no_fabricacion` | REQ-021/REQ-087 ("tasa de alucinación 0") | `gradeNoFabrication` | `scanForUnsourcedSensitiveData` (AG-10, packages/agents) — el escaneo recursivo real que corre sobre cada `output` de tool_call |
| `autorizacion_rol` | REQ-062/REQ-165 | `gradeAuthorization` | `AuthorizationPolicy.decide` (packages/agents) con sus defaults de producción |
| `juicio_calidad_redaccion` | REQ-087 ("juez LLM calibrado") | `gradeWithJudge` | puerto `LLMJudge` (ver abajo) |

Ninguna de estas pruebas mockea la lógica de negocio real: cada grader
instancia la clase/función de producción de `@atiende/agents` tal cual y
compara su resultado contra lo esperado. Lo único "de prueba" es el borde
externo (el proveedor de LLM del juez, ver siguiente sección) — exactamente
el patrón "esqueleto honesto" ya usado en el resto de este repo
(`FakeProvider`, `packages/agents/README.md`).

## El "juez LLM calibrado" (REQ-087) — esqueleto honesto

REQ-021 exige un gold set humano de 100-300 convocatorias reales anotadas
para calibrar cualquier juez de calidad. **Ese gold set no existe todavía**
(`docs/ACEPTACION.md` REQ-021: `BLOQUEADO_EXTERNO`) — esta tarea no lo
fabrica.

Lo que sí es real aquí:

- El puerto `LLMJudge` (`src/graders/llm-judge.ts`): contrato estable que
  cualquier juez (fake o real) implementa.
- `FakeCalibratedJudge`: heurística determinista de verificación de citas
  (sin red) — `calibratedAgainstRealGoldSet: false` siempre. Es el piso que
  usa `evals-gate` en CI hoy (sin `OPENAI_API_KEY`).
- `OpenAILLMJudge`: wiring REAL contra `OpenAIResponsesProvider` (mismo
  proveedor de producción de `packages/agents`) — funciona de verdad con
  `OPENAI_API_KEY`, pero **sigue** `calibratedAgainstRealGoldSet: false`
  porque calibrar significa medir su acuerdo con el gold set humano de
  REQ-021, que no existe. `buildJudge(apiKey)` elige entre ambos con el
  mismo patrón que `buildLlmProvider(openaiApiKey)` de
  `apps/worker/src/handlers/run-agent.ts`.

El reporte del gate (`formatGateReport`) marca explícitamente cada
categoría no calibrada — nunca se presenta como certificación de calidad.

## Cobertura real vs. pendiente (honestidad, no completitud fabricada)

**Cubierto end-to-end hoy** (ver también
`apps/worker/test/prompt-injection-red-team.test.ts`):

- El guardrail anticorrupción/anticolusión bloquea contenido prohibido
  incluso envuelto en técnicas de inyección de prompt reales (override de
  rol, tags de sistema falsos, Unicode de ancho completo/ancho cero — ver
  AG-24 en `packages/agents/src/guardrails/anticorruption.ts`, agregado
  como parte de este mismo cambio tras encontrar que el guardrail SÍ era
  evadible por esas dos técnicas).
- La arquitectura de "plan fijo de tool_calls" (Ronda 6,
  `apps/worker/src/agents/named-agents.ts`) contiene cualquier intento de
  inyección en título/dependencia/documentos de una convocatoria: ningún
  contenido externo puede alterar QUÉ herramienta se ejecuta.

**Límite conocido, documentado y probado (no oculto)**:

- `AgentRunner` corre `AntiCorruptionGuardrail.check()` sobre el **input**
  del tool_call, nunca sobre datos que el propio handler resuelve de la
  base de datos. Un `tender.title`/`tender.contracting_body` malicioso que
  llega a un prompt de LLM vía `proponer_matching`
  (`apps/worker/src/agents/business-tools.ts`) **no pasa por el
  guardrail** hoy — ver el test "LÍMITE CONOCIDO" en
  `prompt-injection-red-team.test.ts`. El contenido no puede escalar
  privilegios (arquitectura de plan fijo), pero sí podría colarse texto no
  deseado en el campo `explanation` persistido. Cerrarlo requeriría pasar
  el guardrail también a `business-tools.ts` y revisar cada
  `completeText(...)` con datos externos — cambio de mayor alcance que el
  de este REQ, dejado como pendiente explícito, no fabricado como resuelto.
- Homoglifos entre alfabetos distintos (p. ej. una letra cirílica
  sustituyendo una latina) siguen sin resolverse — ver AG-24 y el test
  "LÍMITE CONOCIDO" en `packages/agents/test/guardrails.test.ts`. Cerrarlo
  exigiría una tabla de "confusables" (Unicode TR39) no incluida aquí.
- **No existe ninguna ruta hoy donde un mensaje de WhatsApp entrante llegue
  a un prompt de LLM** en este repo (`packages/whatsapp` solo implementa
  envío saliente de notificaciones). Por eso este paquete NO incluye casos
  de "mensaje de WhatsApp malicioso": fabricar esa integración solo para
  poder marcar la casilla violaría la regla de oro de este repo ("nunca
  fabricar"). Cuando esa ruta exista, `src/cases/prompt-injection.cases.ts`
  es el lugar natural para sumarla.
- El gate en CI (`evals-gate`) hace que el JOB falle (`process.exit(1)`,
  ver `src/cli.ts`), lo que bloquea el check del PR — pero **este
  repositorio NO tiene todavía branch protection configurada en GitHub**
  (`gh api repos/.../branches/main/protection` devuelve 404 al momento de
  este cambio), así que un check en rojo no impide técnicamente apretar
  "Merge" en la UI de GitHub. Configurar el required status check es un
  cambio de configuración del repositorio (afecta a todos los
  colaboradores) que esta tarea deja pendiente de autorización explícita
  del usuario — ver `docs/BLOQUEOS.md` B-05 y `docs/ACEPTACION.md`
  REQ-087/REQ-138.

## Umbrales (`src/thresholds.ts`)

Las cuatro categorías de cumplimiento legal (anticorrupción/anticolusión,
inyección de prompt, no-fabricación, autorización) exigen **100% con
tolerancia cero**: un solo caso adversarial que deje de bloquearse rompe el
build, sin importar el passRate agregado — son mecanismos de cumplimiento
legal real (KYC/anticolusión adyacente), no ruido estadístico. La categoría
de juicio de calidad (no calibrada, ver arriba) usa un umbral más permisivo
(80%) a propósito, para que el mecanismo de umbral esté probado de extremo
a extremo sin sobre-prometer sobre una capa probabilística no calibrada.

`runner.test.ts` prueba el MECANISMO del gate (agregación + umbral +
tolerancia cero) de forma pura, sin depender de la lógica de negocio real;
`graders.test.ts`/`cli.test.ts` prueban que los graders/casos reales de
este repositorio pasan HOY, e incluyen pruebas de mutación que demuestran
que una regresión real (guardrail debilitado, veredicto falseado) sí
rompe el reporte agregado.
