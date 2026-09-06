# Reverificación adversarial — ronda 3 (CIERRE) — `packages/expediente`

Fecha: 2026-09-05. Agente: reverificador adversarial independiente, vuelta 3
(cierre), contexto separado del proyecto. Rol: SOLO encuentra/verifica —
ningún código de `packages/expediente` fue modificado por este agente.
Evidencia real de cada verificación en `docs/logs/reverify3-expediente.log`.

Documentos base leídos: `docs/auditoria-1/expediente.md`,
`expediente-reverificacion.md`, `expediente-reverificacion-2.md`,
`packages/expediente/README.md`, `docs/AMPLIACION-BACKOFFICE.md` §6-8,
`docs/ACEPTACION.md` (A6-A15).

Metodología de ejecución: `git worktree add <scratchpad>/reverify3-exp HEAD`
(nunca se tocó el árbol de trabajo del repo principal con comandos
destructivos), `npm install` propio del worktree, ataques codificados en
archivos de test temporales dentro del worktree y ELIMINADOS al finalizar la
corrida (mismo patrón que rondas anteriores). Worktree eliminado al cierre.

---

## 1. Ancestría y trazabilidad de los 3 commits del mandato

| Commit | Contenido verificado (`git show --stat`) | Ancestro de HEAD |
|---|---|---|
| `14a35bb` | `fix(expediente): EX-EXP-17/18/19/20` — 13 archivos, 732 líneas nuevas/99 eliminadas: `proposal-version.ts` (+165, `HashedInputs` sellado), `types.ts` (+108, `Date`/`Map`/`Set`/`BigInt`/hora 24:00), `technical-proposal.ts` (+53, secciones NO APLICA), `approval-workflow.ts`/`package-assembler.ts` (migración a `HashedInputs`), 8 archivos de test. | Sí |
| `b5acc45` | `test(expediente): EX-EXP-21` — 2 archivos, 30 líneas: `package.json` (`test:coverage`), `vitest.config.ts` nuevo (thresholds 85/80/85/85). | Sí |
| `5e03e90` | `docs(expediente): ronda 3` — 2 archivos, 358 líneas: `docs/logs/fix-expediente-ronda3.log` (nuevo) + columna "Estado reparación" en `expediente-reverificacion-2.md`. | Sí |

**Veredicto**: trazabilidad EXACTA. Los 3 commits existen, en el orden
correcto (fix → gate de CI → documentación), y el contenido de cada uno
coincide con lo que la tabla "Estado reparación" de
`expediente-reverificacion-2.md` afirma.

---

## 2. Suite y gate de cobertura

- **391/391 tests verdes**, 16 archivos — confirmado por corrida directa,
  coincide con lo reportado en rondas anteriores.
- **`test:coverage` real**: baseline 92.99 % líneas / 90.57 % ramas / 92.43 %
  funciones / 92.99 % statements — todos por encima de los umbrales
  declarados (85/80/85/85).
- **Prueba adversarial del gate**: se mutaron los 4 umbrales a 99 % (valor
  inalcanzable con la cobertura real) y `test:coverage` **FALLÓ** con 4
  mensajes `ERROR: Coverage for ... does not meet global threshold` y código
  de salida distinto de cero, confirmando que el gate no es decorativo.
  `vitest.config.ts` restaurado exactamente a los valores originales después
  (diff vacío).

**Veredicto EX-EXP-21**: CONFIRMADO cerrado, con evidencia adversarial directa
(no solo lectura de código).

---

## 3. Ataques finales a EX-EXP-17 (`HashedInputs` sellado)

11 vectores de ataque ejecutados contra `sealInputs`/`requireValidHashedInputs`
(detalle completo con código en el log, sección 3). Resumen:

