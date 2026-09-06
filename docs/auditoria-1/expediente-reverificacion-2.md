# Reverificación adversarial 2 — `packages/expediente` (ronda 2 de corrección)

**Auditor**: agente Sonnet reverificador independiente (vuelta 2), sin participación en
la construcción del paquete, en la ronda 1 de corrección ni en la ronda 1 de
reverificación. Ejecución real de `npm install`, `typecheck`/`lint`/`test`/`build`,
`vitest run --coverage`, `npm run -w apps/api typecheck`, y 35 pruebas adversariales
propias (7 archivos `.mjs`/`.test.ts` temporales) contra el código fuente TypeScript —
todo en un `git worktree` separado (`git worktree add`), nunca en el árbol principal. El
worktree y los archivos de prueba temporales se eliminaron al terminar; no queda ningún
script adversarial en el repositorio.

**Ámbito**: `packages/expediente/**` en `HEAD` (`f76a71d` al iniciar; sin cambios
posteriores en `packages/expediente/**` durante esta reverificación, confirmado por
`git diff --stat HEAD -- packages/expediente/`).

**Comandos y salida completa**: `docs/logs/reverify2-expediente.log`.

**Documentos base**: `docs/auditoria-1/expediente-reverificacion.md` (reverificación
ronda 1: 5 CERRADO, 4 PARCIAL, 1 NO CERRADO, 6 hallazgos nuevos EX-EXP-11..16),
`docs/auditoria-1/expediente.md` (auditoría original, EX-EXP-01..10),
`packages/expediente/README.md`, `docs/AMPLIACION-BACKOFFICE.md` §6-8,
`docs/ACEPTACION.md` A6-A15.

**Commits de la ronda 2 de corrección reverificados**: `f5991f5`, `1dc9026`, `284db62`,
`5dfae17`, `9845ecf`, `fdf17e4`, `587d4a2` (contiene además, mezclado por una condición
de carrera documentada del índice de git, el fix de EX-EXP-06/EX-EXP-15), `b19ced8`. Los
8 son ancestros de `HEAD` (`git merge-base --is-ancestor`, ver log) y cada uno toca
exactamente los archivos que declara (`git show --stat`, ver log).

---

## Resumen ejecutivo

La ronda 2 de corrección es **real, sustancial y mayormente sólida**: 14 de los 16
hallazgos de la ronda 1 (EX-EXP-02 a EX-EXP-10, EX-EXP-12 a EX-EXP-16) quedan
**CERRADO** tras una reverificación adversarial independiente con 35 ataques propios
adicionales a los ya documentados — la suite oficial pasa completa (16 archivos / 364
pruebas) y con mis 35 pruebas adicionales sube a 399/399 en verde, sin tocar ni un
archivo de producción. La generalización de las reglas de apócope numérico
(EX-EXP-05/12b) y de scope/scopeRef (EX-EXP-02/14) es particularmente sólida: probé
familias enteras de valores/variantes fuera de los casos citados por los commits y
todas se comportaron correctamente.

Sin embargo, esta reverificación encontró que **el hallazgo más crítico de todos
(EX-EXP-01/EX-EXP-11, invalidación automática por hash de insumos) sigue solo
PARCIALMENTE cerrado**, por una razón estructural distinta a la de la ronda 1: la nueva
función `computeInputsHash(ExpedienteInputs)` es correcta, completa y bien probada
**cuando se usa**, pero **nada en el paquete obliga a usarla**. `ApprovalWorkflow.approve()`
y `PackageAssembler.buildManifest()` siguen aceptando `inputsHash`/`currentInputsHash`
como un `string` plano, sin tipo opaco/marcado (`branded type`) ni verificación runtime
de que ese string provenga de `computeInputsHash`. Construí un ataque de 3 pasos que
confirma esto: un llamador puede aprobar un expediente completo con un hash calculado
a mano (`sha256Hex("cualquier-cosa")`, sin relación alguna con `ExpedienteInputs`) y
`buildManifest` lo marca `"ready"` sin protesta — el mismo vector de fondo del hallazgo
original, ahora escondido detrás de una función bien diseñada que el paquete no fuerza
a nadie a usar. La frase del README "el llamador ya NO puede... pasar un hash arbitrario"
es, por tanto, **inexacta** tal como está escrita hoy.

Se encontraron además 5 hallazgos nuevos adicionales de severidad menor
(EX-EXP-18 a EX-EXP-22): una colisión de hash real en `stableStringify` con valores
`Date` (distinta del bug de `undefined` ya corregido), una laguna de visibilidad en
`TechnicalProposalBuilder` para requisitos condicionales marcados explícitamente "no
aplica" (desaparecen sin ningún rastro, a diferencia del caso "no evaluado" que sí deja
un bloqueo visible), un caso límite de fecha (`"24:00:00"`) que `Date` reinterpreta
silenciosamente al día siguiente sin lanzar, ausencia de un gate de cobertura CI para
este paquete (a diferencia de `packages/agents`, precedente AG-14), y desactualización
de `docs/ACEPTACION.md` respecto a los hallazgos ya cerrados en esta ronda.

**Conteo de veredictos (EX-EXP-01..16)**: **CERRADO: 14** (02, 03, 04, 05, 06, 07, 08,
09, 10, 12, 13, 14, 15, 16) · **PARCIAL: 2** (01, 11) · **NO CERRADO: 0**.

**Hallazgos nuevos de esta ronda**: 6 — EX-EXP-17 (ALTA, mismo hilo que 01/11),
EX-EXP-18 (MEDIA), EX-EXP-19 (BAJA/MEDIA), EX-EXP-20 (BAJA), EX-EXP-21 (BAJA,
documental/CI), EX-EXP-22 (BAJA, documental).

**Regresión en consumidores**: `npm run -w apps/api typecheck` → **OK, exit 0**. No
aplica en sentido estricto: `grep -rln "@atiende/expediente" apps/ packages/`
(excluyendo el propio paquete) sigue sin coincidencias — ningún consumidor real existe
todavía, igual que en la ronda 1.

