# @atiende/expediente

Motor del **expediente de participación** (docs/AMPLIACION-BACKOFFICE.md §5-8,
docs/REQUISITOS.md secciones 4-8 y 32-33 — REQ-156 a REQ-171,
docs/ACEPTACION.md pruebas A6-A15).

Librería TypeScript **pura**: sin dependencia de base de datos, de
`packages/db` ni de `packages/agents` (evita acoplarse a APIs en cambio
concurrente de otros implementadores). Toda interfaz de persistencia
(`CompanyDataResolver`, etc.) solo tiene implementación en memoria aquí,
para pruebas; `apps/api` debe proveer la implementación real respaldada por
Postgres.

## Arquitectura (módulos en `src/`)

| Módulo | Responsabilidad | REQ |
|---|---|---|
| `requirement-matrix.ts` | `RequirementMatrixBuilder`: extrae `RequirementItem[]` de `TenderDocumentText` (bases/anexos/aclaraciones) vía `RuleBasedExtractor` (determinista, regex/léxico) y detecta `Conflict` entre documentos (plazos u obligatoriedad contradictorios) — nunca elige uno en silencio. `extractDeadline` reconoce "DD de mes de/del AAAA", "DD/MM/AAAA" y "DD-MM-AAAA"; cuando el patrón numérico es genuinamente ambiguo (día y mes ambos ≤12, p. ej. "05/09/2026") baja `confidence` a 0.5 sin cambiar la interpretación DD/MM por defecto (EX-EXP-06/EX-EXP-15). | REQ-156, REQ-166 |
| `llm/extractor.ts` | Hook de extractor LLM (`LlmExtractorClient` + `LlmRequirementExtractor`) que se combina con el extractor de reglas en el mismo `RequirementMatrixBuilder`. `FakeLlmExtractorClient` para pruebas deterministas sin red. | REQ-156 |
| `company-data.ts` | `CompanyDataResolver` (interfaz) + `CompanyDataService`: resuelve documentos/capacidades/experiencia/tarifas/firmantes con reglas duras — ausente → `missing`, vencido/no aprobado → `blocked`, nunca un valor inventado. Todas las fechas (`asOfIso`, `validFrom`, `expiresAt`) deben traer offset horario explícito válido (`assertExplicitOffset`: formato, rango -12:00/+14:00 y validez calendárica — EX-EXP-04/EX-EXP-13); `resolveApprovedRate` lanza si `rate.currency !== "MXN"`. | REQ-157, REQ-158, REQ-164, REQ-166 |
| `technical-proposal.ts` | `TechnicalProposalBuilder`: mapea requisitos → dato de empresa aprobado, produce `ProposalStatement` con `source_ref` trazable; dato faltante/bloqueado = bloqueo de sección, nunca texto inventado. Un requisito `obligatorio` sin evidencia mapeable NUNCA se omite: queda como sección "PENDIENTE" con `SectionBlocker`. Un requisito `condicional` sin evidencia se trata igual (PENDIENTE) salvo que el llamador declare EXPLÍCITAMENTE, vía el parámetro `conditionEvaluations`, que no aplica al caso concreto (`false`); si no se declara nada, es fail-closed ("condicion_no_evaluable"), nunca desaparece en silencio (EX-EXP-03/EX-EXP-12). Un requisito `opcional`, o un `condicional` marcado explícitamente como no aplicable, YA NO desaparece sin rastro: genera una sección VISIBLE con título `"NO APLICA (...)"`, sin bloqueos ni afirmaciones — `isNotApplicableSection`/`extractNotApplicableRequirements` identifican estas secciones para que `PackageAssembler` también las refleje en el manifiesto (EX-EXP-19). | REQ-157, REQ-158, REQ-164 |
| `economic-proposal.ts` | `EconomicProposalBuilder`: cálculo económico 100% determinista (centavos en `bigint`, half-up), rechaza tarifas no aprobadas/vencidas de punta a punta (sin total parcial), genera carta + anexo desde el mismo objeto de totales (consistencia estructural). El constructor valida `ivaRate` en `[0, maxIvaRate]` (default 0.3) vía `assertValidIvaRate`. | REQ-029, REQ-030, REQ-157, REQ-160, REQ-164 |
| `money.ts` | Aritmética monetaria en centavos (`bigint`), redondeo half-up explícito. `multiplyQuantityHalfUp` rechaza `quantity > MAX_QUANTITY` (1e7). | REQ-029 |
| `number-to-words.ts` | Motor propio de "cantidad con letra" en español (apócope de "uno"/"veintiuno" → "un"/"veintiún" también en `centsToPesosWords`, incluido el caso FUSIONADO al final de centenas/millares/millones — "ciento veintiún", "ciento veintiún mil", "ciento veintiún millones" — EX-EXP-05/EX-EXP-12; "cien" vs "ciento", "PESO" singular para $1.00, etc.), sin dependencias externas. | REQ-031 |
| `proposal-version.ts` | `ProposalVersionRegistry`/`computeInputsHash`/`sealInputs`: el paquete DEFINE y CALCULA él mismo el hash de insumos sobre un conjunto CERRADO y OBLIGATORIO (`ExpedienteInputs`: versión de bases, documentos de empresa usados con vigencia, tarifas usadas, perfil, plantillas). `computeInputsHash` devuelve un `InputsHash` BRANDED (rechazo en tiempo de compilación de un `string` suelto) y `sealInputs`/`ProposalVersionRegistry.createVersion(...).hash` devuelven un `HashedInputs` sellado con un símbolo PRIVADO no exportado — ni `ApprovalWorkflow.approve()` ni `PackageAssembler.buildManifest()` aceptan ya un hash calculado por fuera de este módulo, ni siquiera un `string` "correcto" en apariencia (EX-EXP-01/EX-EXP-11/EX-EXP-17, ver más abajo). `changedInputsSince`/`inputChanged()` reportan exactamente QUÉ insumo cambió, no solo que el hash difiere. | REQ-161 |
| `integrity-checklist.ts` | `IntegrityChecklist`: 7 dimensiones independientes con resultado y evidencia propios — formatos, límites, firmas (solo "requiere firma del usuario", nunca firma), anexos obligatorios, vigencias, cálculos económicos, consistencia cruzada. | REQ-160 |
| `approval-workflow.ts` | `ApprovalWorkflow`: borrador → en_revisión → aprobado; solo roles `reviewer`/`admin`/`owner` aprueban (nunca `writer`/`viewer`), autoaprobación prohibida; `recordChange` invalida aprobaciones según jerarquía de alcance (sección ⊂ documento ⊂ expediente). `revalidateAgainstCurrentHash`/`isFullyApprovedForCurrentHash` invalidan AUTOMÁTICAMENTE una aprobación vigente cuyo `inputsHash` ya no coincide con el hash actual de los insumos (REQ-162) — de llamada obligatoria en cada evaluación de "¿está aprobado?" antes de `assemble()`. `approve()`/`revalidateAgainstCurrentHash`/`isFullyApprovedForCurrentHash` exigen un `HashedInputs` sellado (EX-EXP-17, ver abajo), nunca un `string`. `approve()` rechaza `scope === "expediente"` con un `scopeRef` distinto de la cadena `"expediente"` (EX-EXP-02/EX-EXP-14). `recordEdit({scopeRef, actorId})`/`authorsOf(scopeRef)` (AE-11, auditoría ronda 2) registran quién redactó contenido de cada `scopeRef`; `approve()` rechaza además a un aprobador que conste como autor de contenido del alcance aprobado o de cualquier alcance descendiente cubierto (p. ej. redactar una sección y luego aprobar todo el expediente) — antes solo se comparaba contra quien llamó `requestReview`. `recordEdit` es opcional: sin llamadas a ella el comportamiento es idéntico al anterior (cambio aditivo); `apps/api` debe invocarla en cada guardado de contenido de sección para que la protección tenga efecto real (pendiente, fuera de esta ronda). | REQ-159, REQ-161, REQ-162 |
| `package-assembler.ts` | `PackageAssembler`: arma `PackageManifest` + ZIP real (`jszip`); `ready` solo si checklist verde + existe una aprobación `vigente` de `scope === "expediente"` **y** `scopeRef === "expediente"` (EX-EXP-02/EX-EXP-14, defensa en profundidad) cuyo `inputsHash` coincide con el `.hash` del `HashedInputs` sellado pasado como `currentInputsHash` (EX-EXP-17) + sin faltantes; si no, `draft` con prefijo/marca "BORRADOR" y `draftReasons` explícitos. No existe ningún booleano `isFullyApproved` declarable desde afuera: "¿aprobado?" se deriva siempre de `approvals` dentro del assembler. `PackageManifest.notApplicableRequirements` refleja las secciones "NO APLICA" de la propuesta técnica cuando el llamador las pasa (EX-EXP-19). Incluye siempre el aviso de responsabilidad del usuario. El `sha256` de cada documento del manifiesto se calcula sobre los BYTES REALES del contenido con `sha256Bytes` (AE-06, auditoría ronda 2) — coincide con `sha256sum` sobre el archivo extraído, ya no con el hash de su representación JSON. El `filename` de cada documento se sanea internamente (basename sin `..`/`/`/`\`/caracteres de control, longitud acotada, colisiones resueltas con sufijo determinista por `documentId`) antes de usarse como nombre de entrada del ZIP (AE-07, Zip Slip) y se refleja en `PackageManifest.documents[].filename`. `verifyManifest(zip)` relee un ZIP producido por `assemble()` y recalcula el sha256 real de cada entrada extraída para confirmar que coincide con el manifiesto (`mismatches`/`missingFromZip`). | REQ-048, REQ-159, REQ-161, REQ-162, REQ-163 |

Todos los módulos se re-exportan desde `src/index.ts`.

## Reglas duras verificadas en tests

- **Nunca se inventa un dato**: `CompanyDataService` solo devuelve `ok` con
  `source_ref`; si falta o no es válido, `missing`/`blocked` explícito.
- **Nunca un total parcial**: si cualquier concepto económico no resuelve a
  tarifa aprobada y vigente, `EconomicProposalResult.totals` es `null`.
- **Nunca "listo" por defecto**: `PackageAssembler.buildManifest` calcula
  `status` a partir de checklist + aprobaciones + faltantes; nunca hay una
  ruta que devuelva `"ready"` sin las tres condiciones.
- **La invalidación de aprobaciones por cambio de insumo es AUTOMÁTICA**:
  `ApprovalWorkflow.revalidateAgainstCurrentHash`/`isFullyApprovedForCurrentHash`
  recalculan el hash actual y, si difiere del aprobado, invalidan la
  aprobación y registran el evento — no depende de que alguien recuerde
  llamar `recordChange` a mano. `PackageAssembler` además exige
  `currentInputsHash === inputsHash` de la aprobación vigente de alcance
  `"expediente"` como defensa independiente: `"ready"` es imposible con
  hash divergente incluso si el llamador olvida revalidar.
- **El hash de insumos NUNCA puede ser un `string` calculado a mano
  (EX-EXP-17)**: `approve()`/`revalidateAgainstCurrentHash`/
  `isFullyApprovedForCurrentHash`/`buildManifest` exigen un `HashedInputs`
  sellado (`sealInputs`/`computeInputsHash`/
  `ProposalVersionRegistry.createVersion(...).hash`), verificado con un
  símbolo privado no exportado — ver "Hash de insumos" más abajo.
- **Fechas siempre con offset explícito y válido**: `isPast`/
  `CompanyDataService` rechazan (lanzan excepción) cualquier fecha ISO sin
  `"Z"`/`"±HH:MM"`, con offset numéricamente imposible (fuera de -12:00 a
  +14:00, o minutos fuera de 00-59), con hora/minuto/segundo fuera de rango
  (incluida `"24:00:00"`, EX-EXP-20), o calendáricamente inválida (p. ej. 29
  de febrero en año no bisiesto) — el veredicto de vencimiento nunca
  depende del `TZ` del proceso Node, y una fecha inválida SIEMPRE lanza
  (fail-closed): `isPast` nunca compara `NaN` ni responde "no vencido"
  sobre una fecha corrupta (EX-EXP-04/EX-EXP-13/EX-EXP-20).
- **`stableStringify`/`sha256Hex` distinguen `Date`/`Map`/`Set`/`BigInt`**:
  antes colapsaban a `"{}"` (colisión real entre valores lógicamente
  distintos) o lanzaban (`BigInt`); ahora se serializan con un marcador de
  tipo explícito, con `Map`/`Set` ordenados canónicamente para que el orden
  de inserción no afecte el hash (EX-EXP-18).
- **`stableStringify`/`sha256Hex` y `-0`/`NaN`/`Infinity` (EX-EXP-18
  residual, corrector BAJA)**: `JSON.stringify(-0) === "0"` y
  `JSON.stringify(NaN) === JSON.stringify(Infinity) === JSON.stringify(-Infinity)
  === "null"` — dos colisiones reales que `sortKeysDeep` heredaba sin
  normalizar. Decisión de diseño: un `number` no finito (`NaN`/`Infinity`/
  `-Infinity`) nunca es un insumo de expediente legítimo — representa un
  error de VALIDACIÓN aguas arriba (un cálculo fuera de rango), no un valor
  que canonicalizar, así que `stableStringify`/`sha256Hex` **lanzan**
  fail-closed ante cualquiera de los tres en vez de inventarles un marcador
  de tipo. `-0`, en cambio, sí es un número finito legítimo (aunque
  infrecuente en este dominio) y se preserva con el mismo patrón de
  marcador de tipo que `Date`/`Map`/`Set`/`BigInt`, para que nunca colisione
  con `0`.
- **Nunca firma el sistema**: `IntegrityChecklist` solo lee
  `userConfirmedSigned` (provisto por el llamador); no existe método que lo
  ponga en `true` desde dentro del paquete.
- **Sin envío/actuación automática**: `test/api-surface.test.ts` escanea la
  API pública exportada y el código fuente para verificar que no hay ningún
  método de "enviar/firmar/actuar en portal" ni import de un cliente
  HTTP/red en todo el paquete.

## Hash de insumos: `InputsHash`/`HashedInputs` (EX-EXP-17 — LEER ANTES DE INTEGRAR)

**Cambio de API pública, ronda 3 de corrección.** Antes, `ApprovalWorkflow.
approve()`/`PackageAssembler.buildManifest()` aceptaban `inputsHash`/
`currentInputsHash` como un `string` plano. Una reverificación adversarial
(EX-EXP-17) demostró que esto permitía aprobar/ensamblar un expediente
completo con un hash calculado a mano (`sha256Hex("cualquier-cosa")`, sin
relación real con `ExpedienteInputs`) — el mismo defecto de fondo de
EX-EXP-01/EX-EXP-11, escondido detrás de una función de hash bien diseñada
que nada obligaba a usar. Esto ya NO es posible:

- `computeInputsHash(inputs: ExpedienteInputs): InputsHash` devuelve un tipo
  **BRANDED** (`string & { [brand]: true }`): TypeScript rechaza en tiempo
  de compilación cualquier intento de pasar un `string` suelto donde se
  espera un `InputsHash`.
- `sealInputs(inputs: ExpedienteInputs): HashedInputs` (o
  `ProposalVersionRegistry.createVersion(inputs).hash`, que la usa
  internamente) devuelve un `HashedInputs` — `{ inputs, hash }` — **sellado
  con un símbolo privado no exportado**: ningún código fuera de
  `proposal-version.ts` puede añadir ese símbolo como propiedad PROPIA de un
  objeto nuevo, así que ni siquiera reensamblar `{ inputs, hash }` a mano con
  un `InputsHash` *legítimo* (obtenido de otra parte) pasa la verificación en
  runtime — ver `test/approval-workflow.test.ts`/`test/package-assembler.test.ts`,
  sección "EX-EXP-17", para el ataque exacto y por qué el tipo por sí solo
  no basta. **Precisión (REVERIFY3-EXP-A, corrector BAJA)**: la verificación
  no es "no falsificable desde fuera del módulo" solo por el símbolo no
  exportado — un objeto puede HEREDAR el símbolo sin copiarlo
  (`Object.create(otroHashedInputsAjeno)` con `inputs`/`hash` propios
  auto-coherentes). Por eso `isSealedHashedInputs` exige, además, que el
  símbolo y los campos `inputs`/`hash` sean propiedades **propias**
  (`Object.hasOwn`, que no recorre la cadena de prototipos) **y** que el
  objeto sea, por identidad, uno de los que `sealInputs` construyó y devolvió
  directamente (un `WeakSet` interno, segunda barrera independiente del
  símbolo). Con ambas capas, ni copiar el símbolo (imposible, no se exporta)
  ni heredarlo (bloqueado por `hasOwn` + el `WeakSet`) permite forjar un
  `HashedInputs` sellado — eso es lo que hace la garantía "no falsificable
  desde fuera del módulo" precisa en sentido estricto.
- `ApprovalWorkflow.approve()`/`revalidateAgainstCurrentHash()`/
  `isFullyApprovedForCurrentHash()` y `PackageAssembler.buildManifest()`
  exigen un `HashedInputs` (nunca un `string`) y lo verifican con
  `requireValidHashedInputs()` antes de usarlo: (1) si es un `string`, lanza
  `InvalidInputsHashError` con un mensaje de migración explícito — el
  soporte de `string` está **DEPRECADO por inseguro**, no aceptado en
  silencio; (2) si no trae el símbolo privado, lanza igual; (3) recalcula
  `computeInputsHash(value.inputs)` y lo compara contra `value.hash` — si
  alguien mutó el objeto `inputs` referenciado DESPUÉS de sellarlo, la
  recomputación ya no coincide y también se rechaza.

**Migración para `apps/api`** (que está integrando este paquete en esta
misma ronda): en vez de guardar/pasar un hash como `string` suelto,
construya siempre el `ExpedienteInputs` completo y use
`ProposalVersionRegistry.createVersion(inputs).hash` (o `sealInputs(inputs)`
directamente) como el valor de `inputsHash`/`currentInputsHash`. Si su capa
de persistencia necesita guardar el hash como texto (p. ej. una columna
`inputs_hash` en Postgres), guarde `hashedInputs.hash` (el `InputsHash`
branded, que es un `string` en runtime) — pero para volver a llamar
`approve()`/`buildManifest()` más adelante deberá reconstruir el
`ExpedienteInputs` completo y sellarlo de nuevo con `sealInputs`/
`computeInputsHash`; NO intente reconstruir un `HashedInputs` a mano con ese
string guardado, porque carece del símbolo privado y será rechazado.

## Cómo lo consumirá `apps/api`

1. Implementar `CompanyDataResolver` sobre `packages/db` (tablas de perfil
   de empresa, documentos, tarifas, firmantes — E2 del backlog).
2. Implementar `RunStore`-equivalente/persistencia de `RequirementItem[]`,
   `Conflict[]`, `ApprovalWorkflow` (estado, aprobaciones, comentarios,
   cambios) y `ProposalVersion` contra Postgres, siguiendo el patrón de
   `packages/agents` (interfaces agnósticas al backend, in-memory solo para
   tests).
3. Conectar un `LlmExtractorClient` real (posiblemente sobre
   `@atiende/agents`) para complementar `RuleBasedExtractor` en prosa libre
   no cubierta por patrones.
4. Exponer endpoints HTTP que llamen a `RequirementMatrixBuilder`,
   `TechnicalProposalBuilder`/`EconomicProposalBuilder`, `IntegrityChecklist`,
   `ApprovalWorkflow` y `PackageAssembler` en ese orden; la descarga del ZIP
   final debe requerir sesión autenticada (fuera del alcance de este
   paquete puro). En cada evaluación (antes de cada `assemble()`), debe
   recalcular el hash actual de los insumos de alcance "expediente" (p. ej.
   con `ProposalVersionRegistry.createVersion(inputs).hash`, un
   `HashedInputs` — **ya NO un `string`**, ver "Hash de insumos" arriba,
   EX-EXP-17) y llamar
   `ApprovalWorkflow.isFullyApprovedForCurrentHash(currentHash)` — nunca
   confiar en el estado de aprobación calculado en un momento anterior.
   Todas las fechas persistidas deben incluir offset horario explícito (o
   normalizarse a UTC con `"Z"`); `isPast`/`CompanyDataService` rechazan
   cualquier fecha "naive" o con hora fuera de rango (incluida `"24:00:00"`,
   EX-EXP-20).
5. **Ningún endpoint de `apps/api` debe agregar una función de
   envío/firma/actuación en portal** — ese es exactamente el límite que
   este paquete fija y que `test/api-surface.test.ts` protege.

## Pruebas de aceptación cubiertas (docs/ACEPTACION.md)

| Prueba | Cobertura | Archivo(s) de test |
|---|---|---|
| A6 — dato ausente/contradictorio | Conflicto de plazos entre documentos; dato/capacidad ausente o no aprobada nunca se infiere | `test/requirement-matrix.test.ts`, `test/company-data.test.ts` |
| A7 — documento/certificado vencido | Documento vencido a la fecha del acto bloquea propuesta técnica y marca "vigencias" en rojo | `test/company-data.test.ts`, `test/integrity-checklist.test.ts`, `test/expediente-flow.test.ts` |
| A8 — precio no aprobado | Tarifa pendiente/vencida rechazada de punta a punta, sin total parcial | `test/economic-proposal.test.ts`, `test/company-data.test.ts` |
| A9 — anexo obligatorio faltante | Checklist "anexos_obligatorios" en rojo; paquete no puede ser "ready" | `test/integrity-checklist.test.ts`, `test/package-assembler.test.ts`, `test/expediente-flow.test.ts` |
| A10 — cálculo económico | Subtotal/IVA/total deterministas half-up, total en letra, consistencia carta/anexo | `test/money.test.ts`, `test/number-to-words.test.ts`, `test/economic-proposal.test.ts` |
| A11 — edición invalida aprobación | `recordChange` invalida aprobaciones vigentes según jerarquía de alcance | `test/approval-workflow.test.ts`, `test/expediente-flow.test.ts` |
| A12 — rol indebido | `writer`/`viewer` no pueden aprobar; autoaprobación prohibida | `test/approval-workflow.test.ts` |
| A13 — expediente completo descargable | Flujo íntegro produce manifiesto "ready" y ZIP real releído con `jszip` | `test/package-assembler.test.ts`, `test/expediente-flow.test.ts` |
| A14 — expediente incompleto nunca "listo" | Combinaciones de pendientes (checklist rojo, documento faltante, sin aprobación vigente, aprobación invalidada) siempre "draft" | `test/package-assembler.test.ts`, `test/expediente-flow.test.ts` |
| A15 — firma/envío siempre del usuario | Sin función de envío/firma en la API pública ni imports de red en el código fuente | `test/api-surface.test.ts`, `test/integrity-checklist.test.ts` |

## Scripts

```
npm run -w packages/expediente typecheck
npm run -w packages/expediente lint
npm run -w packages/expediente test
npm run -w packages/expediente build
npm run -w packages/expediente test:coverage
```

`test:coverage` (EX-EXP-21, mismo patrón que `packages/agents`/AG-14) corre
`vitest run --coverage` con umbrales mínimos declarados en
`vitest.config.ts` (líneas/statements/functions ≥85%, ramas ≥80%) — falla si
la cobertura real cae por debajo, en vez de degradar en silencio sin que CI
lo detecte.

## Limitaciones conocidas (riesgos residuales fuera de una librería pura)

- **Autoaprobación entre cuentas distintas de la misma persona física
  (EX-EXP-08, auditoría ronda 1)**: `ApprovalWorkflow` solo compara
  `actorId` (un string opaco); dentro de una librería pura sin capa de
  identidad no hay, ni puede haber, forma de detectar que dos `actorId`
  distintos pertenecen al mismo humano (p. ej. la misma persona con dos
  cuentas/roles activos sobre el mismo expediente). Esto NO se corrige aquí
  — `apps/api`/la capa de identidad y organización debe implementar un
  control adicional (p. ej. impedir que un mismo `userId` de identidad
  tenga más de una cuenta/rol activo sobre el mismo expediente) antes de
  confiar en la prohibición de autoaprobación de este paquete como control
  único.
- **AE-08 (auditoría ronda 2, `docs/auditoria-2/api-expediente.md`):
  `ExpedienteInputs.companyProfileHash` es, por diseño, un `string` opaco**
  — el paquete no impone (ni puede imponer, sin acoplarse al esquema de
  `packages/db`) qué columnas/entidades de la empresa cubre ese hash. Hoy
  `apps/api/src/lib/expediente/inputs.ts` (`buildCompanyProfileHash`) solo
  hashea columnas de `company_profiles` y omite `capabilities`/
  `experience_records`/`authorized_signatories`, que sí alimentan el
  contenido de la propuesta técnica — un cambio posterior en esos datos no
  invalida ninguna aprobación. Esto NO es un defecto de `packages/expediente`
  (el contrato ya es genérico y cerrado en 5 categorías obligatorias):
  `apps/api` debe incluir el hash de todo lo que efectivamente usa al
  construir `companyProfileHash` (o, si necesita distinguirlas, tratarlas
  como una categoría adicional dentro de `companyDocuments`/`rates`, que ya
  soportan subconjuntos "usados").
- **No fabricar "consistencia_cruzada" duplicando cifras (EX-EXP-10,
  auditoría ronda 1)**: `IntegrityChecklist` marca la dimensión
  `consistencia_cruzada` en `"ambar"` (no `"rojo"`) cuando hay menos de 2
  documentos que comparar — sigue bloqueando `"ready"` (`"ambar" !==
  "verde"`), pero un implementador de `apps/api` NO debe "resolver" ese
  ámbar duplicando artificialmente la misma cifra en una segunda entrada de
  `crossDocumentTotals` solo para pasar a verde: eso sería fabricar una
  consistencia que no existe realmente (violación de REQ-164). El ámbar
  solo debe cerrarse agregando una segunda fuente REAL e independiente del
  mismo total.

## Pendientes (fuera del alcance de este paquete puro)

- Implementaciones reales de `CompanyDataResolver`/persistencia sobre
  `packages/db` (E2/E7 del backlog) — aquí solo hay in-memory para pruebas.
- Cliente LLM real para `LlmExtractorClient` (actualmente solo
  `FakeLlmExtractorClient` determinista en tests).
- Simulador de puntaje del evaluador y banda legal de precio (REQ-030,
  REQ-038) — pertenecen a `packages/agents`/E6, no a este paquete.
- Huellas de similitud entre tenants (REQ-032, anticolusión) — transversal,
  no implementado aquí.
- Endpoints HTTP, autenticación y descarga del ZIP (apps/api).
- `correlation_id` de punta a punta (REQ-171): este paquete no genera ni
  persiste IDs de correlación; debe inyectarlos `apps/api` al llamarlo.