| Vector | Resultado |
|---|---|
| `Object.create()` sin overrides | Aceptado — indistinguible de usar el objeto legítimo directamente, no es ataque |
| `Object.create()` + inputs/hash propios coherentes (nuevo hallazgo, ver §3.1) | Aceptado — ver análisis abajo |
| Copiar símbolo + inputs distintos + hash NO recalculado | **Rechazado** (recompute no coincide) |
| Copiar símbolo + hash recalculado con función pública | Aceptado — equivalente a llamar `sealInputs()` directamente, no es bypass |
| `structuredClone()` | Pierde el símbolo → **rechazado** correctamente |
| `Proxy` que sustituye `inputs` al leer | **Rechazado** (recompute no coincide) |
| Mutación profunda: `push()` en arreglo anidado tras sellar | **Rechazado** |
| Mutación profunda: propiedad anidada tras sellar | **Rechazado** |
| Serializar/deserializar JSON | Pierde el símbolo → **rechazado** |
| `Symbol()` vs `Symbol.for()` | Confirmado: el módulo usa `Symbol()` (diseño correcto, no intercambiable entre "instancias") |
| `WeakMap` interno | No usado; símbolo privado es la única superficie, ya cubierta |
| `string` plano | **Rechazado** con mensaje de migración explícito |

### 3.1 Hallazgo nuevo — REVERIFY3-EXP-A (BAJA/documental, no explotable hoy)

`isSealedHashedInputs` (`src/proposal-version.ts:103-109`) verifica el
símbolo privado con `value[SEALED_MARKER] === true` — un acceso de propiedad
normal, que **recorre la cadena de prototipos**. Un objeto construido con
`Object.create(cualquierHashedInputsLegitimoPrevio)` con `inputs`/`hash`
PROPIOS (nuevos, auto-coherentes vía la función pública `computeInputsHash`)
hereda el símbolo y **pasa la verificación**, aunque nunca invocó
`sealInputs()`.

**No es una escalada de privilegio explotable con la superficie pública
actual**: `sealInputs`/`computeInputsHash` ya son funciones exportadas —
cualquiera que pueda ejecutar este ataque ya podía, de forma más simple,
llamar `sealInputs(susPropiosInputs)` directamente con el mismo efecto
legítimo. La garantía real de integridad no depende de esto.

**Por qué se documenta como hallazgo de todos modos**: la afirmación literal
del código y el README ("ningún código externo puede construir un objeto con
esta clave") es imprecisa — si en el futuro algún consumidor (p. ej.
`apps/api`) restringe el acceso a `sealInputs`/`computeInputsHash` para un
contexto de menor confianza mientras sigue pasando objetos `HashedInputs` ya
sellados de otros contextos, este vector SÍ sería una escalada real (basta
obtener CUALQUIER `HashedInputs` ajeno para heredar la "capacidad de sellar").
Mitigación de una línea si se desea cerrar en sentido estricto:
`Object.hasOwn(value, SEALED_MARKER)` en vez de acceso de propiedad normal —
verificado en el log que esa distinción (`hasOwn` `false` en el objeto
forjado, `true` en el legítimo) es exactamente la que faltaría aplicar.

No se abre un nuevo ítem de severidad ALTA/CRÍTICA — la garantía funcional
(recomputación de hash, capa 3) sigue siendo sólida y es la que realmente
protege contra manipulación de datos; este hallazgo es sobre la precisión de
una afirmación de diseño en capa 2, no sobre una vulnerabilidad activa.

---

## 4. Ataques adicionales EX-EXP-18 (Date/Map/Set/BigInt/-0/NaN)

| Caso | Resultado |
|---|---|
| `Date` inválido | Lanza explícitamente (fail-closed) — correcto |
| `Map` con claves objeto | Serializa con marcador de tipo; identidad de objeto se pierde (solo igualdad estructural) — inherente a canonicalización JSON, no explotable (`ExpedienteInputs` no usa `Map` con claves objeto) |
| `Set` de `Set`s anidado, orden invertido | Mismo hash canónico en ambos órdenes — confirma robustez del fix también para anidamiento |
| `BigInt` negativo | Serializa distinto del positivo, sin colisión |
| `-0` vs `0` | **Colisionan** (`"0"` en ambos, heredado de `JSON.stringify`) — trampa latente de la misma clase que motivó el fix de `Date`, no cerrada explícitamente, pero no explotable hoy (ningún campo numérico con signo en `ExpedienteInputs`) |
| `NaN` | Serializa a `null`, colisiona con `stableStringify(null)` — misma observación que `-0` |