**A6–A15**: el flujo integrado (`test/expediente-flow.test.ts`) sigue ejercitando
correctamente bases → matriz → propuesta → checklist → aprobación → ZIP **dentro de la
librería pura**, con el docstring ya honesto desde EX-EXP-16 (verificado: no sobreestima
A6-A15). `docs/ACEPTACION.md` (último tocado en `d8e6d29`, ANTERIOR a los 8 commits de
esta ronda de corrección) sigue correctamente PENDIENTE en su veredicto agregado, pero
sus notas de justificación por criterio están desactualizadas (ver EX-EXP-22).

---

## 1. Reproducibilidad

| Paso | Resultado | Evidencia |
|---|---|---|
| `npm install` (worktree nuevo) | OK, 677 paquetes | log |
| `npm run -w packages/expediente typecheck` | OK, exit 0 | log |
| `npm run -w packages/expediente lint` | OK, exit 0 | log |
| `npm run -w packages/expediente test` | **16 archivos / 364 pruebas, todas en verde** — idéntico a lo declarado en `docs/logs/fix-expediente-ronda2.log` | log |
| `npm run -w packages/expediente build` | OK, exit 0 | log |
| `npx vitest run --coverage` | Statements 93.15% · Branches 90.24% (antes 90.11% en la primera corrida, ambas por encima de 88.4% de ronda 1) · Funcs 93.69% · Lines 93.15% | log |
| `npm run -w apps/api typecheck` | OK, exit 0 — sin regresión | log |
| 35 pruebas adversariales propias (7 archivos temporales) | 35/35 en verde tras corregir 2 expectativas erróneas propias; suite total 399/399 | log |

**Veredicto: CUMPLE.** Reproducibilidad perfecta y cobertura real **mejoró** respecto a
la ronda 1 (93.15/90.24/93.69% vs. 91.03/88.4/89.1%), consistente con que
`proposal-version.ts` ya no tiene funciones sin ejercitar: subió de 68.75%/33.33%
(stmts/funcs) a **95.69%/100%** — `getVersion()`, `latest()`, `all()` e
`inputChanged()` (vía `changedInputsSince`) ya se llaman desde tests reales.

---

## 2. Tabla de reverificación por hallazgo

### EX-EXP-01 / EX-EXP-11 — Invalidación automática por hash de insumos (CRÍTICA / ALTA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (tarifa $850→$2,550 tras aprobación) | **Falla el ataque (correcto).** Sin cambios respecto a ronda 1. | `test/proposal-invalidation.test.ts` |
| Variantes `.a`/`.b` de ronda 1 (documento de empresa sustituido / nueva versión de bases tras aprobación, sin incluir en el hash) | **Falla el ataque (correcto, CERRADO).** `ExpedienteInputs` ahora exige `companyDocuments`/`tenderVersionHash` como campos OBLIGATORIOS (no omitibles) del conjunto que entra a `computeInputsHash`; si el llamador usa `computeInputsHash` para construir su `currentInputsHash`, cualquier cambio en esos campos sí se refleja. | `src/proposal-version.ts:60-77`, `test/proposal-invalidation.test.ts` describe "EX-EXP-11" |
| Variante `.c` de ronda 1 (colisión por clave `undefined`) | **Falla el ataque (correcto, CERRADO).** `UNDEFINED_SENTINEL` en `sortKeysDeep` distingue `{x: undefined}` de `{}`. Verificado de nuevo independientemente (`stableStringify({a:1,b:undefined})` ≠ `stableStringify({a:1})`). | `src/types.ts:158-176` |
| **Ataque nuevo (3 pasos): ¿puede el llamador pasar un hash precalculado por otra vía, sin usar `computeInputsHash`?** | **Éxito del ataque (hallazgo nuevo, ALTA).** `approve({..., inputsHash: sha256Hex("cualquier-cosa-que-el-llamador-decida")})` se acepta (`ok: true`); `PackageAssembler.buildManifest({..., currentInputsHash: <mismo hash de mano>})` produce `status: "ready"`. Ni `Approval.inputsHash` ni `AssembleInput.currentInputsHash` son un tipo opaco/marcado — son `string` planos — y ni `approve()` ni `buildManifest()` verifican en runtime que ese string provenga de `computeInputsHash`. El "conjunto cerrado y obligatorio" existe como *función*, pero no como *contrato exigido en el punto de uso*. | 3 tests propios (`_attack_ex01_bypass.test.ts`, eliminado tras la corrida — ver log sección 6); `src/approval-workflow.ts:120-150` (`inputsHash: string`), `src/package-assembler.ts:60-70` (`currentInputsHash: string`) → **EX-EXP-17** |
| **Ataque nuevo: `stableStringify`/`sha256Hex` sobre un valor `Date`** | **Éxito del ataque (hallazgo nuevo, MEDIA).** `sortKeysDeep` trata cualquier `typeof value === "object"` no-array como si tuviera propiedades enumerables propias; `Object.entries(new Date(...))` devuelve `[]`, así que **cualquier `Date`** se serializa como `"{}"`. `sha256Hex(new Date("2026-01-01"))` === `sha256Hex(new Date("2099-12-31"))` — colisión real entre fechas distintas. `sha256Hex`/`stableStringify` son parte de la API pública (`export * from "./types.js"` en `index.ts`). Ninguno de los tipos de `ExpedienteInputs` usa `Date` (todos son `string`), así que el paquete no se autoexplota con esto hoy, pero es una trampa latente para cualquier futuro uso interno o externo de estas utilidades exportadas. | `src/types.ts:167-176`; test propio (eliminado) → **EX-EXP-18** |
| Ataque nuevo: `computeInputsHash` con las 3 categorías de arreglo vacías (expediente sin documentos/tarifas/plantillas) | **No lanza (diseño aceptado, no es un hallazgo nuevo).** `requireArray` solo exige que el campo exista como arreglo, no que tenga elementos — un expediente sin ningún documento de empresa/tarifa/plantilla es estructuralmente "válido" para el hash aunque sea absurdo en la práctica real; el paquete no puede (ni debería, siendo una librería pura sin contexto de negocio) juzgar si "cero documentos" es razonable para una licitación concreta. | test propio (eliminado) |
| Ataque nuevo: orden de documentos/tarifas dentro de `ExpedienteInputs` | **Falla el ataque (correcto).** `buildInputComponents` ordena `companyDocuments`/`rates`/`templates` por `documentId`/`concept`/`templateId` antes de hashear — el orden de entrada del llamador no afecta el hash. | `src/proposal-version.ts:119-138` (`.sort(...)`) |
| Ataque nuevo: `__proto__` como clave JSON-parseada dentro de un objeto a hashear | **Falla el ataque (correcto, sin contaminación de prototipo).** `sortKeysDeep` usa `Object.entries`, que no atraviesa la cadena de prototipos; una clave literal `"__proto__"` de un objeto JSON-parseado se trata como dato normal. | test propio (eliminado) |

