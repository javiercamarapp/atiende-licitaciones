import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, CheckCircle2, FileClock, IdCard, PartyPopper, UserPlus, Upload, Check } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { OnboardingAssistant } from "@/pages/onboarding/OnboardingAssistant";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useCreateOrganization } from "@/hooks/useOrganizations";
import { useCompanyProfile, useSaveCompanyProfile, useUploadDocument } from "@/hooks/useCompany";
import { useInviteMember } from "@/hooks/useMemberships";
import { ORG_ROLES, type OrgRole } from "@/lib/api/schemas";
import { DOCUMENT_ACCEPT_ATTR, validateDocumentFile } from "@/lib/validateDocumentFile";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

const STEPS = [
  { id: 1, label: "Organización" },
  { id: 2, label: "Perfil de empresa" },
  { id: 3, label: "Invitar equipo" },
  { id: 4, label: "Primer documento" },
  { id: 5, label: "Listo" },
] as const;

// WB-10 (docs/auditoria-2/web-r7-r8a.md §4): el paso del wizard solo vivía
// en `useState` de React -- si el usuario ya avanzó a un paso OPCIONAL
// (invitar equipo / primer documento, ambos omitibles) y recarga la
// página, el wizard siempre reiniciaba en el paso 2 (perfil), aunque los
// datos de esos pasos ya estuvieran guardados en el servidor. `sessionStorage`
// (no `localStorage`): se pierde intencionalmente al cerrar la pestaña,
// igual que tendría sentido para un asistente de una sola sesión.
const ONBOARDING_STEP_STORAGE_KEY = "atiende.onboarding.step";