**Veredicto**: EX-EXP-18 CERRADO para lo que dice cerrar (`Date`/`Map`/`Set`/
`BigInt`, incluido el caso anidado no cubierto por la suite oficial). `-0`/
`NaN` quedan como residual BAJO, latente, documentado aquí para quien amplíe
el uso de `stableStringify`/`sha256Hex` en el futuro — no reabre el hallazgo
porque no afecta ningún campo real de `ExpedienteInputs`.

---

## 5. EX-EXP-19: no aplica → condición cambia a aplicable

Confirmado por prueba directa: `TechnicalProposalBuilder.build()` es pura/sin
caché. Llamado dos veces con el MISMO requisito condicional:
`conditionEvaluations[id] = false` → sección `NO APLICA` visible, sin
bloqueos; luego `conditionEvaluations[id] = true` → sección `PENDIENTE` con
`SectionBlocker` (`evidencia_no_mapeable`). **Se reevalúa y bloquea
correctamente** — no hay estado oculto que impida reflejar el cambio.

**Nota de integración (no defecto de la librería pura)**: `conditionEvaluations`
NO forma parte de `ExpedienteInputs` (el hash de insumos de alcance
"expediente"). Un cambio de aplicabilidad de una condición después de una
aprobación vigente NO se detecta automáticamente vía el hash — `apps/api`
debe reconstruir la propuesta técnica y revalidar/reaprobar manualmente al
cambiar esa decisión de negocio. Riesgo a vigilar en la integración, señalado
para el orquestador.

---

## 6. EX-EXP-20: casos de hora adicionales

`"23:59:60"` (leap second) rechazado; `"00:00:00.0000"` aceptado (límite
correcto); offset con segundos (`"+05:00:30"`) rechazado por formato;
`"24:00:00"` con offset NO-Z (`"-06:00"`) también rechazado, confirmando que
la corrección cubre todos los offsets, no solo `Z`. **EX-EXP-20 robusto más
allá del caso original.**

---

## 7. A6-A15 flujo integrado end-to-end (ZIP real releído)

`test/expediente-flow.test.ts` confirma A13 (paquete "ready", ZIP real
releído con `jszip`, manifiesto y checklist correctos dentro del ZIP), A14/A9
(anexo faltante → "draft", archivos `BORRADOR_*` reales dentro del ZIP), A7/A9
(documento vencido → bloqueo técnico + checklist rojo). El resto (A6, A8, A10,
A11, A12, A15) tiene evidencia específica en los archivos de test que lista
el README, confirmada por lectura directa (p. ej. 20 casos en
`approval-workflow.test.ts` para A11/A12, incluida jerarquía de alcance y
rechazo de autoaprobación/rol indebido).

**El veredicto agregado PENDIENTE de A6-A15 en `docs/ACEPTACION.md` sigue
siendo correcto** — el propio docstring de `expediente-flow.test.ts` es
honesto: un flujo integrado dentro de la librería pura es condición
necesaria pero no suficiente; A6-A15 exigen integración real API/UI/portal
autenticado.

**Cambio de contexto para el orquestador**: a diferencia de rondas
anteriores, `apps/api` YA tiene una integración real y sustancial con
`@atiende/expediente` en el HEAD actual del repo principal — 2455 líneas en
`apps/api/src/modules/expediente/*.routes.ts` + `apps/api/src/lib/expediente/*`
(rutas E6-E11), registradas en `apps/api/src/app.ts` bajo `/expediente/...`
(commits `8fdeb68`, `72cc525`, `c4a6165`, de otro agente, posteriores a los 3
commits de este mandato). Verificar A6-A15 contra esa integración real está
FUERA de alcance de esta ronda (centrada en el paquete puro) — corresponde a
una reverificación adversarial independiente de `apps/api`/E6-E11.