**Veredicto: PARCIAL** (se mantiene el veredicto de ronda 1, por una razón distinta y
más profunda). El mecanismo de cálculo de hash (`computeInputsHash`) es ahora correcto,
completo y bien probado para el conjunto cerrado de insumos que declara — las 3
variantes de ataque de la ronda 1 (`.a`, `.b`, `.c`) ya no funcionan **si el llamador usa
esa función**. Pero el paquete no impone que se use: `approve()`/`buildManifest()`
siguen aceptando cualquier `string` como hash de insumos, exactamente como antes de
toda esta ronda de corrección. La afirmación del README/commit "el llamador ya NO puede
pasar un hash arbitrario ni 'olvidar' un insumo" es válida solo como *convención
documental*, no como *garantía verificable por el propio paquete* — ver EX-EXP-17.

### EX-EXP-02 / EX-EXP-14 — scope "expediente" exige scopeRef == "expediente" (CRÍTICA / MEDIA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original y variantes `.a`/`.b` de ronda 1 | **Falla el ataque (correcto), sin cambios.** | `test/package-assembler.test.ts` |
| Variante `.c` de ronda 1 (`scopeRef` arbitrario con `scope: "expediente"`) | **Falla el ataque (correcto, CERRADO).** `approve()` rechaza (`scope_scopeRef_inconsistente`) si `scope === "expediente"` y `scopeRef !== "expediente"`; `buildManifest` filtra además por `scopeRef === "expediente"` como defensa en profundidad independiente. | `src/approval-workflow.ts:131-141`, `src/package-assembler.ts:122-124` |
| **Ataque nuevo: `scopeRef: "expediente "` (con espacio final)** | **Falla el ataque (correcto).** Comparación `!==` estricta de cadena; el espacio hace que sea un valor distinto y se rechaza igual que cualquier otro. | test propio (eliminado) |
| **Ataque nuevo: `scopeRef: "Expediente"` (mayúscula inicial)** | **Falla el ataque (correcto).** Comparación case-sensitive. | test propio (eliminado) |
| **Ataque nuevo: aprobación de expediente sobre una versión ANTERIOR** (hash viejo) | **Falla el ataque (correcto).** `buildManifest` exige `a.inputsHash === input.currentInputsHash`; una aprobación con `inputsHash: "hash-v1"` evaluada contra `currentInputsHash: "hash-v2"` produce `status: "draft"` con `draftReasons` incluyendo `"aprobacion_vigente_con_hash_insumos_divergente"`. `isFullyApprovedForCurrentHash` además invalida la aprobación PERMANENTEMENTE (`status: "invalidada"`), no solo la ignora para esa evaluación puntual. | test propio (eliminado); mecanismo compartido con EX-EXP-01 |

**Veredicto: CERRADO.** Las 5 variantes probadas (2 de ronda 1 ya cerradas, 3 nuevas de
esta ronda) fallan todas correctamente. Es el hallazgo con la defensa más robusta y
mejor generalizada de todo el paquete.

### EX-EXP-03 / EX-EXP-12(a) — Requisito condicional que aplica ya no desaparece (CRÍTICA / ALTA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (`obligatorio` sin evidencia) y variante `.a` de ronda 1 (`condicional` que aplica, sin evidencia) | **Falla el ataque (correcto, CERRADO).** `evaluateObligatorioLike` distingue `obligatorio` / `condicional_aplica` / `no_evaluable` (fail-closed, bloqueo `condicion_no_evaluable`) / `no_aplica` (solo `opcional`, o `condicional` declarado explícitamente `false` en `conditionEvaluations`). | `src/technical-proposal.ts:52-79`, `test/technical-proposal.test.ts` |
| Invariante de propiedad (200 casos aleatorios deterministas) | **Se sostiene en los 200 casos.** `sections.length + omisiones_justificadas.length === total_requisitos_relevantes` para cada combinación aleatoria de `obligatoriedad`/evidencia/`conditionEvaluations`. | `test/technical-proposal-property.test.ts` (ejecutado de nuevo, 200/200 verde) |
| **Ataque nuevo: dos requisitos con el MISMO `id`** | **Genera 2 secciones con el mismo `id: sec-<id>` (colisión de clave, cosmético, no fabricación — mismo patrón ya aceptado en ronda 1 para "requisito duplicado en dos documentos", no se numera de nuevo).** Ambas secciones se generan igual (ninguna se pierde), solo comparten `id` de sección — un consumidor que indexe por `id` en un `Map`/objeto perdería una silenciosamente, pero el array `sections` en sí conserva ambas. | test propio (eliminado) |
| **Ataque nuevo: ¿un `condicional` marcado explícitamente `no_aplica` (`false`) queda "visible" en el resultado, o desaparece sin rastro?** | **Éxito del ataque (hallazgo nuevo, BAJA/MEDIA).** `TechnicalProposal` solo expone `{ sections, blockers }`; cuando `kind === "no_aplica"` el código hace `continue` sin agregar nada a ninguno de los dos arreglos. El resultado es indistinguible de "este requisito nunca se incluyó en absoluto" — contrasta con el caso `no_evaluable`, que SÍ deja un `SectionBlocker` visible (`condicion_no_evaluable`). El propio test de propiedad tiene que RECALCULAR externamente el conjunto de omisiones justificadas replicando la misma regla de negocio (`isProceduralOmission`) porque no hay ninguna señal inspeccionable en el objeto de salida. | `src/technical-proposal.ts:34-37` (`TechnicalProposal` sin campo de omisiones), `test/technical-proposal-property.test.ts:94-99` (recomputa la regla) → **EX-EXP-19** |

