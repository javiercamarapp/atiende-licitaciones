import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  Radar,
  Target,
  FolderKanban,
  Send,
  ShieldCheck,
  ShieldAlert,
  Building2,
  Landmark,
  HardHat,
  Laptop2,
  ArrowRight,
  PlayCircle,
  Mail,
} from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

/**
 * Landing pública (ronda 7, docs/AMPLIACION-2-SALIDA.md §3-4 y
 * docs/REQUISITOS.md §34.4): estructura de landing de Likida (hero → cómo
 * funciona → seguridad/no-actuación → casos por perfil → planes → FAQ →
 * demo → pie legal) aplicada a la identidad visual de Atiende (mismos
 * tokens/tipografía que el resto del panel, ver tailwind.config.ts).
 *
 * Sin precios ni checkout (B-04 pendiente, ver docs/BACKLOG.md): la
 * sección "Planes" muestra "próximamente / solicitar propuesta" en vez de
 * montos o un flujo de pago que no existe.
 *
 * Sin analítica de ningún tipo: no se añade ningún script de terceros (GA,
 * Meta Pixel, etc.) que pudiera recolectar datos personales de un
 * visitante sin sesión ni consentimiento — ver aviso de privacidad
 * (/privacidad) y el CSP real (apps/web/src/lib/security/csp.ts), que ya
 * bloquearía cualquier `connect-src`/`script-src` no declarado.
 */
export default function LandingPage() {
  const { status } = useAuth();

  useDocumentMeta({
    title: "Atiende Licitaciones",
    description:
      "Descubrimiento, matching y expediente para licitaciones públicas en México. Tú decides y presentas — la plataforma nunca envía, firma ni contacta en tu nombre.",
    robots: "index, follow",
  });

  // Un usuario con sesión activa no necesita ver la landing de nuevo — va
  // directo a su panel (mismo patrón que LoginPage.tsx).
  if (status === "authenticated") {
    return <Navigate to="/panel" replace />;
  }

  return (
    <>
      <SkipLink targetId="main-content">Saltar al contenido principal</SkipLink>
      <div className="min-h-screen bg-background">
        <LandingHeader />
        <main id="main-content" tabIndex={-1} className="focus-visible:outline-none">
          <HeroSection />
          <ComoFuncionaSection />
          <SeguridadSection />
          <CasosSection />
          <PlanesSection />
          <FaqSection />
          <DemoRequestSection />
        </main>
        <LandingFooter />
      </div>
    </>
  );
}

function LandingHeader() {
  return (
    <header className="border-b border-border bg-card/60 backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        <AtiendeWordmark />
        <nav aria-label="Navegación principal" className="hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex">
          <a href="#como-funciona" className="hover:text-foreground">
            Cómo funciona
          </a>
          <a href="#seguridad" className="hover:text-foreground">
            Seguridad
          </a>
          <a href="#casos" className="hover:text-foreground">
            Casos de uso
          </a>
          <a href="#planes" className="hover:text-foreground">
            Planes
          </a>
          <a href="#faq" className="hover:text-foreground">
            Preguntas frecuentes
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link to="/login">Iniciar sesión</Link>
          </Button>
          <Button asChild size="sm">
            <a href="#demo">Solicitar demo</a>
          </Button>
        </div>
      </div>
    </header>
  );
}