---

## 8. Balance final — `packages/expediente` EX-EXP-01 a EX-EXP-22

| ID | Severidad original | Estado definitivo (esta ronda) | Evidencia |
|---|---|---|---|
| EX-EXP-01 | CRÍTICA | **CERRADO** (vía EX-EXP-11 → EX-EXP-17) | `computeInputsHash`/`sealInputs`/`HashedInputs` sellado; ataques de §3 no logran bypass funcional |
| EX-EXP-02 | CRÍTICA | **CERRADO** | `approve()` exige `scopeRef === "expediente"` cuando `scope === "expediente"` |
| EX-EXP-03 | CRÍTICA | **CERRADO** | Requisito obligatorio sin evidencia → sección "PENDIENTE" con bloqueo, nunca desaparece |
| EX-EXP-04 | CRÍTICA | **CERRADO** | `assertExplicitOffset` exige offset explícito; determinismo de TZ confirmado por `timezone-determinism.test.ts` (3 zonas) |
| EX-EXP-05 | ALTA | **CERRADO** | Apócope "veintiún"/"un" aplicado también al resultado fusionado de centenas/millares/millones |
| EX-EXP-06 | ALTA | **CERRADO** | `extractDeadline` reconoce DD/MM/AAAA, DD-MM-AAAA, "del AAAA" |
| EX-EXP-07 | MEDIA | **CERRADO** | `ivaRate` acotado a `[0, maxIvaRate]`; moneda forzada a MXN |
| EX-EXP-08 | MEDIA | **Aceptado como límite conocido, con causa documentada** | README "Limitaciones conocidas": autoaprobación multi-cuenta de la misma persona física requiere capa de identidad que una librería pura no puede tener — responsabilidad de `apps/api` |
| EX-EXP-09 | BAJA | **CERRADO** | `multiplyQuantityHalfUp` rechaza `quantity > MAX_QUANTITY` (1e7) |
| EX-EXP-10 | BAJA | **Aceptado como decisión de diseño correcta, con causa documentada** | README: `"ambar"` (no `"rojo"`) con <2 documentos es intencional — bloquea "ready" igual (`ambar !== verde`); "resolverlo" fabricando una segunda fuente falsa violaría REQ-164 |
| EX-EXP-11 | ALTA | **CERRADO** (vía EX-EXP-17) | Mismo hilo que EX-EXP-01 |
| EX-EXP-12 | ALTA | **CERRADO** | (a) condicional que aplica ya no desaparece; (b) apócope fusionado — ambos verificados en tests dedicados |
| EX-EXP-13 | ALTA | **CERRADO** | Rango de offset (-12:00/+14:00) y validez calendárica (bisiestos) — fail-closed confirmado con `Number.isNaN` como defensa final |
| EX-EXP-14 | MEDIA | **CERRADO** (mismo commit que EX-EXP-02) | |
| EX-EXP-15 | MEDIA | **CERRADO** | Fecha numérica ambigua (día/mes ambos ≤12) baja `confidence` a 0.5 sin cambiar interpretación DD/MM |
| EX-EXP-16 | BAJA | **CERRADO (documental)** | Docstring de `expediente-flow.test.ts` ya no sobreestima A6-A15 |
| EX-EXP-17 | ALTA | **CERRADO**; hallazgo derivado REVERIFY3-EXP-A (§3.1, BAJA) también **CERRADO** por agente corrector — `isSealedHashedInputs` ahora exige `Object.hasOwn(SEALED_MARKER/inputs/hash)` (propiedad propia, no heredada) **y** pertenencia a un `WeakSet` interno poblado solo por `sealInputs` (identidad de instancia, no falsificable vía `Object.create`); ver `packages/expediente/src/proposal-version.ts`, `packages/expediente/README.md` §"Hash de insumos", `packages/expediente/test/approval-workflow.test.ts` ("Object.create(hashedInputsAjeno)"), `docs/logs/fix-expediente-micro.log` | `HashedInputs` sellado con símbolo privado; 11 ataques adicionales de esta ronda sin bypass funcional real |
| EX-EXP-18 | MEDIA | **CERRADO** para su alcance declarado; residual `-0`/`NaN`/`Infinity` (§4, BAJA) también **CERRADO** por agente corrector — `sortKeysDeep` lanza fail-closed ante `NaN`/`Infinity`/`-Infinity` (decisión de diseño: no finito = error de validación del insumo, no valor hasheable) y serializa `-0` con marcador de tipo distinto de `0`; ver `packages/expediente/src/types.ts`, `packages/expediente/README.md`, `packages/expediente/test/types.test.ts` ("EX-EXP-18 residual"), `docs/logs/fix-expediente-micro.log` | `sortKeysDeep` distingue `Date`/`Map`/`Set`/`BigInt`, incluido anidamiento |
| EX-EXP-19 | BAJA/MEDIA | **CERRADO** | Secciones "NO APLICA" visibles; reevaluación confirmada correcta (§5); nota de integración sobre `conditionEvaluations` fuera del hash, señalada para `apps/api` |
| EX-EXP-20 | BAJA | **CERRADO**, robusto más allá del caso original (§6) | `assertValidTimeComponents` cubre offsets Z y no-Z, leap seconds, fracciones límite |
| EX-EXP-21 | BAJA (CI) | **CERRADO**, confirmado con ataque adversarial de mutación de umbral (§2) | `test:coverage` con thresholds reales, gate probado en falla y en éxito |
| EX-EXP-22 | BAJA (documental) | **N/A — explícitamente fuera del alcance del agente corrector**; pendiente de que el orquestador actualice `docs/ACEPTACION.md` (A6/A7/A9/A11) | Nota reiterada aquí para el orquestador, no se editó `ACEPTACION.md` en esta ronda |

