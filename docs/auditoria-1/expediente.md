# Auditoría adversarial — packages/expediente (ronda 1)

**Ámbito auditado**: `packages/expediente/**` en el commit
`467be3222488d206b3dc6e965c355b0d3cf6547e`
("feat(expediente): motor del expediente de participación (REQ-156..171)").

**Auditor**: agente Sonnet independiente, sin participación en la construcción de este
paquete. Ejecución real de: `npm install`, `typecheck`/`lint`/`test`/`build`,
`vitest run --coverage`, ~10 pruebas adversariales propias (scripts `.mjs` ejecutados
contra el `dist/` compilado) y 5 mutaciones manuales de reglas clave — todo en un
`git worktree` separado (`git worktree add`), nunca en el árbol principal. El worktree fue
eliminado al terminar; no queda ningún script ni archivo de prueba adversarial en el
repositorio.

**Comandos y salida completa**: `docs/logs/audit-expediente-ronda1.log`.

---

## Resumen ejecutivo

`packages/expediente` es una librería TypeScript pura, bien documentada y con una
arquitectura correcta en su capa determinista: aritmética monetaria en `bigint` con
half-up explícito, `CompanyDataService` que nunca produce un `ok` sin `source_ref`,
`EconomicProposalBuilder` que nunca genera un total parcial si cualquier concepto está
bloqueado, y un `test/api-surface.test.ts` que verifica en runtime que no existe ninguna
función de envío/firma/actuación ni import de red — verificación que se repitió
independientemente por grep y dio el mismo resultado limpio. La reproducibilidad es
perfecta: 11 archivos / 84 pruebas en verde, typecheck/lint/build limpios, idéntico a
`docs/logs/expediente-ronda1.log`. Las 5 mutaciones manuales pedidas por el mandato
(ready gate, autoaprobación, vencimiento, precio no aprobado, invalidación jerárquica)
fueron **todas detectadas** por la suite existente.

Sin embargo, la auditoría adversarial encontró que **la garantía central del paquete —
"nunca listo si incompleto" (REQ-159/REQ-162/REQ-163)— depende de invariantes que el
código NO impone por diseño, sino que asume que el futuro `apps/api` implementará
correctamente**:

- **La invalidación de REQ-162 no es automática.** `ApprovalWorkflow.recordChange` solo
  invalida una aprobación si alguien la invoca explícitamente; `ProposalVersionRegistry`
  calcula hashes y expone `inputChanged()`, pero **nada en el código llama a esa función
  ni la conecta con `recordChange`** (`grep` confirma cero usos de `inputChanged` fuera de
  su propia definición). Se reprodujo end-to-end: una tarifa que se triplica después de
  la aprobación de alcance "expediente", sin llamar a `recordChange`, produce un
  `PackageManifest` con `status: "ready"` que refleja el precio nuevo **nunca aprobado**
  (EX-EXP-01, CRÍTICA).
- **`PackageAssembler` no valida el alcance de la aprobación vigente.** Solo revisa que
  exista *alguna* aprobación con `status: "vigente"` en el arreglo que le pasan, sin
  filtrar por `scope === "expediente"`, confiando ciegamente en el booleano
  `isFullyApproved` del llamador. Con una única aprobación vigente de alcance
  `"documento"` (nunca de `"expediente"`) y `isFullyApproved: true`, el paquete se marca
  `"ready"` (EX-EXP-02, CRÍTICA).
- **Requisitos "obligatorios" sin evidencia detectada desaparecen sin dejar rastro.**
  `TechnicalProposalBuilder` omite por completo (sin sección, sin bloqueo, sin statement)
  cualquier requisito cuyo `requiredEvidence` quedó vacío — y el extractor de reglas solo
  reconoce evidencia para fianza/garantía/32-D/acta constitutiva/poder notarial/anexo.
  Cláusulas obligatorias reales de bases LAASSP (manifestación de no estar en los
  supuestos de los arts. 50/60, declaración de integridad) se extraen como
  `obligatoriedad: "obligatorio"` pero **se pierden silenciosamente** en la propuesta
  técnica y tampoco las cubre el checklist (`anexos_obligatorios` solo mira
  `type === "anexo"`) (EX-EXP-03, CRÍTICA).
- **Vigencias no deterministas por zona horaria.** `isPast()`/`CompanyDataService` no
  validan que las fechas traigan offset explícito. Se comprobó empíricamente que la misma
  cadena `expiresAt` sin offset ("2026-10-20T23:59:59") produce **veredictos de
  vencimiento distintos** según el `TZ` del proceso Node que ejecuta el código (`false`
  bajo `UTC`/`America/Mexico_City`, `true` bajo `Asia/Tokyo`) (EX-EXP-04, CRÍTICA).
- El motor de "cantidad con letra" nunca aplica el apócope de "uno"/"veintiuno" al monto
  final: cualquier total que termine en 1 (1, 21, 101, 21,000,000...) se imprime como
  "UNO PESOS"/"VEINTIUNO PESOS" en vez de "UN PESO"/"VEINTIÚN PESOS" en la carta de
  proposición económica (EX-EXP-05, ALTA).
- El extractor de fechas no reconoce "DD/MM/AAAA" ni "... del AAAA" (solo "de AAAA"): un
  plazo en ese formato queda sin `deadline` y sin `topicKey`, por lo que **no participa en
  la detección de conflictos** — un conflicto real de plazos entre bases y aclaraciones
  puede pasar inadvertido si usan formatos de fecha distintos (EX-EXP-06, ALTA).