**Veredicto: CERRADO** para el defecto central (ningún requisito objetivamente
aplicable desaparece sin una decisión explícita y trazable en `conditionEvaluations`).
El hallazgo nuevo EX-EXP-19 es una laguna de auditabilidad, no una reaparición del
defecto original: ahora requiere una acción explícita del llamador para omitir, pero esa
acción no deja rastro dentro del propio artefacto (`TechnicalProposal`) que se envía
aguas abajo.

### EX-EXP-04 / EX-EXP-13 — Offset horario y validez calendárica (fail-closed) (CRÍTICA / ALTA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataque original (naive/TZ-dependiente) y variantes de ronda 1 (`"+99:00"`, 29-feb en año no bisiesto) | **Falla el ataque (correcto, CERRADO), sin cambios.** | `test/timezone-determinism.test.ts` (6 casos, incluye el nuevo de `9845ecf`: `"not-a-date-Z"` para cubrir la última rama `Number.isNaN`) |
| **Ataque nuevo: límites exactos `"+14:00"` y `"-12:00"`** | **Se aceptan (correcto).** Son los extremos reales válidos del rango de offsets horarios del mundo. | test propio (eliminado) |
| **Ataque nuevo: `"+14:01"` y `"-12:01"` (1 minuto más allá del límite real)** | **Se rechazan (correcto).** `assertOffsetInRange` calcula minutos totales con signo y compara contra `±14*60`/`-12*60` exactos. | test propio (eliminado) |
| **Ataque nuevo: segundos fraccionarios (`".999"`)** | **No rompe nada (correcto).** El regex de offset solo mira el sufijo; el prefijo con fracción de segundo no interfiere. | test propio (eliminado) |
| **Ataque nuevo: año 1899** | **Se acepta sin error.** No es un hallazgo: ISO 8601 no prohíbe años pasados, y una plausibilidad de "¿es razonable una licitación con fecha de 1899?" es una decisión de negocio de `apps/api`, no de esta librería pura de validación de formato/rango. | test propio (eliminado) |
| **Ataque nuevo: año 10000 (5 dígitos)** | **Se rechaza (correcto), pero por una vía distinta a la esperada.** `ISO_DATE_PREFIX_PATTERN` (`^(\d{4})-(\d{2})-(\d{2})`) no calza con un año de 5 dígitos seguido de "-" (el "5" extra rompe el ancla), así que `assertValidCalendarComponents` NO valida nada para este caso (`match` es `null`, retorna temprano) — pero la defensa final `Number.isNaN(new Date(trimmed).getTime())` sí lo atrapa, porque V8 no acepta un año expandido de 5 dígitos sin signo explícito (`+010000-...`) y produce `Invalid Date`. Correcto en el resultado, por una defensa distinta a la calendárica específica. | test propio (eliminado) |
| **Ataque nuevo: hora `"24:00:00Z"` (representación ISO 8601 válida de medianoche del día siguiente)** | **Éxito del ataque (hallazgo nuevo, BAJA).** Ni `assertOffsetInRange` ni `assertValidCalendarComponents` validan el componente de HORA (`HH:MM:SS`) — solo offset y AAAA-MM-DD. `new Date("2026-06-15T24:00:00Z")` no produce `NaN`: V8 la reinterpreta silenciosamente como `2026-06-16T00:00:00.000Z` (un día después). La defensa final `Number.isNaN` no la atrapa porque el resultado ES una fecha válida, solo que no es la fecha "escrita" — mismo patrón exacto que el bug de 29-feb que EX-EXP-13 corrigió para el componente de FECHA, pero no extendido al componente de HORA. Confirmado que CUALQUIER otra hora/minuto/segundo fuera de rango (25:00, 23:60, 00:00:60, etc.) sí produce `NaN` y se rechaza correctamente — es un caso único y angosto. | `src/types.ts:70-81` (`assertValidCalendarComponents` solo mira `ISO_DATE_PREFIX_PATTERN`, no la hora); test propio (eliminado) → **EX-EXP-20** |

**Veredicto: CERRADO.** La garantía central (fail-closed ante offset ausente,
numéricamente imposible, o fecha calendáricamente inválida) es sólida y se generalizó
correctamente a todos los límites reales probados. El hallazgo nuevo (EX-EXP-20) es
angosto y de severidad baja: requiere que una fuente de datos emita literalmente
`"T24:00:00"` en vez de `"T00:00:00"` del día siguiente, un patrón raro pero real en
algunos sistemas/exportadores.

### EX-EXP-05 / EX-EXP-12(b) — Apócope "un"/"veintiún" generalizado (ALTA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Casos oficiales de ronda 1 (121, 221, 1121, 2121, 21121, 121000, 121000000) | **Falla el ataque (correcto), sin cambios.** | `test/number-to-words.test.ts` |
| **Ataques nuevos del mandato: 21000, 1,000,021, 21.01, 100,000,021, 31, "VEINTIÚN MIL VEINTIÚN PESOS 21/100" (21,021.21), 1 peso, 0 pesos, 121000** | **Falla el ataque en los 9 casos (correcto).** Verificado exactamente: `centsToPesosWords` produce `"SON: VEINTIÚN MIL PESOS 00/100 M.N."` (21000), `"SON: UN MILLÓN VEINTIÚN PESOS 00/100 M.N."` (1000021), `"SON: VEINTIÚN PESOS 01/100 M.N."` (21.01), `"SON: CIEN MILLONES VEINTIÚN PESOS 00/100 M.N."` (100000021), `"SON: TREINTA Y UN PESOS 00/100 M.N."` (31 — con apócope, correcto: "treinta y un" antecede a "PESOS"), `"SON: VEINTIÚN MIL VEINTIÚN PESOS 21/100 M.N."` (21021.21, cadena EXACTA pedida por el mandato), `"SON: UN PESO 00/100 M.N."` (1 peso, singular correcto), `"SON: CERO PESOS 00/100 M.N."` (0 pesos, sin apócope espurio), `"SON: CIENTO VEINTIÚN MIL PESOS 00/100 M.N."` (121000). | 10 tests propios (eliminados) |
| Confirmación de la distinción de diseño: `integerToWords(31)` (forma cardinal aislada) NO apocopa (`"treinta y uno"`), pero `integerToWords(21000)` SÍ apocopa (`"veintiún mil"`, porque 21 antecede a "mil", un sustantivo dentro del propio número) | **Comportamiento correcto y coherente con el docstring del módulo.** | `src/number-to-words.ts:106-125` |

