# Resumen de PDFs fuente — Atiende Licitaciones

**Herramienta de extracción**: `pdftotext -layout` (Homebrew poppler), disponible en el entorno; sin errores de extracción en 30 PDFs procesados. No fue necesario recurrir a pypdf/PyPDF2/mdls.

**Jurisdicción objetivo**: México (federal + 32 regímenes estatales/municipales parametrizables). Expansión declarada solo como visión de negocio, sin especificación legal detallada aún: LatAm hispanohablante (Colombia, Chile, Perú, RD, Panamá, Ecuador/Guatemala/Uruguay), España como "puerta UE", Brasil/Argentina/EE.UU. hispano a más largo plazo.

**Fuentes de convocatorias citadas**: ComprasMX (ex CompraNet, fuente primaria), DOF, API OCDS de la SHCP (`api.datos.gob.mx`), Sistema 6 de la Plataforma Digital Nacional, CompraNet histórico (datos.gob.mx), portales estatales OCDS (CDMX, Nuevo León, Yucatán, etc.), PNT/SIPOT, SAT 69-B/sancionados/RUPC/REPSE, QuiénEsQuién.Wiki, IRC IMCO. **PLACSP y TED/eForms** (España/UE) se mencionan solo como referentes de diseño para una eventual expansión, sin conector activo especificado.

**Decisiones LLM clave (DECISIONLLMLICITACIONES.pdf)**: fase hackathon fija OpenAI Agents SDK + Responses API con 3 niveles de modelo por costo/tarea (barato: triage/clasificación; medio: extracción/auditoría; caro: redacción técnica). 5 componentes de "tolerancia cero" (recall del Analista, juez del Auditor, Abogado, verificador de entailment, clasificador anticolusión) deben permanecer siempre en proveedores con sede en EE.UU., en toda fase. Para después del hackathon se evalúan 3 opciones (pura EE.UU. recomendada en H/M; híbrida con modelos abiertos de origen chino vía proveedores EE.UU. con retención cero solo si supera 5 gates de calidad/esquema/residencia/alineación/operación en fase GA). El riesgo de sesgo/censura de modelos chinos se cita como reportado en literatura externa, no verificado en fuente primaria por el propio documento.

## Por documento

- **BLUEPRINT-LICITACIONES.pdf**: documento maestro de arquitectura de producto (~87 requisitos identificados): descubrimiento, matching, Go/No-Go, análisis de bases, redacción, auditoría, entrega/HITL, multi-tenant, e.firma local, anticorrupción (G-01 a G-12), backlog de 40 tareas atómicas con gates.
- **DECISIONLLMLICITACIONES.pdf**: decisiones de arquitectura/LLM (ver arriba).
- **CLAUDE.pdf, rules-agents/db/security/licitaciones.pdf, tasks-README/FOCUS.pdf, DECISIONS-HUMANAS.pdf**: protocolo de gobierno del monorepo — loop TDD por tarea, multi-tenant obligatorio (RLS+pgTAP), dinero en Decimal, secretos nunca en código, decisiones reservadas al fundador (~18 puntos), bloqueos conocidos sin resolver al cierre de los documentos (verificación jurídica de plazos, HAR de ComprasMX, plantillas WhatsApp sin aprobar).
- **L01**: reglas del hackathon de OpenAI (stack obligatorio, guardrails de demo).
- **L02**: marco legal de contratación pública México — LAASSP/LOPSRM/LGRA/CFF/REPSE; **fechas de vigencia contradictorias entre archivos** (16-abr vs. 16-jul-2025) y plazo de pago en disputa (17 hábiles vs. 20 naturales) — marcado VERIFICAR.
- **L03**: fuentes de datos/APIs de convocatorias (detalle arriba); patrón de conector único `Source.fetch`+`Mapper.to_ocds`.
- **L04**: panorama competitivo — hueco de mercado en "paquete listo para firmar" y WhatsApp como canal de trabajo primario.
- **L05**: economía del licitante — métrica norte "ROI verificado", pricing ≤20-30% del valor estimado.
- **L06**: agentes de descubrimiento/matching/Go-No-Go — arquitectura híbrida reglas+modelo+LLM explicador.
- **L07**: análisis de bases y cumplimiento — requisito atómico con cita verificada obligatoria (ratio ≥0.9).
- **L08**: redacción de propuestas — ensamblador de evidencia, e.firma siempre local, doble confirmación económica.
- **L09**: post-adjudicación/cobranza/inconformidades — máquina de estados del contrato, citas legales vía copia de terceros en GitHub (no DOF directo).
- **L10**: arquitectura técnica — Supabase multi-tenant, Claims con fuente obligatoria, needs_approval, observabilidad en 3 capas, SLOs.
- **L11-L21**: procesados por un tercer agente (datos históricos/predictivos, expansión LatAm/EEUU/UE, GTM/pricing, cumplimiento legal de datos/competencia, innovación de agentes, plan de ejecución, UX/canales incl. mención no verificada de WCAG 2.2 AA, sectores de obra por estado/municipio, pipeline técnico/evals, mercado TAM/SAM/SOM, y guardrails éticos/anticorrupción G-01 a G-10); su matriz detallada se resumió en su reporte final pero, por instrucción explícita de cerrar la tarea sin abrir más líneas de trabajo, no se transcribió fila por fila en `REQUISITOS.md` — los requisitos legales/técnicos que ya aparecían duplicados en el Blueprint (anticorrupción, multi-tenant, idempotencia, trazabilidad) sí quedaron cubiertos por esa vía.

## Limitaciones declaradas

Ningún documento pudo abrir el DOF ni diputados.gob.mx directamente durante la investigación (proxy bloqueado en las sesiones origen); la mayoría de las citas de artículos de LAASSP/LOPSRM provienen de una copia de terceros en GitHub, no de la fuente oficial. Todo requisito legal sin norma verificable en el PDF fue marcado **VERIFICAR** en `REQUISITOS.md`, siguiendo la instrucción de no inventar respaldo legal.