- No hay validación en runtime de `ivaRate` (acepta 250% sin error) ni de `currency`
  (literal solo a nivel de tipos, sin aserción real) (EX-EXP-07, MEDIA).

Ninguno de estos hallazgos es "el LLM inventa un dato" en el sentido literal — los
mecanismos de `missing`/`blocked` de `CompanyDataService` y el "nunca total parcial" de
`EconomicProposalBuilder` sí son invariantes de código robustas y bien probadas. El
problema es que **las garantías de más alto nivel del README ("nunca listo si
incompleto", "cualquier cambio... invalida automáticamente") viven en el ensamblaje entre
módulos (`ApprovalWorkflow` ↔ `ProposalVersionRegistry` ↔ `PackageAssembler`), y ese
ensamblaje no existe todavía dentro del paquete** — es responsabilidad declarada de
`apps/api`, pero el README no advierte explícitamente que este acoplamiento (y no solo la
persistencia) queda pendiente, y ningún test de este paquete ejercita el camino
"hash cambiado ⇒ ready bloqueado" de punta a punta.

**Conteo de hallazgos por severidad**: CRÍTICA: 4 · ALTA: 2 · MEDIA: 2 · BAJA: 2 →
**10 hallazgos** (EX-EXP-01 a EX-EXP-10).

**Commit auditado**: `467be3222488d206b3dc6e965c355b0d3cf6547e`.

---

## 1. Reproducibilidad

| Paso | Resultado | Evidencia |
|---|---|---|
| `npm install` (worktree) | OK, 626 paquetes, sin cambios inesperados | log |
| `npm run -w packages/expediente typecheck` | OK, sin errores | log |
| `npm run -w packages/expediente lint` | OK, sin hallazgos | log |
| `npm run -w packages/expediente test` | **11 archivos / 84 pruebas, todas en verde** | log |
| `npm run -w packages/expediente build` | OK | log |
| `vitest run --coverage` (no está en el script oficial; se instaló `@vitest/coverage-v8` solo en el worktree) | Statements 89.98% · Branches 86.14% · Funcs 86.81% · Lines 89.98% (paquete `src/`) | log |

**Veredicto: CUMPLE.** Mismo conteo de archivos/tests y mismos nombres que
`docs/logs/expediente-ronda1.log`. Cobertura real no es 100%: `proposal-version.ts` cae a
68.75% stmts / 33.33% funcs (confirma que `inputChanged()` nunca se ejecuta en ningún
test — ver EX-EXP-01) y `company-data.ts` a 69.04% stmts / 64.28% funcs
(`resolveExperience`/`resolveAuthorizedSigner` con ramas sin cubrir).

---

## 2. "Nunca listo si incompleto" — intentos de forzar `ready`

| Vector intentado | Resultado | Hallazgo |
|---|---|---|
| Checklist con ítems `skipped`/`n_a` | No aplica: `ChecklistResultStatus` solo admite `"verde"\|"ambar"\|"rojo"`, no existe un tercer estado "neutral" que cuente como aprobado. | Comprobado correcto |
| Aprobación de una versión anterior aplicada a la actual | **Éxito del ataque.** `approve()` acepta cualquier string como `inputsHash` sin verificarlo contra `ProposalVersionRegistry`; no hay forma de detectar que el hash es de una versión vieja. | EX-EXP-01 |
| Aprobación vigente pero insumos con hash cambiado | **Éxito del ataque.** Ver resumen ejecutivo y EX-EXP-01. | EX-EXP-01 |
| Aprobación vigente de alcance distinto a "expediente" + `isFullyApproved: true` forzado | **Éxito del ataque.** `PackageAssembler` no filtra por `scope`. | EX-EXP-02 |
| Faltantes vacíos por filtrado (requisito obligatorio sin evidencia detectada) | **Éxito del ataque.** El requisito desaparece de la propuesta técnica sin bloqueo. | EX-EXP-03 |
| Manifiesto manipulado tras generar | No aplica dentro del paquete: el manifiesto se devuelve como objeto JS/JSON dentro del ZIP; alterarlo requiere reescribir el ZIP fuera del paquete (fuera de alcance de una librería pura). | Comprobado correcto (dentro de este alcance) |
| ZIP renombrado sin "BORRADOR" | **Falla el ataque.** El prefijo del nombre de archivo es solo un aviso adicional; el manifiesto (`manifiesto.json`) y `BORRADOR.txt` **dentro** del ZIP siguen diciendo `status: "draft"` / `watermark: "BORRADOR"` sin importar el nombre externo del archivo. | Comprobado correcto |
| Documento que vence el mismo día del plazo (limite de vigencia al filo) | Diseñado correctamente cuando las fechas traen offset explícito (`isPast` compara instantes reales, no calendarios). Ver EX-EXP-04 para el caso sin offset. | Parcial — ver EX-EXP-04 |
| Zona horaria en vigencias: America/Mexico_City vs UTC | **Éxito del ataque.** Ver EX-EXP-04: mismo dato produce veredictos distintos según `TZ` del proceso. | EX-EXP-04 |

---

## 3. No fabricación

| Vector intentado | Resultado | Hallazgo |
|---|---|---|
| Tarifa vencida a la fecha de presentación pero vigente hoy | **Falla el ataque (correcto).** `resolveApprovedRate`/`resolveDocumentByType` reciben `asOfIso` explícito (fecha del acto) y comparan contra eso, nunca contra "hoy" — probado en `test/company-data.test.ts` y reproducido de forma independiente. | Comprobado correcto |
| Tarifa de otra empresa | `getApprovedRates(companyId)` siempre filtra por `companyId` en el resolver in-memory; el aislamiento real entre tenants es responsabilidad de la implementación Postgres (`packages/db`, REQ-167) — no evaluable dentro de este paquete puro, correctamente declarado en el README como pendiente de `apps/api`. | No evaluable en este alcance |
| Cantidad negativa | `multiplyQuantityHalfUp` lanza excepción explícita (`"solo admite cantidades no negativas"`), no produce un valor por defecto. | Comprobado correcto |
| Cantidad cero | Produce subtotal `0.00` correctamente (no es fabricación, es el cálculo real). | Comprobado correcto |
| Moneda distinta | `ApprovedRate.currency`/`EconomicTotals.currency` son `"MXN"` solo a nivel de **tipos**; no hay ninguna aserción en runtime que lo verifique contra el dato real. Un adaptador Postgres con JSON no tipado podría colar otra moneda sin que el paquete lo note. | EX-EXP-07 |
| IVA mal configurado | `multiplyRateHalfUp` solo rechaza tasas negativas; una tasa de 2.5 (250%) o "16" en vez de "0.16" (error de unidades) se acepta sin error y produce un IVA/total absurdo. | EX-EXP-07 |
| Redondeo half-up vs bancario | El half-up es una decisión de diseño explícita y documentada (REQ-029), probada en `test/money.test.ts`; no es un defecto. | Comprobado correcto |
| Sumas de centavos con `bigint`, casos límite / overflow | `sumCents`/`addCents` no desbordan (BigInt es de precisión arbitraria). El punto débil está en la conversión previa `Math.round(quantity * 1_000_000)`, que sí puede perder precisión para cantidades del orden de 1e10 o mayores (fuera de `Number.MAX_SAFE_INTEGER` una vez multiplicada por 1e6); no hay validación de rango de `quantity`. Para cantidades realistas de licitación (unidades, horas, servicios) esto no se manifiesta. | EX-EXP-09 (BAJA) |
| Números en letra para decimales y montos grandes | `centsToPesosWords(123456n)` y `(100000n)` (los únicos casos probados) son correctos. Extendiendo la prueba a montos que terminan en 1 se encontró el bug de apócope faltante. | EX-EXP-05 |
| "un peso" vs "uno pesos" | **Confirmado: bug real.** `centsToPesosWords(100n)` → `"SON: UNO PESOS 00/100 M.N."` (debería ser "UN PESO"). `centsToPesosWords(2100n)` → `"...VEINTIUNO PESOS..."` (debería ser "VEINTIÚN PESOS"). La función `apocopeUno` existe y se usa correctamente dentro de `integerToWords` para "mil"/"millón", pero **nunca se invoca sobre el resultado final antes de anteponer "PESOS"**. | EX-EXP-05 |
| Centavos "00/100 M.N." | Formato correcto y padeado a 2 dígitos en todos los casos probados (`01/100`, `56/100`, etc.). | Comprobado correcto |

---

## 4. Aprobaciones

| Vector intentado | Resultado | Hallazgo |
|---|---|---|
| Autoaprobación por cuentas distintas del mismo usuario | El módulo compara por `actorId`, no tiene ni puede tener noción de "misma persona física, distinta cuenta" (es una librería pura sin capa de identidad). Riesgo residual real pero **fuera del alcance de código que se pueda corregir aquí**; requiere control en la capa de identidad de `apps/api`/org. | EX-EXP-08 (MEDIA, nota de diseño) |
| Writer que cambia de rol tras aprobar | Se probó: el mismo `actorId` que envió a revisión como `writer` y luego intenta aprobar como `reviewer` sigue siendo bloqueado, porque el chequeo de autoaprobación es por `actorId`, no por rol histórico — correcto y confirmado por `test/approval-workflow.test.ts:42-48`. | Comprobado correcto |
| Aprobación sobre versión inexistente | **Éxito del ataque.** `approve()` no valida `inputsHash` contra ninguna versión real de `ProposalVersionRegistry` — acepta cualquier string. Mismo origen que EX-EXP-01. | EX-EXP-01 |
| Invalidación jerárquica: ¿cambio en sección invalida documento y expediente? | **Sí, y está bien probado** (`test/approval-workflow.test.ts:90-96`, mutación 5 confirmó que rompe la suite si se desactiva). `ancestorsOf`/`isAncestorOrSame` implementan correctamente sección ⊂ documento ⊂ expediente. | Comprobado correcto |
| ¿Cambio de plazo invalida todo? | El cambio de un requisito de plazo (bases) no está conectado automáticamente a `recordChange`; requiere que el llamador lo detecte y lo invoque manualmente, igual que cualquier otro insumo — mismo hallazgo raíz que EX-EXP-01. | EX-EXP-01 |
| Comentarios sin trazabilidad | `addComment` siempre registra `id`, `authorId`, `authorRole`, `scopeRef`, `createdAt` — trazabilidad completa dentro de este paquete. | Comprobado correcto |

---

## 5. Matriz de requisitos y conflictos (extractor con textos reales)

Se probó `RuleBasedExtractor` con 3 fragmentos realistas de bases LAASSP/LOPSRM (ver
`docs/logs/audit-expediente-ronda1.log` para los fragmentos exactos):

1. Manifestación de no estar en los supuestos de los arts. 50/60 de la LAASSP + escrito de
   nacionalidad mexicana (Anexo 5) + declaración de integridad (art. 29 fracc. IX).
2. Acto de presentación con fecha en formato `15/10/2026` + junta de aclaraciones con
   fecha en formato "25 de septiembre **del** 2026".
3. Acta de aclaraciones que reprograma la entrega de proposiciones a "22 de octubre de
   2026" (formato "de AAAA", sí reconocido).

**Resultados**:

- **Precisión** (cuando el extractor sí reconoce el patrón): alta. Clasificación de tipo
  (`legal`/`económico`/`anexo`/`administrativo`), obligatoriedad y evidencia requerida son
  razonables y conservadoras (nunca infieren una fecha sin patrón inequívoco — confirmado,
  `test/requirement-matrix.test.ts:72-82`).
- **Recall en fechas: bajo para formatos comunes.** Ni "DD/MM/AAAA" ni "... del AAAA" (con
  "del" en vez de "de") son reconocidos por la regex
  `/(\d{1,2}) de ([a-záéíóú]+) de (\d{4})/` — ambos son extremadamente comunes en bases
  reales. El ítem se sigue extrayendo por otras palabras clave, pero queda con
  `deadline: null` y **sin `topicKey`**, por lo que **no puede participar en la
  detección de conflictos** aunque exista una fecha contradictoria en otro documento en
  formato reconocido. EX-EXP-06.
- **Recall en evidencia obligatoria: bajo para declaraciones legales sin anexo.**
  `extractRequiredEvidence` solo reconoce fianza/garantía/32-D/acta
  constitutiva/poder notarial/anexo — declaraciones de integridad, de no estar en
  supuestos de los arts. 50/60, manifestaciones bajo protesta sin anexo asociado, quedan
  con `requiredEvidence: []` y por lo tanto se pierden en `TechnicalProposalBuilder`
  (ver EX-EXP-03).
- **Resolución de conflictos**: cuando SÍ se detecta un conflicto (mismo `topicKey`, dos
  fechas), el sistema **nunca elige una en silencio** — lo escala explícitamente y marca
  ambos ítems como `bloqueado` (`test/requirement-matrix.test.ts:85-118`, comprobado
  correcto). El problema no es la resolución del conflicto sino la **detección**: un
  extractor con recall incompleto puede hacer que el conflicto nunca se genere.

---

## 6. Superficie de no-actuación (A15)

Además de `test/api-surface.test.ts` (que pasa), se hizo grep independiente sobre
`packages/expediente/src` buscando `fetch(`, imports de `http`/`https`/`net`/
`child_process`/`dgram`/`dns`, `writeFileSync`/`writeFile(`/`createWriteStream`,
`process.env`, y exports con nombre `submit`/`deliver`/`send`/`dispatch`/`publish`/
`post_to`/`upload_to`: **cero coincidencias**. `package.json` solo declara `jszip` como
dependencia de producción (sin cliente HTTP). El único archivo que escribe algo es
`package-assembler.ts`, y escribe exclusivamente dentro del `JSZip` en memoria (nunca al
sistema de archivos).

**Veredicto: CUMPLE**, con evidencia independiente adicional a la prueba oficial.

---

## 7. Calidad de pruebas — mutación manual de 5 reglas clave

Las 5 mutaciones pedidas por el mandato se aplicaron sobre el worktree, se corrió la
suite, y se restauró el archivo original antes de continuar (ver log para el detalle
completo de cada corrida):

| # | Regla mutada | Archivo:línea | Resultado |
|---|---|---|---|
| 1 | Ready gate siempre `"ready"` | `package-assembler.ts` (línea del cálculo de `status`) | **Detectada**: 5 tests fallan (`package-assembler.test.ts`) |
| 2 | Autoaprobación: se elimina el chequeo `submitter === actorId` | `approval-workflow.ts:127-130` | **Detectada**: 1 test falla (`approval-workflow.test.ts`) — nota: `expediente-flow.test.ts` (el flujo E2E) **no** ejercita este caso, solo el test unitario lo cubre |
| 3 | Vencimiento: se elimina el chequeo `isPast(doc.expiresAt, asOfIso)` | `company-data.ts:171-173` | **Detectada**: 2 tests fallan (`company-data.test.ts`, `expediente-flow.test.ts`) |
| 4 | Precio no aprobado: se elimina el chequeo `rate.approvalStatus !== "aprobado"` | `company-data.ts:181-183` | **Detectada**: 2 tests fallan (`company-data.test.ts`, `economic-proposal.test.ts`) |
| 5 | Invalidación jerárquica: `recordChange` nunca invalida nada | `approval-workflow.ts:168` | **Detectada**: 4 tests fallan (`approval-workflow.test.ts`) |

**Veredicto: CUMPLE.** Las 5 reglas explícitamente señaladas por el mandato están bien
protegidas por la suite existente. La cobertura real (89.98% stmts) y el hueco específico
en `proposal-version.ts` (33.33% funcs — `inputChanged` nunca se llama en ningún test)
confirman independientemente el hallazgo EX-EXP-01: la suite prueba la invalidación
*manual* de aprobaciones exhaustivamente, pero no existe ningún test que ejercite la
detección *automática* de un insumo cambiado vía hash.

---

## 8. Trazabilidad REQ-156..171

| REQ | Veredicto | Evidencia |
|---|---|---|
| REQ-156 (matriz, 7 campos) | CUMPLE, con PARCIAL en recall del extractor | `RequirementItem` expone los 7 campos; ver EX-EXP-06 |
| REQ-157 (solo datos aprobados) | CUMPLE en `CompanyDataService`/`EconomicProposalBuilder`; PARCIAL en el ensamblaje (EX-EXP-01/02) | `company-data.test.ts`, `economic-proposal.test.ts` |
| REQ-158 (faltantes = bloqueo explícito, nunca inferido) | PARCIAL — ver EX-EXP-03 (requisito obligatorio sin evidencia detectada desaparece sin bloqueo) | `technical-proposal.ts:75` |
| REQ-159 (listo solo con checklist verde) | PARCIAL — el cálculo interno es correcto (`checklistOk && noMissing && approvedOk`) pero `approvedOk` no valida alcance (EX-EXP-02) | `package-assembler.ts:84-91` |
| REQ-160 (7 dimensiones independientes) | CUMPLE estructuralmente; PARCIAL por EX-EXP-04 (vigencias no deterministas) y EX-EXP-07 (cálculos económicos sin validar `ivaRate`/`currency`) | `integrity-checklist.test.ts` (11 tests) |
| REQ-161 (versionado + hash reconstruible) | CUMPLE para el hash del insumo en sí (`ProposalVersionRegistry.getVersion`/`inputChanged` funcionan correctamente si se llaman); PARCIAL porque nada los invoca automáticamente | `proposal-version.ts` |
| REQ-162 (invalidación **automática**) | **FALLA** — la invalidación existe pero es 100% manual/explícita, no automática | EX-EXP-01 |
| REQ-163 (BORRADOR visible, nunca listo por defecto) | CUMPLE en el marcado (ni siquiera renombrar el ZIP lo oculta); PARCIAL por EX-EXP-02 | `package-assembler.test.ts` |
| REQ-164 (prohibido inventar, general) | CUMPLE para valores de datos (missing/blocked siempre explícitos); hallazgo relacionado pero distinto en EX-EXP-05 (no es un valor inventado, es una forma gramatical incorrecta de un valor correcto) | — |
| REQ-165 (nunca envía/firma/actúa sin autorización) | CUMPLE, verificado independientemente (sección 6) | `api-surface.test.ts` + grep propio |
| REQ-166 (ausencia = pendiente, nunca elegibilidad inventada) | CUMPLE cuando el dato se detecta como ausente; el riesgo de EX-EXP-06 es que el dato ni siquiera se detecte como candidato a conflicto (recall, no invención) | `requirement-matrix.test.ts` |
| REQ-167 (aislamiento entre empresas extendido) | NO EVALUABLE en este paquete puro (requiere `packages/db`/pgTAP); correctamente declarado como pendiente en el README, no se marcó como hecho | README §"Pendientes" |
| REQ-168 (relevancia/elegibilidad separadas) | NO EVALUABLE / fuera de alcance de este paquete; no reclamado en el README | — |
| REQ-169 (métricas honestas) | NO EVALUABLE / fuera de alcance; no reclamado | — |
| REQ-170 (backoffice, 6 módulos) | NO EVALUABLE / fuera de alcance; no reclamado | — |
| REQ-171 (`correlation_id` extremo a extremo) | Declarado explícitamente como **pendiente** en el README ("este paquete no genera ni persiste IDs de correlación") — honesto, no se marcó falsamente como hecho | README §"Pendientes" |

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Hallazgo | Evidencia | Reparación sugerida (separada del hallazgo) | Estado reparación |
|---|---|---|---|---|---|---|
| EX-EXP-01 | **CRÍTICA** | 2, 4, 8 (REQ-162) | `ApprovalWorkflow.recordChange` nunca se invoca automáticamente al detectar que el hash de un insumo cambió; `ProposalVersionRegistry.inputChanged()` está definido pero jamás se usa (0 referencias fuera de su propia definición, confirmado por `grep` y por cobertura: `proposal-version.ts` 33.33% funcs). `approve()` tampoco valida `inputsHash` contra ninguna versión real. Reproducido: tarifa que pasa de $850.00 a $2,550.00/hora tras la aprobación de alcance "expediente", sin llamar `recordChange`, produce `PackageManifest.status: "ready"` con el total nuevo ($59,160.00) nunca aprobado (se aprobó $19,720.00). | `src/approval-workflow.ts:123-145`, `src/proposal-version.ts:54-59`; script adversarial reproducido en el worktree (ver log, sección "EX-EXP-01") | Añadir a `ApprovalWorkflow` (o a una función de orquestación que lo envuelva) una comprobación obligatoria antes de considerar `isFullyApproved()`: recalcular el hash actual de cada insumo cubierto por la aprobación de alcance "expediente" y llamar automáticamente a `recordChange` si difiere del `inputsHash` registrado — no dejarlo como responsabilidad 100% manual de `apps/api`. Alternativamente, exponer un método `ApprovalWorkflow.revalidate(currentHashesByScope)` que se documente como de llamada obligatoria antes de cualquier `assemble()`. | **Corregido** — commit `fix(expediente): EX-EXP-01 invalidación automática por hash de insumos divergente`. `ApprovalWorkflow.revalidateAgainstCurrentHash`/`isFullyApprovedForCurrentHash` invalidan automáticamente (evento en `listChanges()`) cuando el hash actual difiere del aprobado; `PackageAssembler.buildManifest` además exige `currentInputsHash === approval.inputsHash` como defensa independiente y expone `draftReasons` explícitos. Tests: `test/proposal-invalidation.test.ts` (reproducción íntegra del ataque del auditor: tarifa $850→$2,550), `test/approval-workflow.test.ts` (describe "EX-EXP-01"), `test/package-assembler.test.ts` (describe "EX-EXP-01"). |
| EX-EXP-02 | **CRÍTICA** | 2, 4, 8 (REQ-159/163) | `PackageAssembler.buildManifest` calcula `approvedOk = input.isFullyApproved && input.approvals.some(a => a.status === "vigente")` **sin filtrar por `scope === "expediente"`**. Con una única aprobación vigente de alcance `"documento"` y `isFullyApproved: true` (booleano del llamador, potencialmente mal calculado), el paquete se marca `"ready"` aunque nunca hubo una aprobación real de alcance expediente. | `src/package-assembler.ts:84-91`; script adversarial reproducido (ver log, sección "EX-EXP-02") | Cambiar el chequeo a `input.approvals.some(a => a.status === "vigente" && a.scope === "expediente")`, ignorando o eliminando el booleano `isFullyApproved` como fuente de verdad (o exigiendo que ambas condiciones coincidan estrictamente), para que el assembler no dependa de un valor calculado fuera de su control. | **Corregido** — commit `fix(expediente): EX-EXP-02 ready exige aprobación vigente de alcance expediente`. `AssembleInput.isFullyApproved` se eliminó por completo; `PackageAssembler.buildManifest` deriva `approvedOk` estrictamente de `approvals.some(a => a.scope === "expediente" && a.status === "vigente" && a.inputsHash === currentInputsHash)`, sin aceptar ningún booleano declarado desde afuera. Test: `test/package-assembler.test.ts` describe "EX-EXP-02" (aprobación de alcance "documento" nunca produce "ready"). |
| EX-EXP-03 | **CRÍTICA** | 2, 3, 5, 8 (REQ-158) | `TechnicalProposalBuilder.build` omite completamente (sin sección, sin bloqueo, sin statement) cualquier `RequirementItem` de tipo tecnico/administrativo/legal/anexo cuyo `requiredEvidence.length === 0`, asumiéndolo "puramente procedimental". Combinado con el recall limitado de `extractRequiredEvidence` (solo reconoce fianza/garantía/32-D/acta constitutiva/poder notarial/anexo), cláusulas obligatorias reales (manifestación arts. 50/60 LAASSP, declaración de integridad) se extraen con `obligatoriedad: "obligatorio"` pero desaparecen del pipeline sin dejar ningún bloqueo. El checklist tampoco las cubre (`anexos_obligatorios` solo filtra `type === "anexo"`). | `src/technical-proposal.ts:69-75`, `src/requirement-matrix.ts:313-325`; reproducido con 3 cláusulas LAASSP realistas (ver log, sección "EX-EXP-03": 2 de 3 requisitos obligatorios quedan sin sección/bloqueo) | Cambiar la regla: un requisito con `obligatoriedad === "obligatorio"` y sin mapeo/evidencia declarada debe generar un `SectionBlocker` explícito ("sin evidencia mapeable"), no ser omitido. Reservar el "skip silencioso" solo para tipos verdaderamente procedimentales (p. ej. anuncios de plazo, que ya se filtran por `type` distinto de los cuatro relevantes, no por `requiredEvidence` vacío). | **Corregido** — commit `fix(expediente): EX-EXP-03 requisito obligatorio sin evidencia queda PENDIENTE`. `TechnicalProposalBuilder.build` ahora genera una sección `"PENDIENTE: ..."` con un `SectionBlocker` (`field: "evidencia_no_mapeable"`) cuando `obligatoriedad === "obligatorio"` y `requiredEvidence.length === 0`; el skip silencioso queda reservado solo para requisitos opcionales/condicionales. Test: `test/technical-proposal.test.ts` (nuevo; reproduce arts. 50/60 LAASSP y declaración de integridad, y protege contra regresión en el caso procedimental). |
| EX-EXP-04 | **CRÍTICA** | 2, 3, 8 (REQ-160 vigencias) | Ninguna función de `isPast`/`CompanyDataService` valida que las cadenas ISO (`expiresAt`, `validFrom`, `validUntil`, `asOfIso`) traigan offset explícito (`Z` o `±HH:MM`). Se comprobó empíricamente que la cadena "naive" `"2026-10-20T23:59:59"` (sin offset) produce **veredictos de vencimiento distintos** según la variable `TZ` del proceso Node que ejecuta el código: `isPast(...)` → `false` bajo `TZ=UTC` y `TZ=America/Mexico_City`, pero → `true` bajo `TZ=Asia/Tokyo`, para el mismo dato de entrada. | `src/types.ts:37-40` (`isPast`), `src/company-data.ts:171,187-188`; reproducido con `node` bajo 3 zonas horarias distintas (ver log, sección "EX-EXP-04") | Rechazar (lanzar excepción) cualquier fecha sin offset explícito al entrar al sistema (validación centralizada en `isPast`/en los setters del `CompanyDataResolver`), en vez de delegar en el parseo implícito de `Date` según el TZ del proceso. `apps/api` debe garantizar que todas las fechas persistidas incluyan offset (o normalizar siempre a UTC con "Z"). | **Corregido** — commit `fix(expediente): EX-EXP-04 rechazar fechas sin offset explícito`. `assertExplicitOffset` (nuevo, en `types.ts`) se invoca desde `isPast` y desde `CompanyDataService.resolveDocumentByType`/`resolveApprovedRate` (asOfIso y `rate.validFrom`); una fecha "naive" ahora lanza excepción explícita en vez de depender del `TZ` del proceso. Test: `test/timezone-determinism.test.ts` (nuevo; spawnea procesos `node` reales bajo `TZ=UTC`/`America/Mexico_City`/`Asia/Tokyo` y confirma el mismo veredicto/error en los 3 casos — se verificó primero que el naive-date reproducía `{false,false,true}` contra el código sin corregir). |
| EX-EXP-05 | ALTA | 3 | `centsToPesosWords` nunca aplica `apocopeUno` al resultado de `integerToWords` antes de anteponer "PESOS"/el sufijo de moneda, pese a que el propio docstring y REQ-031 dicen resolver exactamente ese caso. Cualquier monto que termine en 1 se imprime mal: `centsToPesosWords(100n)` → `"SON: UNO PESOS 00/100 M.N."` (debería ser "UN PESO"); `centsToPesosWords(2100n)` → `"...VEINTIUNO PESOS..."` (debería ser "VEINTIÚN PESOS"). Ningún test de `number-to-words.test.ts` prueba un monto que termine en 1/21/31/etc., por eso el bug no se detectó. | `src/number-to-words.ts:176-189`; reproducido (ver log, sección "EX-EXP-05") | Aplicar `apocopeUno(pesosWords, false)` (o una variante que también sustituya "PESOS"→"PESO" en singular cuando el monto entero es exactamente 1) antes de construir la cadena final en `centsToPesosWords`. Agregar casos de test para montos 1, 21, 31, 101, 1_000_001 y 21_000_000 pesos. | **Corregido** — commit `fix(expediente): EX-EXP-05 apócope de UN/VEINTIÚN peso en cantidad con letra`. `centsToPesosWords` aplica `apocopeUno` al resultado final de `integerToWords` antes de anteponer "PESOS" (cubre "un", "veintiún", "ciento un", "un millón un"), y usa "PESO" en singular cuando el monto es exactamente 1. Test: `test/number-to-words.test.ts` describe "EX-EXP-05" (casos 1, 21, 31, 101, 1_000_001, 21_000_000; se verificó que 7 de los 33 tests fallaban contra el código sin corregir). |
| EX-EXP-06 | ALTA | 5, 8 (REQ-156/166) | `extractDeadline` solo reconoce el patrón `"DD de <mes> de AAAA"`; no reconoce fechas numéricas (`"15/10/2026"`) ni la construcción, muy común en español, `"... del AAAA"` (con "del" en vez de "de"). En ambos casos el `RequirementItem` se extrae igual (por otras palabras clave) pero con `deadline: null` y **sin `topicKey`**, por lo que ese ítem no participa en `detectConflicts`. Efecto práctico: un conflicto real de plazos entre dos documentos que usan formatos de fecha distintos **no se detecta**, aunque el sistema nunca "elige" ninguna fecha en silencio quando el conflicto sí se detecta (eso funciona bien). | `src/requirement-matrix.ts:266-293`; reproducido con fragmentos LAASSP realistas (ver log, sección "EX-EXP-06") | Ampliar `extractDeadline` para reconocer `"del AAAA"` (trivial: aceptar "de" o "del" antes del año) y un patrón numérico `DD/MM/AAAA` o `DD-MM-AAAA`, siempre asignando `topicKey` con la misma lógica que ya existe, para que esos ítems sí entren a `detectConflicts`. | Pendiente |
| EX-EXP-07 | MEDIA | 3 | Sin validación de invariantes económicas en runtime: (a) `EconomicProposalConfig.ivaRate` no tiene cota superior (`multiplyRateHalfUp` solo rechaza negativos) — una tasa de 2.5 (250%) o un error de unidades (16 en vez de 0.16) se acepta sin error y produce un total absurdo; (b) `ApprovedRate.currency`/`EconomicTotals.currency` son `"MXN"` solo a nivel de **tipos** de TypeScript, sin ninguna aserción real sobre el dato que efectivamente llega desde un resolver (p. ej. JSON no tipado de Postgres). | `src/economic-proposal.ts:38,53-55`, `src/money.ts:53-65`, `src/company-data.ts:67`; reproducido (ver log, sección "EX-EXP-07": IVA 250% aceptado sin error) | Agregar `assertValidIvaRate` (rango razonable, p. ej. `[0, 0.3]`, configurable) en el constructor de `EconomicProposalBuilder`, y una aserción `rate.currency === "MXN"` (lanzando error explícito) dentro de `resolveApprovedRate` antes de usar la tarifa. | Pendiente |
| EX-EXP-08 | MEDIA | 4 | Autoaprobación por cuentas distintas de la misma persona física: `ApprovalWorkflow` solo compara `actorId` (string opaco); no tiene, ni puede tener dentro de una librería pura sin capa de identidad, forma de detectar que dos `actorId` distintos pertenecen al mismo humano. Es un riesgo residual real que debe cerrarse en la capa de identidad/organización de `apps/api`, no dentro de este paquete. | `src/approval-workflow.ts:123-130` | Documentar explícitamente esta limitación en el README de `packages/expediente` (no está mencionada hoy) para que `apps/api` sepa que debe implementar un control adicional (p. ej. impedir que el mismo `userId` de identidad tenga dos cuentas/roles activos sobre el mismo expediente). | Pendiente |
| EX-EXP-09 | BAJA | 3 | `multiplyQuantityHalfUp`/`multiplyRateHalfUp` convierten `quantity`/`rate` a micro-unidades vía `Math.round(x * 1_000_000)` sin validar que el resultado quede dentro de `Number.MAX_SAFE_INTEGER`; para cantidades del orden de 1e10 o mayores esto puede perder precisión de forma silenciosa (no lanza error). No se pudo construir un caso donde esto produjera un error de más de un centavo con cantidades realistas de licitación (unidades/horas/servicios, típicamente < 10^6), pero no hay ninguna guarda que impida una cantidad absurda. | `src/money.ts:53-77`; reproducido con cantidad=1e10 (ver log, sección "EX-EXP-09") | Agregar una cota superior razonable a `quantity` (p. ej. rechazar cantidades > 10^7) en `multiplyQuantityHalfUp`/en la validación de `EconomicLineItemRequest`. | Pendiente |
| EX-EXP-10 | BAJA | 2 | La dimensión `consistencia_cruzada` del checklist devuelve `"ambar"` (no `"rojo"`) cuando hay menos de 2 documentos para comparar. Esto es correcto en el sentido de que `"ambar" !== "verde"` sigue bloqueando `"ready"`, pero puede inducir a un implementador de `apps/api` a "resolver" el ámbar duplicando artificialmente la misma cifra en una segunda entrada de `crossDocumentTotals` solo para pasar a verde — lo cual sería fabricar una consistencia que no existe realmente. No es un defecto de este paquete, es un riesgo de mal uso aguas abajo. | `src/integrity-checklist.ts:191-205` | Documentar explícitamente en el README/comentario de `checkConsistenciaCruzada` que un `crossDocumentTotals` con menos de 2 entradas reales (no duplicadas artificialmente) debe permanecer en advertencia, y que duplicar una cifra para forzar "verde" sería una violación de REQ-164. | Pendiente |

---

## Comprobado correcto (no exhaustivo, lo verificado activamente en esta ronda)

- `CompanyDataService` nunca devuelve `"ok"` sin `source_ref`; ausencia → `"missing"`
  explícito, dato no aprobado/vencido → `"blocked"` explícito con razón — verificado con
  pruebas propias además de la suite existente.
- `EconomicProposalBuilder` nunca genera un total parcial: si cualquier concepto está
  bloqueado o falta, `totals`/`cartaText`/`anexoText` son `null` de punta a punta.
- La comparación de vigencia usa siempre `asOfIso` (fecha del acto) explícito, nunca "hoy"
  implícito — confirmado también fuera de los tests oficiales.
- El half-up de `money.ts` es determinista, documentado y probado; `sumCents` con
  `bigint` no desborda.
- La jerarquía de invalidación de aprobaciones (sección ⊂ documento ⊂ expediente) está
  correctamente implementada y protegida por mutación.
- El chequeo de autoaprobación es por `actorId`, no por rol — un cambio de rol posterior
  del mismo actor no permite evadirlo.
- Renombrar el ZIP de salida no oculta la marca "BORRADOR": el manifiesto y `BORRADOR.txt`
  dentro del ZIP la conservan siempre.
- No existe ningún import de cliente HTTP/red ni ninguna escritura a disco fuera del ZIP
  en memoria, en todo `src/` (grep independiente, cero coincidencias).
- Los conflictos de plazo/obligatoriedad **detectados** se escalan explícitamente y
  bloquean los ítems involucrados; nunca se elige una fecha "ganadora" en silencio.
- `addComment` registra siempre autor, rol y momento — trazabilidad completa de
  comentarios dentro del paquete.
- Las 5 reglas duras señaladas por el mandato (ready gate, autoaprobación, vencimiento,
  precio no aprobado, invalidación jerárquica) están protegidas por la suite: mutarlas
  manualmente rompe tests reales, no solo cosméticos.
- REQ-171 (`correlation_id`) está declarado honestamente como pendiente, no se marcó como
  hecho — el README no infla su propio alcance en este punto.

---

## Notas de alcance

- No se evaluaron `packages/db`/`apps/api` (no existen implementaciones reales todavía
  contra las que auditar REQ-167 de aislamiento entre tenants ni los endpoints HTTP).
- El worktree de la auditoría (`git worktree add`) fue eliminado al finalizar; no quedan
  scripts `.mjs` adversariales ni cambios de código en el árbol principal — todos los
  hallazgos son de solo lectura sobre el commit `467be32`.