**Resumen**: 20 de 22 hallazgos CERRADOS con evidencia de test/ataque directo;
2 aceptados como límites conocidos con causa documentada (EX-EXP-08,
EX-EXP-10, ambos por diseño correcto de una librería pura sin capa de
identidad/consistencia externa). Ningún hallazgo de severidad CRÍTICA o ALTA
permanece abierto.

**Actualización post-cierre (agente corrector, misma fecha)**: los 2
hallazgos derivados de severidad BAJA que esta ronda dejó documentados pero
sin corregir — REVERIFY3-EXP-A (§3.1, `isSealedHashedInputs` recorría la
cadena de prototipos) y el residual `-0`/`NaN`/`Infinity` de `stableStringify`
(§4) — fueron ambos **CERRADOS** en una micro-vuelta de corrección posterior,
sin tocar `apps/api` ni ningún otro alcance: ver filas EX-EXP-17/EX-EXP-18 de
esta tabla, `packages/expediente/README.md`, y
`docs/logs/fix-expediente-micro.log` para la reproducción "antes" (5 tests
fallando contra el código sin corregir en un `git worktree` separado) y la
corrida completa `typecheck`/`lint`/`test`/`test:coverage` en verde tras el
fix. De los 22 hallazgos originales más el derivado REVERIFY3-EXP-A, ninguno
queda abierto salvo los 2 aceptados como límites de diseño (EX-EXP-08,
EX-EXP-10) y EX-EXP-22 (documental, pendiente de que el orquestador actualice
`docs/ACEPTACION.md`, fuera del alcance de este agente).

---

## 9. REQ candidatos a CUMPLIDO para el orquestador (no se edita `ACEPTACION.md`)

A nivel de **librería pura** (`packages/expediente`, sin depender de la
integración de `apps/api`), los siguientes REQ tienen evidencia de test
sólida y sin hallazgos abiertos de severidad ALTA/CRÍTICA tras esta ronda —
candidatos a que el orquestador los marque CUMPLIDO EN LA CAPA DE LIBRERÍA
(distinto del veredicto agregado de A6-A15, que permanece PENDIENTE por falta
de integración real, ver §7):

- REQ-029, REQ-030, REQ-031 (cálculo económico determinista, cantidad en
  letra) — `money.test.ts`, `number-to-words.test.ts`, `economic-proposal.test.ts`.