function readStoredStep(): number | null {
  try {
    const raw = sessionStorage.getItem(ONBOARDING_STEP_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return STEPS.some((s) => s.id === parsed) ? parsed : null;
  } catch {
    // Almacenamiento bloqueado (navegación privada/política del entorno):
    // se degrada al comportamiento anterior (siempre desde el baseline).
    return null;
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Wizard de bienvenida (ronda 7, docs/investigacion/salida-promocion-referencias.md:
 * "entrevista corta" de Likida adaptada a licitaciones): crear organización
 * → perfil esencial → invitar equipo → primer documento → listo. Cada paso
 * llama a un endpoint real ya existente (nada se simula); los pasos 3 y 4
 * son omitibles (equipo/documento pueden capturarse después desde sus
 * propios módulos) — el paso 1 no lo es (sin organización no hay nada más
 * que hacer, ver RequireOrganization en components/auth/RequireAuth.tsx).
 */
export default function OnboardingPage() {
  const { currentOrgId, memberships } = useAuth();
  const queryClient = useQueryClient();
  // WB-10: capturado UNA SOLA VEZ en un ref (nunca releído de
  // `sessionStorage` más adelante) -- el efecto de persistencia de abajo
  // reescribe la clave en cuanto este componente monta, con el `step`
  // inicial que sea (a veces 1, si `memberships` todavía no hidrató, ver
  // comentario más abajo); sin este ref, la corrección por `currentOrgId`
  // llegaría demasiado tarde y encontraría su propio "1" recién escrito en
  // vez del paso real que el usuario había alcanzado antes de recargar.
  const initialStoredStepRef = useRef<number | null>(readStoredStep());
  const [step, setStep] = useState<number>(() => {
    const baseline = memberships.length > 0 ? 2 : 1;
    const stored = initialStoredStepRef.current;
    // Solo se confía en el paso guardado si ya existe una organización real
    // (baseline >= 2): sin eso, un recorrido previo dejado a medias en la
    // MISMA pestaña (otra cuenta, otra organización) podría adelantar el
    // wizard de una organización nueva a un paso que no le corresponde.
    return stored && baseline >= 2 ? Math.max(stored, baseline) : baseline;
  });

  useDocumentMeta({ title: "Bienvenido a Atiende Licitaciones" });

  // Patrón Likida/atiende.ai #7: cada avance de paso ya implica que la
  // mutación correspondiente (crear organización, guardar perfil, invitar,
  // subir documento) tuvo éxito -- se invalida la query conversacional para
  // que refleje el dato recién capturado en el siguiente render, en vez de
  // esperar su propio intervalo de refetch.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["onboarding", "state"] });
  }, [step, queryClient]);

  // Si otra pestaña/paso ya creó la organización activa mientras este
  // componente estaba montado, no se fuerza el avance de vuelta al paso 1.
  // WB-10: si además había un paso guardado más avanzado (capturado en
  // `initialStoredStepRef` arriba), se respeta ESE en vez de forzar siempre
  // el paso 2 -- `memberships` (usado en el `useState` de arriba para el
  // baseline inicial) solo está garantizado poblado de forma SÍNCRONA
  // cuando este componente cuelga de `<RequireAuth/>` (ver App.tsx); este
  // efecto es la red de seguridad para cuando esa hidratación llega
  // después del primer render (montaje directo en pruebas, o una
  // organización creada en otra pestaña).
  useEffect(() => {
    if (currentOrgId && step === 1) {
      const stored = initialStoredStepRef.current;
      setStep(stored && stored > 1 ? stored : 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo debe reaccionar a la aparición de currentOrgId, no a cada cambio de `step`
  }, [currentOrgId]);

  // WB-10: persiste el paso actual para sobrevivir una recarga real de la
  // pestaña (ver `readStoredStep` arriba).
  useEffect(() => {
    try {
      sessionStorage.setItem(ONBOARDING_STEP_STORAGE_KEY, String(step));
    } catch {
      // Almacenamiento bloqueado -- se degrada a solo-en-memoria, mismo
      // comportamiento que antes de este cambio.
    }
  }, [step]);

  return (
    <>
      <SkipLink targetId="onboarding-main">Saltar al contenido principal</SkipLink>
      <div className="min-h-screen bg-muted/30">
        <header className="border-b border-border bg-card">
          <div className="container flex h-16 items-center justify-between">
            <AtiendeWordmark />
            <p className="text-sm text-muted-foreground">
              ¿Prefieres explorar primero?{" "}
              <Link to="/demo" className="font-medium text-primary underline-offset-4 hover:underline">
                Ver demo
              </Link>
            </p>
          </div>
        </header>

        <main id="onboarding-main" tabIndex={-1} className="container max-w-2xl py-10 focus-visible:outline-none">
          <h1 className="font-display text-2xl font-semibold text-foreground">Bienvenido a Atiende Licitaciones</h1>
          <p className="mt-1 text-sm text-muted-foreground">Cuatro pasos rápidos para dejar tu organización lista.</p>

          <ol aria-label="Progreso del asistente" className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-3 text-xs font-medium">
            {STEPS.map((s, index) => (
              <li key={s.id} className="flex items-center gap-2" aria-current={step === s.id ? "step" : undefined}>
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full ${
                    step > s.id ? "bg-success text-success-foreground" : step === s.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {step > s.id ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : s.id}
                </span>
                <span className={step === s.id ? "text-foreground" : "text-muted-foreground"}>{s.label}</span>
                {index < STEPS.length - 1 && <span aria-hidden="true" className="mx-1 h-px w-4 bg-border" />}
              </li>
            ))}
          </ol>

          <div className="mt-6">
            <OnboardingAssistant />
          </div>

          <div className="mt-2">
            {step === 1 && <StepOrganizacion onDone={() => setStep(2)} />}
            {step === 2 && <StepPerfil onDone={() => setStep(3)} />}
            {step === 3 && <StepEquipo onDone={() => setStep(4)} onSkip={() => setStep(4)} />}
            {step === 4 && <StepDocumento onDone={() => setStep(5)} onSkip={() => setStep(5)} />}
            {step === 5 && <StepListo />}
          </div>
        </main>
      </div>
    </>
  );
}

const orgSchema = z.object({ name: z.string().min(2, "El nombre de la organización es obligatorio.") });
type OrgValues = z.infer<typeof orgSchema>;

function StepOrganizacion({ onDone }: { onDone: () => void }) {
  const createOrganization = useCreateOrganization();
  const form = useForm<OrgValues>({ resolver: zodResolver(orgSchema), defaultValues: { name: "" } });

  const onSubmit = async (values: OrgValues) => {
    try {
      await createOrganization.mutateAsync({ name: values.name, slug: `${slugify(values.name)}-${Date.now().toString(36)}` });
      toast.success("Organización creada.");
      onDone();
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Building2 className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <CardTitle level={2} className="text-lg">
          Crea tu organización
        </CardTitle>
        <CardDescription>Es el espacio de trabajo donde vivirán tus convocatorias, documentos y equipo.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre de la organización</FormLabel>
                  <FormControl>
                    <Input placeholder="Mi Empresa S.A. de C.V." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={createOrganization.isPending}>
              {createOrganization.isPending ? "Creando…" : "Crear organización y continuar"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

const profileSchema = z.object({
  legalName: z.string().min(1, "La razón social es obligatoria."),
  taxId: z.string().min(1, "El RFC es obligatorio."),
  sector: z.string().optional(),
});
type ProfileValues = z.infer<typeof profileSchema>;

function StepPerfil({ onDone }: { onDone: () => void }) {
  const { data: profile } = useCompanyProfile();
  const saveProfile = useSaveCompanyProfile();
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    values: { legalName: profile?.legalName ?? "", taxId: profile?.taxId ?? "", sector: profile?.sector ?? "" },
  });

  const onSubmit = async (values: ProfileValues) => {
    try {
      await saveProfile.mutateAsync({ legalName: values.legalName, taxId: values.taxId, sector: values.sector || undefined });
      toast.success("Perfil de empresa guardado.");
      onDone();
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <IdCard className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <CardTitle level={2} className="text-lg">
          Perfil de empresa esencial
        </CardTitle>
        <CardDescription>Lo mínimo para calcular elegibilidad en convocatorias reales — puedes ampliarlo después.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="legalName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Razón social</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="taxId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>RFC</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="sector"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Giro / sector</FormLabel>
                  <FormControl>
                    <Input placeholder="p. ej. Construcción, TI, Consultoría" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Honesto: el perfil de empresa de apps/api todavía no persiste
                ubicación ni códigos CPV detallados (ver
                lib/api/schemas.ts, companyProfileSchema) -- no se agrega un
                campo que no se guardaría. Queda como nota para una ronda
                futura de apps/api. */}
            <p className="rounded-lg bg-muted/40 p-2.5 text-xs text-muted-foreground">
              Ubicación y códigos CPV detallados todavía no se capturan aquí (pendiente en una ronda futura de la API) —
              el giro/sector de arriba ya se usa en el cálculo de matching.
            </p>
            <Button type="submit" disabled={saveProfile.isPending}>
              {saveProfile.isPending ? "Guardando…" : "Guardar y continuar"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

const inviteSchema = z.object({ email: z.string().email("Correo inválido."), role: z.enum(ORG_ROLES) });
type InviteValues = z.infer<typeof inviteSchema>;

function StepEquipo({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const invite = useInviteMember();
  const [invited, setInvited] = useState<string[]>([]);
  const form = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", role: "writer" as OrgRole } });

  const onSubmit = async (values: InviteValues) => {
    try {
      await invite.mutateAsync(values);
      setInvited((prev) => [...prev, values.email]);
      toast.success(`Invitación enviada a ${values.email}.`);
      form.reset({ email: "", role: values.role });
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <UserPlus className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <CardTitle level={2} className="text-lg">
          Invita a tu equipo
        </CardTitle>
        <CardDescription>Opcional — puedes invitar personas ahora o después desde Usuarios y roles.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="min-w-[220px] flex-1">
                  <FormLabel>Correo</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="persona@empresa.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rol</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Rol a invitar" className="w-[150px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ORG_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormItem>
              )}
            />
            <Button type="submit" disabled={invite.isPending} className="gap-1.5">
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Invitar
            </Button>
          </form>
        </Form>

        {invited.length > 0 && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {invited.map((email) => (
              <li key={email} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                {email}
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onSkip}>
            Omitir por ahora
          </Button>
          {invited.length > 0 && <Button type="button" onClick={onDone}>Continuar</Button>}
        </div>
      </CardContent>
    </Card>
  );
}

const documentSchema = z.object({ documentType: z.string().min(1, "Indica el tipo de documento."), validUntil: z.string().optional() });
type DocumentValues = z.infer<typeof documentSchema>;

function StepDocumento({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const uploadDocument = useUploadDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const form = useForm<DocumentValues>({ resolver: zodResolver(documentSchema), defaultValues: { documentType: "", validUntil: "" } });

  const onSubmit = async (values: DocumentValues) => {
    if (!selectedFile) {
      toast.error("Selecciona un archivo antes de subir el documento.");
      return;
    }
    const validation = validateDocumentFile(selectedFile);
    if (!validation.ok) {
      toast.error(validation.message ?? "Archivo no admitido.");
      return;
    }
    try {
      const contentBase64 = await fileToBase64(selectedFile);
      await uploadDocument.mutateAsync({ documentType: values.documentType, contentBase64, validUntil: values.validUntil || undefined });
      toast.success("Documento subido.");
      onDone();
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FileClock className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <CardTitle level={2} className="text-lg">
          Sube tu primer documento
        </CardTitle>
        <CardDescription>Opcional — con vigencia, para que el semáforo de documentos empiece a tener datos reales.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="documentType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tipo de documento</FormLabel>
                  <FormControl>
                    <Input placeholder="p. ej. Constancia de situación fiscal" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="validUntil"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Vigente hasta</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div>
              <label htmlFor="onboarding-doc-file" className="mb-1.5 block text-sm font-medium text-foreground">
                Archivo
              </label>
              <input
                id="onboarding-doc-file"
                ref={fileInputRef}
                type="file"
                accept={DOCUMENT_ACCEPT_ATTR}
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground"
              />
            </div>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={onSkip}>
                Omitir por ahora
              </Button>
              <Button type="submit" disabled={uploadDocument.isPending} className="gap-1.5">
                <Upload className="h-4 w-4" aria-hidden="true" />
                {uploadDocument.isPending ? "Subiendo…" : "Subir y continuar"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function StepListo() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
          <PartyPopper className="h-7 w-7" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <CardTitle level={2} className="text-xl">
          Tu organización está lista
        </CardTitle>
        <CardDescription>
          Revisa tu checklist de activación en el Panel — se actualiza solo conforme completas cada paso con datos reales.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center">
        <Button
          onClick={() => {
            // Onboarding terminado: limpia el paso persistido (WB-10) para
            // que una futura organización nueva en esta misma pestaña
            // arranque limpia en vez de heredar el paso 5 de esta.
            try {
              sessionStorage.removeItem(ONBOARDING_STEP_STORAGE_KEY);
            } catch {
              // Sin almacenamiento no hay nada que limpiar.
            }
            navigate("/panel");
          }}
        >
          Ir al panel
        </Button>
      </CardContent>
    </Card>
  );
}