**Veredicto: CERRADO.** La generalización de la reparación es sólida: se probó toda la
familia de casos pedida explícitamente por el mandato (incluida la cadena literal
exacta "VEINTIÚN MIL VEINTIÚN PESOS 21/100") y ninguno falló.

### EX-EXP-06 / EX-EXP-15 — Fecha numérica ambigua baja `confidence` (ALTA / MEDIA)

| Vector | Resultado | Evidencia |
|---|---|---|
| Ataques originales (`"15/10/2026"`, `"del AAAA"`) y variante `.a` de ronda 1 (`"05/09/2026"` ambigua) | **Falla el ataque (correcto, CERRADO).** `ambiguousDate = day <= 12 && day !== month` (con `month` ya garantizado `<=12` por el `if` que lo envuelve) baja `confidence` a 0.5 cuando ambas lecturas DD/MM y MM/DD son calendáricamente válidas y distintas, sin cambiar la interpretación por defecto. | `test/requirement-matrix.test.ts` describe "EX-EXP-15" (3 casos: ambigua, inequívoca, día===mes) |
| Verificación de trazabilidad del commit `587d4a2` | **Confirmado por `git show`:** el diff de `requirement-matrix.ts`/`requirement-matrix.test.ts`/README para EX-EXP-06/15 está íntegro dentro de ese commit (mezclado con AG-17..22 por una condición de carrera de índice de git documentada en `docs/auditoria-1/expediente-reverificacion.md` §6), tal como afirma la tabla de "Estado reparación". | `git show 587d4a2 -- packages/expediente/` (26 líneas modificadas en `requirement-matrix.ts`, 58 líneas nuevas de test) |
| Revisión de la lógica `day <= 12 && day !== month` | **Correcta.** Como `month` ya está acotado a `[1,12]` por la condición externa, la ambigüedad real (ambas lecturas ≤12) queda cubierta; `day === month` se excluye correctamente porque ambas lecturas producen la misma fecha. | Inspección de código, sin necesidad de test adicional |

**Veredicto: CERRADO.**

### EX-EXP-07, EX-EXP-08, EX-EXP-09, EX-EXP-10 (MEDIA/BAJA)

Sin cambios de código desde la ronda 1 (`git diff --stat 49141fb..HEAD -- packages/expediente/src/` confirma que `money.ts`, `integrity-checklist.ts`, `company-data.ts`, `economic-proposal.ts`, `index.ts` y `llm/extractor.ts` no se tocaron en esta ronda). Suite completa sigue en verde para sus respectivos tests (`money.test.ts`, `integrity-checklist.test.ts`, `company-data.test.ts`, `economic-proposal.test.ts`). Sin regresión.

**Veredicto: CERRADO** (heredado de ronda 1, sin cambios, sin regresión).

### EX-EXP-16 — Docstring de `expediente-flow.test.ts` no sobreestima A6-A15 (BAJA, documental)

Se leyó el docstring actual (`test/expediente-flow.test.ts:17-29`): ahora afirma
explícitamente que el test "ejercita el flujo completo DENTRO DE LA LIBRERÍA PURA...
es una precondición NECESARIA pero NO SUFICIENTE para A6-A15... Este test NO certifica
A6-A15 por sí solo". Coherente con `docs/ACEPTACION.md`, que mantiene A6-A15 en
PENDIENTE. Sin cambio de aserciones (confirmado: mismo conteo de tests que antes, 3
tests en ese archivo).

**Veredicto: CERRADO (documentación).**

---

## 3. Preguntas específicas del mandato

**¿`computeInputsHash` con categorías vacías permite un expediente sin documentos?**
Sí — `requireArray` solo exige que `companyDocuments`/`rates`/`templates` existan como
arreglos, no que tengan elementos; un expediente con las 3 categorías vacías produce un
hash válido sin error. Esto es correcto para una librería pura sin contexto de negocio
(no puede juzgar si "cero documentos" es razonable para una licitación concreta) — no
se eleva a hallazgo nuevo.

**¿Orden de documentos, mismo documento con hash igual pero vigencia distinta?**
El orden no afecta el hash (`buildInputComponents` ordena por `documentId`/`concept`/
`templateId` antes de serializar). Un documento con el mismo `hash` de contenido pero
`vigenteHasta` distinto SÍ produce un hash de insumos distinto, porque `raw` incluye
`{ hash, vigenteHasta }` como par — verificado por inspección de
`src/proposal-version.ts:126-131`.

**¿`undefined` vs `null` vs ausente en `stableStringify`? ¿Objetos con prototipo? ¿Date
vs string?**
`undefined`/`null`/ausente producen los 3 hashes distintos entre sí (verificado). Un
objeto con prototipo (instancia de clase) produce el MISMO hash que su equivalente
plano — correcto, el prototipo no debería importar para el hash de datos. `Object.
create(null)` se serializa igual que un objeto plano — correcto. **`Date` colapsa a
`"{}"`** — hallazgo nuevo, ver EX-EXP-18.

**¿Puede el consumidor pasar un hash precalculado por otra vía (constructor, setter,
manifest)?**
**Sí, confirmado por ataque directo** — ver EX-EXP-17. Este es el hallazgo más
importante de esta ronda de reverificación: la mitigación de EX-EXP-01/11 no es
"obligatoria" en el sentido que el README/commit afirman, es "disponible pero
opcional".

**¿Condicional cuya condición depende de dato de empresa ausente?**
Fuera del alcance verificable de este paquete: `conditionEvaluations` es un
`Record<string, boolean>` que el LLAMADOR construye externamente (posiblemente a partir
de datos de empresa); el paquete no deriva automáticamente la aplicabilidad de ningún
dato de `CompanyDataService`. Si `apps/api` deriva `conditionEvaluations[id]` de un
campo de empresa que resulta `missing`, la responsabilidad de propagar eso como
`no_evaluable` (nunca inferir `false` de un dato ausente) recae en `apps/api`, no en
`packages/expediente` — consistente con el diseño de librería pura ya aceptado en la
ronda 1 para escenarios similares (EX-EXP-07/08).

**¿Condicional que NO aplica queda como no aplicable VISIBLE, o desaparece?**
**Desaparece sin ningún rastro** en el objeto `TechnicalProposal` — ver EX-EXP-19.