- REQ-048 (paquete final con manifiesto) — `package-assembler.test.ts`,
  `expediente-flow.test.ts`.
- REQ-156, REQ-166 (matriz de requisitos, extracción de fechas) —
  `requirement-matrix.test.ts`.
- REQ-157, REQ-158, REQ-164 (propuesta técnica trazable, nunca inventa dato) —
  `technical-proposal.test.ts`, `technical-proposal-property.test.ts` (200
  casos), `company-data.test.ts`.
- REQ-159, REQ-161, REQ-162, REQ-163 (versionado, hash de insumos sellado,
  invalidación automática de aprobaciones, defensa en profundidad en el
  ensamblador) — `approval-workflow.test.ts`, `proposal-invalidation.test.ts`,
  `package-assembler.test.ts` — **con la advertencia de §3.1** (BAJA, no
  bloqueante) sobre la precisión de la afirmación "infalsificable" del símbolo
  privado.
- REQ-160 (vigencias con offset horario explícito y fail-closed) —
  `types.test.ts`, `timezone-determinism.test.ts`.

**No candidatos a CUMPLIDO todavía** (dependen de integración fuera de esta
librería, per README "Pendientes"): correlation_id de punta a punta
(REQ-171), simulador de puntaje/banda legal de precio (REQ-030/038 en
`packages/agents`), huellas de similitud anticolusión (REQ-032), y por
supuesto la totalidad de A6-A15 de `docs/ACEPTACION.md` mientras no exista
verificación E2E real contra la integración de `apps/api` (§7).

---

## 10. Regresión: `apps/api typecheck` en el worktree

El worktree se actualizó de HEAD=`29a120d` (inicio de esta ronda) a
HEAD=`c4a6165` (avance concurrente de otros agentes durante esta ronda, que ya
incluye la integración real de `@atiende/expediente` en `apps/api` — commits
`8fdeb68`/`72cc525`/`c4a6165`) para probar contra el estado más representativo
posible. Los 3 commits del mandato siguen siendo ancestros.

```
$ npm run -w apps/api typecheck
> tsc --noEmit
(sin salida, exit code 0)
```

**Resultado: SIN ERRORES.** No hay ningún error que clasificar como (a)
causado por `packages/expediente` ni (b) WIP ajeno de `apps/api` — el
typecheck combinado del estado COMMITEADO actual es limpio.

Nota: el repo principal tiene además ~74 archivos con cambios NO commiteados
de trabajo en curso de otros agentes (`apps/web`, partes de `apps/api`,
`package-lock.json`) que, correctamente, NO se materializan en un
`git worktree add ... HEAD` y por tanto no se probaron aquí — el resultado de
esta sección es sobre el árbol commiteado en `c4a6165`, no sobre el working
tree actual del repo principal.

---

## 11. Conclusión

`packages/expediente` cierra esta ronda con **cero hallazgos de severidad
CRÍTICA o ALTA abiertos**. Los 3 commits del mandato (`14a35bb`, `b5acc45`,
`5e03e90`) están correctamente trazados y su contenido coincide exactamente
con lo documentado. El gate de cobertura CI (EX-EXP-21) se probó
adversarialmente y falla cuando debe fallar. El mecanismo de sellado
`HashedInputs` (EX-EXP-17) resiste 11 vectores de ataque adicionales de esta
ronda, con un único hallazgo derivado de severidad BAJA/documental (§3.1) que
no es explotable con la superficie pública actual del paquete. `apps/api
typecheck` pasa limpio contra la integración real ya existente. El bloqueo
estructural para A6-A15 (falta de integración real API/UI) puede estar cerca
de resolverse dado el avance concurrente en `apps/api`, pero verificarlo es
tarea de una ronda de reverificación separada sobre esa integración, no de
esta ronda centrada en el paquete puro.

Ver `docs/logs/reverify3-expediente.log` para la evidencia completa
(comandos y salidas reales) de cada verificación resumida aquí.
