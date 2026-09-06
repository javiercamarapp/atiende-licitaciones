import { Link } from "react-router-dom";
import { ShieldAlert, ArrowLeft } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Aviso de privacidad (REQ-119/REQ-131, docs/TABLERO.md §6). Contenido
 * basado en `docs/legal/verificacion-legal.md` (verificación legal real,
 * no redactado de memoria):
 *  - Nueva LFPDPPP, DOF 20-marzo-2025 (vigor 21-marzo-2025), abroga la
 *    LFPDPPP de 2010. El INAI se extinguió el 20-marzo-2025; sus funciones
 *    de protección de datos pasaron a la Secretaría Anticorrupción y Buen
 *    Gobierno (SABG) — responsable de la tutela de este derecho, no de los
 *    datos personales tratados por esta plataforma (ver nota de
 *    responsable más abajo).
 *  - Multas: 200 a 320,000 UMA (texto localizado y verificado).
 *  - Derechos ARCO: plazo de respuesta de 20 días (Art. 31).
 *  - REQ-131: todo enrutamiento a un proveedor/modelo de IA distinto del
 *    principal se declara aquí y en el reporte de transparencia del
 *    producto antes de activarse.
 *
 * NINGUNA cifra ni afirmación de este documento debe presentarse a un
 * cliente real sin validación por un abogado mexicano (ver
 * docs/legal/verificacion-legal.md, sección de metodología) — el aviso
 * completo (17 filas VERIFICADO/VERIFICADO-CON-MATIZ + 4
 * NO-VERIFICABLE-EN-LÍNEA) sigue sin esa revisión profesional.
 */
export default function PrivacyNoticePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link to="/panel" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Volver
      </Link>

      <SectionHeader icon={ShieldAlert} title="Aviso de privacidad" description="Tratamiento de datos personales en Atiende Licitaciones." />

      <Card className="mb-6 border-warning/40 bg-warning/5">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" strokeWidth={1.75} />
          <div>
            <CardTitle className="text-base">Borrador pendiente de validación jurídica</CardTitle>
            <CardDescription>
              Este aviso se redactó a partir de una verificación legal documentada (docs/legal/verificacion-legal.md),
              pero NINGÚN abogado mexicano lo ha validado todavía. No debe presentarse como definitivo a un cliente
              real ni usarse para cumplir una obligación legal sin esa revisión.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      <div className="space-y-6 text-sm leading-relaxed text-foreground">
        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">1. Responsable</h2>
          <p>
            Atiende Licitaciones es responsable del tratamiento de los datos personales que captura de sus usuarios y
            de la información de las empresas que representan (perfil de empresa, documentos, firmantes autorizados,
            tarifas). La Secretaría Anticorrupción y Buen Gobierno (SABG) es la autoridad que tutela el derecho a la
            protección de datos personales a nivel federal (absorbió esa función del extinto INAI, desaparecido el
            20 de marzo de 2025) — SABG no es responsable de los datos que esta plataforma trata, es la autoridad
            ante quien se ejercen los derechos ARCO cuando el responsable no atiende una solicitud.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">2. Marco legal</h2>
          <p>
            Este aviso se rige por la nueva Ley Federal de Protección de Datos Personales en Posesión de Sujetos
            Obligados (LFPDPPP), publicada en el Diario Oficial de la Federación (DOF) el 20 de marzo de 2025 (vigor
            desde el 21 de marzo de 2025), que abroga la LFPDPPP de 2010.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">3. Datos que se tratan</h2>
          <ul className="list-inside list-disc space-y-1">
            <li>Datos de cuenta: correo electrónico, nombre.</li>
            <li>Datos de la empresa: perfil, capacidades, experiencia, documentos (con vigencia), firmantes autorizados, tarifas.</li>
            <li>Documentos de licitación que subas (bases, anexos, aclaraciones) y el contenido extraído de ellos.</li>
            <li>Registro de auditoría de las acciones que realizas en la plataforma (bitácora append-only).</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">4. Uso de inteligencia artificial (REQ-131)</h2>
          <p>
            Algunas funciones (análisis de bases, redacción de propuestas) usan modelos de lenguaje para generar
            contenido a partir de tus propios datos aprobados. Todo enrutamiento a un proveedor o modelo distinto del
            principal se declarará en este aviso y en un reporte de transparencia del producto ANTES de activarse —
            no existe, a la fecha de esta ronda, ningún proveedor de producción configurado.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">5. Derechos ARCO</h2>
          <p>
            Puedes solicitar Acceso, Rectificación, Cancelación u Oposición (derechos ARCO) sobre tus datos
            personales. El responsable debe responder en un plazo máximo de 20 días (Art. 31 de la LFPDPPP nueva).
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">6. Sanciones</h2>
          <p>
            El incumplimiento de la LFPDPPP puede sancionarse con multas de 200 a 320,000 veces la Unidad de Medida y
            Actualización (UMA) vigente.
          </p>
        </section>

        <section>
          <h2 className="mb-2 font-display text-lg font-semibold">7. Fuente y trazabilidad</h2>
          <p>
            El detalle de cada cita legal de este aviso (ley, artículo, fecha DOF, nivel de verificación) está en{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">docs/legal/verificacion-legal.md</code>{" "}
            del repositorio. Este aviso no incorpora ninguna cifra o afirmación que no esté citada ahí.
          </p>
        </section>
      </div>
    </div>
  );
}