**¿Invariante de conteo con requisitos duplicados por id?**
Se generan 2 secciones (ninguna se pierde), pero ambas comparten el mismo `id: sec-<id>`
de sección — colisión cosmética de clave, mismo patrón ya evaluado y no elevado en la
ronda 1 para "requisito duplicado en dos documentos".

**EX-EXP-05: 21000, 1000021, 21.01, 100000021, 31 (no apócope), cadena exacta "VEINTIÚN
MIL VEINTIÚN PESOS 21/100", 1 peso, 0 pesos**: todos verificados correctos — ver tabla
EX-EXP-05 arriba.

**EX-EXP-04: "+14:00" límite, "-12:00", "+14:01", "24:00:00", segundos fraccionarios,
año 1899, año 10000**: todos verificados — ver tabla EX-EXP-04 arriba. Único hallazgo:
`"24:00:00"` (EX-EXP-20).

**EX-EXP-02: scopeRef "expediente " con espacio, "Expediente" mayúscula, aprobación de
expediente sobre versión anterior**: los 3 fallan correctamente — CERRADO confirmado.

**EX-EXP-06/15 (arrastrado en 587d4a2)**: contenido verificado completo y coherente con
su test vía `git show`; no es una afirmación sin respaldo.

**A6–A15**: el flujo integrado end-to-end (`test/expediente-flow.test.ts`) sigue
cubriendo, dentro del límite honesto de "librería pura" que su propio docstring declara
desde EX-EXP-16, los mismos escenarios de la tabla del README ("Pruebas de aceptación
cubiertas"). No se degradó ni se infló ningún estado. `docs/ACEPTACION.md` en su commit
actual (`d8e6d29`) es ANTERIOR a los 8 commits de esta ronda de corrección — sus notas
de A6 ("EX-EXP-03 NO CERRADO"), A7 ("EX-EXP-04/13 PARCIAL"), A9 y A11
("EX-EXP-01/EX-EXP-11 corregidos... sin reverificar") ya no reflejan el estado actual
verificado en esta reverificación (EX-EXP-03/12(a), 04/13, 06/15 CERRADO; EX-EXP-01/11
sigue PARCIAL pero por una razón distinta a la original). El veredicto agregado PENDIENTE
de A6-A15 sigue siendo correcto (no hay integración real API/UI todavía), pero las
justificaciones citadas están desactualizadas — ver EX-EXP-22.

**Cobertura vs gate**: `packages/expediente` NO tiene `vitest.config.ts` con
`coverage.thresholds` ni un script `test:coverage` en su `package.json`, a diferencia de
`packages/agents` (que sí los tiene desde el hallazgo AG-14: thresholds 85/80/85/85).
`.github/workflows/quality.yml` hace fallback silencioso a `npm run test` (sin
cobertura) para cualquier workspace sin script `test:coverage` — confirmado por
inspección del workflow (líneas 40-78) y de `packages/expediente/package.json`
(`scripts` no incluye `test:coverage`). Esto significa que una futura regresión de
cobertura en este paquete (p. ej. reintroducir código muerto como el `inputChanged()`
original) **no sería detectada por CI** — ver EX-EXP-21.

**Regresión en `apps/api`**: `npm run -w apps/api typecheck` → OK, exit 0. Sin
regresión, y sigue sin aplicar en sentido estricto porque no hay import real de
`@atiende/expediente` en `apps/`.

---

## 4. Tabla de hallazgos nuevos (EX-EXP-17 a EX-EXP-22)

| ID | Severidad | Relacionado con | Hallazgo | Evidencia | Reparación sugerida (separada del hallazgo) |
|---|---|---|---|---|---|
| EX-EXP-17 | **ALTA** | EX-EXP-01, EX-EXP-11 | `ApprovalWorkflow.approve()` y `PackageAssembler.buildManifest()` aceptan `inputsHash`/`currentInputsHash` como `string` plano, sin tipo opaco/marcado ni verificación runtime de que ese valor provenga de `computeInputsHash(ExpedienteInputs)`. Se confirmó por ataque directo: un `inputsHash`/`currentInputsHash` calculado a mano (`sha256Hex("cualquier-cosa")`, sin relación con `ExpedienteInputs`) se acepta igual y produce `manifest.status: "ready"`. El "conjunto cerrado y obligatorio" de insumos existe como función bien diseñada, pero no como contrato exigido en el punto de uso — reproduce, de forma más sutil, el defecto estructural original que EX-EXP-01/11 pretendían cerrar. La afirmación del README ("el llamador ya NO puede... pasar un hash arbitrario") es válida solo como convención documental, no como garantía verificable por el paquete. | `src/approval-workflow.ts:120` (`inputsHash: string` en la firma de `approve`), `src/package-assembler.ts:69` (`currentInputsHash: string` en `AssembleInput`); ataque propio de 3 pasos (test eliminado, ver log) | Introducir un tipo marcado/opaco (p. ej. `type InputsHash = string & { readonly __brand: "ExpedienteInputsHash" }`) que solo `computeInputsHash`/`ProposalVersionRegistry.createVersion` puedan producir, y cambiar las firmas de `approve()`/`AssembleInput.currentInputsHash` para exigir ese tipo en vez de `string` — TypeScript rechazaría en tiempo de compilación cualquier hash que no pase por la función canónica. Alternativamente (defensa en runtime, más fuerte frente a `any`/JS puro), mantener una tabla interna de hashes válidos emitidos por `computeInputsHash` en el proceso y hacer que `approve()` los valide contra ella. |
| EX-EXP-18 | MEDIA | EX-EXP-01, EX-EXP-11 | `stableStringify`/`sha256Hex` (públicas, re-exportadas desde `index.ts`) colapsan cualquier valor `Date` a `"{}"` porque `sortKeysDeep` trata `typeof value === "object"` como "objeto con propiedades enumerables" sin distinguir `Date` (que no tiene propiedades propias enumerables) — `sha256Hex(new Date("2026-01-01"))` === `sha256Hex(new Date("2099-12-31"))`, una colisión real entre valores lógicamente distintos. Ninguno de los campos de `ExpedienteInputs` usa `Date` hoy (todos son `string`), así que el paquete no se autoexplota, pero es una trampa latente para cualquier código futuro (interno o de `apps/api`, que sí re-exporta e importa estas utilidades) que hashee un valor `Date` directamente. | `src/types.ts:167-176` (`sortKeysDeep`); test propio (eliminado) | Detectar `value instanceof Date` en `sortKeysDeep` (antes de la rama genérica de objeto) y serializarlo explícitamente como `value.toISOString()` (o lanzar, si se prefiere forzar que el llamador siempre normalice a string antes de hashear). |
| EX-EXP-19 | BAJA/MEDIA | EX-EXP-03, EX-EXP-12 | Un requisito `condicional` marcado EXPLÍCITAMENTE como no aplicable (`conditionEvaluations[id] === false`) desaparece de `TechnicalProposal` (`{ sections, blockers }`) sin dejar NINGÚN rastro — indistinguible de "este requisito nunca se incluyó". Contrasta con el caso `no_evaluable` (aplicabilidad no declarada), que sí deja un `SectionBlocker` visible con `field: "condicion_no_evaluable"`. El propio `test/technical-proposal-property.test.ts` tiene que recalcular externamente el conjunto de "omisiones justificadas" replicando la misma regla de negocio del builder (`isProceduralOmission`), precisamente porque no hay ninguna señal inspeccionable en el objeto de salida que un futuro auditor/UI pueda usar para reconstruir "qué se excluyó y por qué lo decidió quién". No es una reaparición del defecto original (ahora requiere una decisión explícita del llamador, nunca se infiere en silencio de `obligatoriedad` a secas), pero sí una laguna de auditabilidad sobre esa decisión. | `src/technical-proposal.ts:34-37` (`TechnicalProposal` sin campo de omisiones), `test/technical-proposal-property.test.ts:94-99`; test propio (eliminado) | Agregar un tercer campo a `TechnicalProposal` (p. ej. `omittedRequirements: { requirementId: string; reason: "opcional" | "condicional_no_aplica" }[]`) que registre TODAS las omisiones (procedimentales y condicionales explícitamente no aplicables) con su razón, en vez de simplemente `continue`-arlas sin dejar rastro. |
| EX-EXP-20 | BAJA | EX-EXP-04, EX-EXP-13 | `assertExplicitOffset`/`assertValidCalendarComponents` no validan el componente de HORA (`HH:MM:SS`) de la fecha, solo el offset y el prefijo `AAAA-MM-DD`. La hora `"24:00:00"` (representación ISO 8601 válida de la medianoche del día SIGUIENTE) pasa sin error; `new Date("2026-06-15T24:00:00Z")` no produce `NaN` — V8 la reinterpreta silenciosamente como `2026-06-16T00:00:00.000Z`, un día después del literal escrito. La defensa final `Number.isNaN` no lo atrapa porque el resultado ES una fecha válida, solo que no es la que el documento fuente realmente escribió — mismo patrón exacto que el bug de 29-feb ya corregido para el componente de FECHA, pero no extendido al componente de HORA. Confirmado que cualquier otro valor de hora/minuto/segundo fuera de rango (25:00, 23:60, 00:00:60) sí produce `NaN` y se rechaza correctamente — es un caso único y angosto. | `src/types.ts:70-81`; test propio (eliminado) | Extender `assertValidCalendarComponents` (o una función hermana) para capturar también `THH:MM:SS` del prefijo ISO y rechazar explícitamente `HH === "24"` salvo que `MM:SS === "00:00"` exacto (en cuyo caso, si se quiere seguir aceptando esa forma, normalizarla explícitamente al día siguiente en vez de confiar en que `Date` lo haga en silencio) — o simplemente rechazar `"24:00:00"` sin excepción y exigir que el llamador normalice a `"00:00:00"` del día siguiente antes de pasarlo. |
| EX-EXP-21 | BAJA (CI/proceso) | EX-EXP-01 (cobertura de `proposal-version.ts`) | `packages/expediente/package.json` no declara un script `test:coverage`, y el paquete no tiene `vitest.config.ts` con `coverage.thresholds` — a diferencia de `packages/agents`, que sí los tiene desde el hallazgo AG-14 (thresholds 85/80/85/85). `.github/workflows/quality.yml` (líneas 40-78) hace fallback silencioso a `npm run test` (sin flag de cobertura) para cualquier workspace sin `test:coverage`, así que CI nunca falla por una caída de cobertura en este paquete — una regresión futura (p. ej. volver a dejar `inputChanged()`/`getVersion()`/`latest()` sin ejercitar, como ocurría antes de esta ronda) pasaría inadvertida en CI. | `.github/workflows/quality.yml:40-78`; `packages/expediente/package.json` (`scripts` sin `test:coverage`); comparación con `packages/agents/package.json` y `packages/agents/vitest.config.ts` | Copiar el patrón de `packages/agents` (AG-14): agregar `"test:coverage": "vitest run --coverage"` al `package.json` de `packages/expediente` y un `vitest.config.ts` con `coverage.thresholds` calibrados contra la cobertura real medida en esta ronda (93.15/90.24/93.69/93.15%, con margen). |
| EX-EXP-22 | BAJA (documental) | A6-A15 | `docs/ACEPTACION.md` (último commit `d8e6d29`) es ANTERIOR a los 8 commits de esta ronda de corrección de `packages/expediente` (`f5991f5`...`b19ced8`). Sus notas de justificación por criterio citan estados ya superados: A6/A9 dicen "EX-EXP-03 NO CERRADO (requisito condicional sin evidencia desaparece)" cuando esta reverificación confirma CERRADO con 200 casos de propiedad; A7 dice "EX-EXP-04/13 (PARCIAL, fail-open en offsets imposibles)" cuando esta reverificación confirma CERRADO (con el hallazgo nuevo, angosto, EX-EXP-20); A11 dice "EX-EXP-01/EX-EXP-11 corregidos (f5991f5) sin reverificar" cuando esta reverificación sí los reverificó (con veredicto PARCIAL, por EX-EXP-17, distinto al implícito en esa nota). El veredicto AGREGADO de A6-A15 (PENDIENTE) sigue siendo correcto — no cambia por esto, porque ninguno de A6-A15 puede cerrarse sin integración real API/UI — pero las justificaciones citadas inducen a un lector a subestimar/sobreestimar el estado real de `packages/expediente` según la fila. | `docs/ACEPTACION.md:202-211`; comparación de fechas de commit (`d8e6d29` vs. los 8 commits de esta ronda) | Actualizar las columnas de evidencia/nota de A6, A7, A9 y A11 en `docs/ACEPTACION.md` para reflejar el estado reverificado en `docs/auditoria-1/expediente-reverificacion-2.md` (EX-EXP-01/11 PARCIAL por EX-EXP-17; EX-EXP-03/12, 04/13, 06/15 CERRADO), sin cambiar el veredicto agregado PENDIENTE de ninguna fila (que sigue siendo correcto por falta de integración real). |

---

## 5. Comprobado correcto (verificado independientemente en esta ronda)

- Reproducibilidad exacta de typecheck/lint/build/test (16/364) y mejora real de
  cobertura (93.15/90.24/93.69% vs. 91.03/88.4/89.1% de ronda 1), con
  `proposal-version.ts` subiendo de 33.33% a 100% de funciones cubiertas.
- Los 8 commits de esta ronda son ancestros de `HEAD` y cada uno toca exactamente los
  archivos que su mensaje declara (`git show --stat`), incluyendo la confirmación
  independiente de que el fix de EX-EXP-06/15 sí está íntegro dentro de `587d4a2` pese
  al mensaje de commit no relacionado.
- `computeInputsHash`/`ExpedienteInputs` ordena determinísticamente sus arreglos antes
  de hashear (insensible al orden de entrada) y distingue correctamente `undefined`/
  `null`/ausente y objetos con/sin prototipo — solo falla con valores `Date` (EX-EXP-18).
- `scope === "expediente" ⟹ scopeRef === "expediente"` está protegido de forma
  case-sensitive, sin tolerancia a espacios, y con defensa en profundidad independiente
  en `approve()` y `buildManifest()` — la reparación más robusta de todo el paquete.
- Apócope de "un"/"veintiún" generalizado correctamente a toda la familia de magnitudes
  probada (miles, millones, con/sin centavos, límite singular "1 peso", "0 pesos" sin
  apócope espurio) — incluida la cadena literal exacta pedida por el mandato.
- Fail-closed de fechas: rango de offset (-12:00 a +14:00 exactos en los límites),
  validez calendárica del día/mes, y defensa final `NaN` — sólido para prácticamente
  todos los casos límite probados, con una única excepción angosta (EX-EXP-20).
- Ambigüedad DD/MM vs MM/DD correctamente detectada y reflejada en `confidence` sin
  cambiar la interpretación por defecto.
- El docstring de `test/expediente-flow.test.ts` ya no sobreestima A6-A15 (EX-EXP-16
  verificado íntegro).
- Sin regresión en `apps/api` (`typecheck` limpio); sin consumidores reales que evaluar
  todavía (`grep` sin coincidencias, igual que en ronda 1).
- `money.ts`, `integrity-checklist.ts`, `company-data.ts`, `economic-proposal.ts`,
  `index.ts`, `llm/extractor.ts` no se tocaron en esta ronda — cero riesgo de regresión
  en EX-EXP-07/08/09/10, confirmado también por la suite completa en verde.

---

## Notas de alcance

- Reverificación limitada a `packages/expediente/**`; no se evaluaron `packages/db` ni
  `apps/api`/`apps/web` (siguen sin implementación real que los conecte a este
  paquete, confirmado de nuevo por `grep`).
- El worktree de esta reverificación (`git worktree add`) y los 7 archivos de prueba
  adversariales temporales se eliminaron al finalizar; no queda ningún script ni cambio
  de código en el árbol principal — todos los hallazgos son de solo lectura sobre
  `packages/expediente/**` en `HEAD` (sin cambios en ese paquete desde el commit
  `9845ecf` durante toda esta reverificación).
- Se detectaron trabajos concurrentes de otros agentes en `apps/worker` y
  `packages/sources` durante esta sesión (no relacionados con `packages/expediente`,
  fuera del alcance de este mandato) — no se tocó ni se hizo `git add` de ningún
  archivo fuera de los dos entregables declarados de este mandato.

---

## 6. Balance del paquete `packages/expediente` (16 hallazgos originales + 6 nuevos)

**CERRADO (14/16 originales)**: EX-EXP-02, 03, 04, 05, 06, 07, 08, 09, 10, 12, 13, 14,
15, 16.

**PARCIAL (2/16 originales)**: EX-EXP-01, EX-EXP-11 (mismo hilo: el mecanismo de hash
existe y es correcto, pero no es obligatorio en el punto de uso — EX-EXP-17).

**NO CERRADO**: ninguno.

**Abiertos tras esta ronda (7, todos de severidad ALTA o menor, ninguno CRÍTICO)**:

| ID | Severidad | Resumen de una línea |
|---|---|---|
| EX-EXP-01/11 | ALTA (vía EX-EXP-17) | El hash de insumos "cerrado y obligatorio" no es obligatorio en runtime: `approve()`/`buildManifest()` aceptan cualquier `string`. |
| EX-EXP-17 | ALTA | (mismo hallazgo, numerado para esta ronda) — falta un tipo opaco/verificación runtime que fuerce el uso de `computeInputsHash`. |
| EX-EXP-18 | MEDIA | `stableStringify`/`sha256Hex` colapsan `Date` a `"{}"` (colisión real). |
| EX-EXP-19 | BAJA/MEDIA | `condicional` marcado "no aplica" desaparece sin rastro visible en `TechnicalProposal`. |
| EX-EXP-20 | BAJA | `"24:00:00"` se reinterpreta silenciosamente al día siguiente sin lanzar. |
| EX-EXP-21 | BAJA (CI) | Sin gate de cobertura CI para `packages/expediente` (a diferencia de `packages/agents`, AG-14). |
| EX-EXP-22 | BAJA (docs) | `docs/ACEPTACION.md` desactualizado respecto a los hallazgos ya cerrados en esta ronda. |

Ningún hallazgo abierto es de severidad CRÍTICA. El más importante (EX-EXP-01/11/17)
es estructural pero acotado: el mecanismo correcto EXISTE y está bien probado, falta
únicamente forzarlo en el punto de uso — una corrección de alcance pequeño y bien
definido (tipo marcado o verificación runtime), no un rediseño.