function HeroSection() {
  return (
    <section className="border-b border-border bg-[linear-gradient(180deg,hsl(var(--muted))_0%,hsl(var(--background))_65%)]">
      <div className="container grid gap-10 py-16 sm:py-20 lg:grid-cols-2 lg:items-center lg:py-28">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Licitaciones públicas en México</p>
          <h1 className="font-display mt-4 text-4xl font-semibold leading-[1.1] text-foreground sm:text-5xl">
            Encuentra, evalúa y arma tu expediente de licitación en un solo lugar
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Atiende Licitaciones descubre convocatorias públicas relevantes para tu empresa, evalúa si te conviene
            participar y arma el expediente documental — pero la presentación final siempre queda en tus manos.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="gap-2">
              <Link to="/demo">
                <PlayCircle className="h-5 w-5" aria-hidden="true" />
                Ver demo sin cuenta
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="gap-2">
              <a href="#demo">
                Solicitar acceso
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>
        <div aria-hidden="true" className="relative hidden lg:block">
          <div className="absolute -inset-6 rounded-[2rem] bg-primary/10 blur-2xl" />
          <div className="relative rounded-2xl border border-border bg-card p-6 shadow-elevated">
            <ol className="space-y-4">
              {[
                { icon: Radar, label: "Descubrimiento", detail: "Fuentes oficiales monitoreadas" },
                { icon: Target, label: "Matching", detail: "Relevancia y elegibilidad de tu empresa" },
                { icon: FolderKanban, label: "Expediente", detail: "Requisitos, propuesta y checklist" },
                { icon: Send, label: "Presentación", detail: "La haces tú, en el portal oficial" },
              ].map((step, index) => (
                <li key={step.label} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                    {index + 1}
                  </span>
                  <step.icon className="h-5 w-5 shrink-0 text-primary" strokeWidth={1.75} />
                  <div>
                    <p className="font-medium text-foreground">{step.label}</p>
                    <p className="text-xs text-muted-foreground">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

const PASOS = [
  {
    icon: Radar,
    title: "Descubrimiento",
    description: "Convocatorias públicas ingeridas desde fuentes oficiales, con seguimiento de cambios y frescura de cada fuente.",
  },
  {
    icon: Target,
    title: "Matching",
    description: "Relevancia y elegibilidad calculadas por separado contra el perfil real de tu empresa, con el desglose de cada criterio.",
  },
  {
    icon: FolderKanban,
    title: "Expediente",
    description: "Matriz de requisitos, propuesta técnica/económica y checklist de integridad documental antes de presentar.",
  },
  {
    icon: Send,
    title: "Presentación (la haces tú)",
    description: "Declaras cuándo y cómo presentaste ante la convocante — la plataforma nunca presenta, firma ni envía por ti.",
  },
];

function ComoFuncionaSection() {
  return (
    <section id="como-funciona" className="container py-16 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold text-foreground">Cómo funciona</h2>
        <p className="mt-3 text-muted-foreground">Cuatro pasos, del descubrimiento a la presentación — cada uno con datos reales, no simulados.</p>
      </div>
      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {PASOS.map((paso) => (
          <Card key={paso.title}>
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <paso.icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
              </div>
              <CardTitle level={3} className="text-base">
                {paso.title}
              </CardTitle>
              <CardDescription>{paso.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}

const REGLAS_NO_ACTUACION = [
  "Nunca envía ni presenta una propuesta ante la convocante en tu nombre.",
  "Nunca firma documentos ni actas por ti — la firma la aplica siempre una persona autorizada de tu empresa.",
  "Nunca contacta a la dependencia, comité o convocante en tu representación.",
  "Toda aprobación de tarifas o de expediente exige una persona con rol autorizado (y 2FA en las acciones sensibles).",
];

function SeguridadSection() {
  return (
    <section id="seguridad" className="border-y border-border bg-muted/40 py-16 sm:py-20">
      <div className="container grid gap-10 lg:grid-cols-2 lg:items-center">
        <div>
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
          </div>
          <h2 className="font-display text-3xl font-semibold text-foreground">Seguridad y reglas de no actuación</h2>
          <p className="mt-4 max-w-xl text-muted-foreground">
            Atiende Licitaciones es una herramienta de apoyo a la decisión y de organización documental. La
            responsabilidad legal de participar en una licitación pública —y la presentación misma— es siempre de tu
            empresa, nunca de la plataforma.
          </p>
        </div>
        <ul className="space-y-3">
          {REGLAS_NO_ACTUACION.map((regla) => (
            <li key={regla} className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 shadow-card">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" strokeWidth={1.75} />
              <span className="text-sm text-foreground">{regla}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const CASOS = [
  {
    icon: HardHat,
    title: "Constructoras e infraestructura",
    description: "Da seguimiento a obra pública federal y estatal, con matriz de requisitos técnicos y garantías.",
  },
  {
    icon: Laptop2,
    title: "Tecnología y servicios profesionales",
    description: "Detecta convocatorias de TI/consultoría relevantes por CPV y evalúa elegibilidad antes de invertir tiempo.",
  },
  {
    icon: Building2,
    title: "PyMEs de bienes y suministros",
    description: "Organiza documentos y vigencias una sola vez y reutilízalos en cada convocatoria nueva.",
  },
  {
    icon: Landmark,
    title: "Consultoría para el sector público",
    description: "Da trazabilidad completa (auditoría) de cada decisión Go/No-Go frente a comités internos.",
  },
];

function CasosSection() {
  return (
    <section id="casos" className="container py-16 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold text-foreground">Casos por perfil de empresa</h2>
        <p className="mt-3 text-muted-foreground">Distintos giros, el mismo ciclo: descubrir, evaluar, preparar y dar seguimiento.</p>
      </div>
      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {CASOS.map((caso) => (
          <Card key={caso.title}>
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <caso.icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
              </div>
              <CardTitle level={3} className="text-base">
                {caso.title}
              </CardTitle>
              <CardDescription>{caso.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}

/**
 * B-04 (docs/BACKLOG.md) sigue pendiente: no hay definición comercial de
 * precios ni checkout. En vez de inventar montos, cada plan queda honesto
 * como "próximamente" con la misma llamada a la acción que la sección de
 * demo (pedir una propuesta hablando con el equipo).
 */
const PLANES = [
  { name: "Esencial", description: "Descubrimiento y matching para una organización." },
  { name: "Profesional", description: "Expediente completo, aprobaciones y equipo con roles." },
  { name: "Empresarial", description: "Múltiples organizaciones, auditoría extendida y soporte dedicado." },
];

function PlanesSection() {
  return (
    <section id="planes" className="border-y border-border bg-muted/40 py-16 sm:py-20">
      <div className="container">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-3xl font-semibold text-foreground">Planes</h2>
          <p className="mt-3 text-muted-foreground">
            Todavía no publicamos precios (definición comercial pendiente) — cada plan está disponible por propuesta.
          </p>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {PLANES.map((plan) => (
            <Card key={plan.name} className="flex flex-col">
              <CardHeader className="flex-1">
                <CardTitle level={3} className="text-lg">
                  {plan.name}
                </CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Próximamente</p>
                <Button asChild variant="outline" className="w-full">
                  <a href="#demo">Solicitar propuesta</a>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQ_ITEMS = [
  {
    question: "¿Atiende Licitaciones presenta la propuesta por mí?",
    answer:
      "No. Prepara el expediente y te avisa cuándo está listo, pero la presentación ante la convocante (por el portal oficial que corresponda) la haces tú. Después declaras en la plataforma cuándo y cómo la presentaste.",
  },
  {
    question: "¿Qué pasa si mi empresa no es elegible para una convocatoria?",
    answer:
      "El matching muestra la elegibilidad calculada contra tu perfil, con el criterio exacto que no se cumple (o si faltan datos del perfil para evaluarlo) — nunca un puntaje único que oculte el motivo.",
  },
  {
    question: "¿Quién puede aprobar una tarifa o un expediente?",
    answer:
      "Solo los roles autorizados de tu organización (owner/admin/reviewer, según la acción), y las acciones sensibles piden verificación en dos pasos (2FA) además del rol.",
  },
  {
    question: "¿Puedo ver cómo funciona sin crear una cuenta?",
    answer: "Sí — la sección de demo usa datos de ejemplo, claramente etiquetados, para mostrar el flujo completo sin necesidad de registrarte.",
  },
];

function FaqSection() {
  return (
    <section id="faq" className="container py-16 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-display text-3xl font-semibold text-foreground">Preguntas frecuentes</h2>
      </div>
      <div className="mx-auto mt-10 max-w-2xl space-y-3">
        {FAQ_ITEMS.map((item) => (
          // <details>/<summary> nativo: accesible por teclado y lectores de
          // pantalla sin depender de ningún componente de acordeón (no hay
          // ninguno en components/ui — ver listado del directorio).
          <details key={item.question} className="group rounded-2xl border border-border bg-card p-4 shadow-card open:shadow-elevated">
            <summary className="cursor-pointer list-none font-display text-base font-semibold text-foreground marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg">
              {item.question}
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/**
 * "Solicitar demo" (docs/investigacion/salida-promocion-referencias.md):
 * NO hay ningún endpoint de contacto en apps/api (se verificó el listado
 * completo de rutas en apps/api/README.md) — enviar este formulario a
 * cualquier lado sería fingir una integración que no existe. En vez de
 * ocultar la sección o simular un envío exitoso, los campos son
 * capturables (para que quien la use vea la forma real que tendrá) pero el
 * botón de enviar queda deshabilitado con una nota honesta + un canal de
 * contacto real (correo) como alternativa mientras tanto. Ver
 * docs/BACKLOG.md — pendiente para una ronda futura: `POST
 * /contact/demo-request` (o equivalente) en apps/api.
 */
function DemoRequestSection() {
  const [form, setForm] = useState({ name: "", email: "", company: "", message: "" });

  return (
    <section id="demo" className="border-t border-border bg-muted/40 py-16 sm:py-20">
      <div className="container grid gap-10 lg:grid-cols-2 lg:items-start">
        <div>
          <h2 className="font-display text-3xl font-semibold text-foreground">Solicitar demo</h2>
          <p className="mt-3 max-w-md text-muted-foreground">
            Cuéntanos de tu empresa y te contactamos para mostrarte el flujo completo con tus propios datos.
          </p>
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
            Mientras tanto, escríbenos directamente a{" "}
            <a href="mailto:hola@atiende.mx" className="font-medium text-primary underline-offset-4 hover:underline">
              hola@atiende.mx
            </a>
          </p>
        </div>
        <Card>
          <CardContent className="pt-6">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                // No hay backend de contacto todavía (ver docstring de la
                // función): el botón está deshabilitado, así que este
                // manejador nunca debería dispararse — se conserva solo
                // como defensa en profundidad (p. ej. Enter dentro de un
                // campo) para no navegar a ningún lado si algún día se
                // habilita sin código de envío real.
                event.preventDefault();
              }}
            >
              <div>
                <label htmlFor="demo-name" className="mb-1.5 block text-sm font-medium text-foreground">
                  Nombre
                </label>
                <Input id="demo-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoComplete="name" />
              </div>
              <div>
                <label htmlFor="demo-email" className="mb-1.5 block text-sm font-medium text-foreground">
                  Correo de trabajo
                </label>
                <Input
                  id="demo-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  autoComplete="email"
                />
              </div>
              <div>
                <label htmlFor="demo-company" className="mb-1.5 block text-sm font-medium text-foreground">
                  Empresa
                </label>
                <Input id="demo-company" value={form.company} onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))} autoComplete="organization" />
              </div>
              <div>
                <label htmlFor="demo-message" className="mb-1.5 block text-sm font-medium text-foreground">
                  ¿Qué tipo de convocatorias te interesan?
                </label>
                <Textarea id="demo-message" rows={3} value={form.message} onChange={(e) => setForm((f) => ({ ...f, message: e.target.value }))} />
              </div>
              <Button type="submit" className="w-full" disabled title="Formulario aún no conectado a un backend de contacto">
                Enviar solicitud
              </Button>
              <p className="text-xs text-muted-foreground" role="status">
                Este formulario todavía no está conectado a ningún backend de contacto — envío deshabilitado a
                propósito. Se habilitará cuando exista un endpoint real de contacto (ver nota de alcance en el pie de
                página).
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="border-t border-border bg-card py-10">
      <div className="container flex flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
        <AtiendeWordmark markClassName="h-6 w-auto" />
        <nav aria-label="Enlaces legales" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          <Link to="/privacidad" className="hover:text-foreground">
            Aviso de privacidad
          </Link>
          <Link to="/legal/terminos" className="hover:text-foreground">
            Términos de servicio
          </Link>
          <a href="mailto:hola@atiende.mx" className="hover:text-foreground">
            hola@atiende.mx
          </a>
        </nav>
        <p>© {new Date().getFullYear()} Atiende Licitaciones.</p>
      </div>
    </footer>
  );
}
