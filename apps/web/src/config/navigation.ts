import {
  BarChart3,
  IdCard,
  FileClock,
  Signature,
  Tag,
  Radar,
  Target,
  Wifi,
  Scale,
  FileSearch,
  FolderCheck,
  PenLine,
  ClipboardCheck,
  FolderKanban,
  ShieldCheck,
  Send,
  PackageCheck,
  Timer,
  Building2,
  Users,
  Bot,
  History,
  Settings,
  ListTodo,
  CircleDollarSign,
  AlertOctagon,
  AlertTriangle,
  ShieldAlert,
  ScrollText,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  to: string;
  icon: LucideIcon;
  /** Módulo aún sin implementar detrás: se muestra deshabilitado con
   * etiqueta "Pronto" en vez de fingir que funciona. */
  disabled?: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

// Mapa de sidebar Restaurantes → Licitaciones documentado en
// docs/investigacion/frontend-restaurantes.md §10.1: mismos mecanismos
// (grupos con título + items, acordeón, colapsable), etiquetas adaptadas al
// dominio de licitaciones públicas. Ampliado según
// docs/AMPLIACION-BACKOFFICE.md (ciclo completo: perfil de empresa,
// frescura de fuentes, expediente/aprobaciones, paquete de entrega).
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "analisis",
    label: "Análisis",
    items: [{ id: "panel", label: "Panel", to: "/panel", icon: BarChart3 }],
  },
  {
    id: "empresa",
    label: "Empresa",
    items: [
      { id: "perfil-capacidades", label: "Perfil y capacidades", to: "/empresa/perfil-capacidades", icon: IdCard },
      {
        id: "documentos-vigencias",
        label: "Documentos y vigencias",
        to: "/empresa/documentos-vigencias",
        icon: FileClock,
      },
      {
        id: "firmantes-autorizados",
        label: "Firmantes autorizados",
        to: "/empresa/firmantes-autorizados",
        icon: Signature,
      },
      { id: "tarifas-aprobadas", label: "Tarifas aprobadas", to: "/empresa/tarifas-aprobadas", icon: Tag },
    ],
  },
  {
    id: "convocatorias",
    label: "Convocatorias",
    items: [
      { id: "descubrimiento", label: "Descubrimiento", to: "/convocatorias/descubrimiento", icon: Radar },
      { id: "matching", label: "Matching", to: "/convocatorias/matching", icon: Target },
      { id: "fuentes-frescura", label: "Fuentes y frescura", to: "/convocatorias/fuentes-frescura", icon: Wifi },
    ],
  },
  {
    id: "evaluacion",
    label: "Evaluación",
    items: [
      { id: "go-no-go", label: "Go/No-Go", to: "/evaluacion/go-no-go", icon: Scale },
      { id: "analisis-bases", label: "Análisis de bases", to: "/evaluacion/analisis-bases", icon: FileSearch },
    ],
  },
  {
    id: "preparacion",
    label: "Preparación",
    items: [
      {
        id: "cumplimiento-documental",
        label: "Cumplimiento documental",
        to: "/preparacion/cumplimiento-documental",
        icon: FolderCheck,
      },
      { id: "redaccion", label: "Redacción", to: "/preparacion/redaccion", icon: PenLine },
      { id: "revision", label: "Revisión", to: "/preparacion/revision", icon: ClipboardCheck },
      { id: "expediente", label: "Expediente", to: "/preparacion/expediente", icon: FolderKanban },
      { id: "aprobaciones", label: "Aprobaciones", to: "/preparacion/aprobaciones", icon: ShieldCheck },
    ],
  },
  {
    id: "entrega-seguimiento",
    label: "Entrega y seguimiento",
    items: [
      { id: "entregas", label: "Entregas", to: "/entrega/entregas", icon: Send },
      {
        id: "paquete-descargable",
        label: "Paquete descargable",
        to: "/entrega/paquete-descargable",
        icon: PackageCheck,
      },
      {
        id: "seguimiento",
        label: "Seguimiento post-adjudicación",
        to: "/entrega/seguimiento",
        icon: Timer,
      },
      {
        id: "sala-de-guerra",
        label: "Sala de guerra",
        to: "/entrega/sala-de-guerra",
        icon: AlertTriangle,
      },
    ],
  },
  {
    id: "back-office",
    label: "Back office",
    items: [
      { id: "organizaciones", label: "Organizaciones", to: "/backoffice/organizaciones", icon: Building2 },
      { id: "usuarios-roles", label: "Usuarios y roles", to: "/backoffice/usuarios-roles", icon: Users },
      {
        id: "agentes-herramientas",
        label: "Agentes y herramientas",
        to: "/backoffice/agentes-herramientas",
        icon: Bot,
      },
      { id: "auditoria", label: "Auditoría / Trazabilidad", to: "/backoffice/auditoria", icon: History },
      // Ronda 3 (E10/superadmin): conectores, jobs, costos, incidentes y
      // aprobaciones cross-org — ver apps/api/README.md módulo `admin`.
      { id: "conectores", label: "Conectores", to: "/backoffice/conectores", icon: Wifi },
      { id: "jobs", label: "Jobs", to: "/backoffice/jobs", icon: ListTodo },
      { id: "costos", label: "Costos", to: "/backoffice/costos", icon: CircleDollarSign },
      { id: "incidentes", label: "Incidentes", to: "/backoffice/incidentes", icon: AlertOctagon },
      {
        id: "aprobaciones-backoffice",
        // Nombre accesible distinto del "Aprobaciones" de Preparación
        // (/preparacion/aprobaciones): dos enlaces con el mismo nombre en el
        // mismo <nav> rompen `getByRole("link", { name })` (ambiguo) en
        // AppShell.test.tsx y son indistinguibles para lectores de pantalla.
        label: "Aprobaciones (tool_calls)",
        to: "/backoffice/aprobaciones",
        icon: ShieldCheck,
      },
    ],
  },
  {
    id: "configuracion",
    label: "Configuración",
    items: [
      { id: "configuracion", label: "Configuración", to: "/configuracion", icon: Settings },
      // REQ-119/131: fuera de <AppShell/> a propósito (ver App.tsx) -- un
      // aviso de privacidad debe poder consultarse sin sesión activa, igual
      // que /login.
      { id: "privacidad", label: "Aviso de privacidad", to: "/privacidad", icon: ShieldAlert },
      // Ronda 7: mismo criterio que "Aviso de privacidad" -- pública, fuera
      // de <AppShell/>, ver App.tsx y pages/TermsPage.tsx.
      { id: "terminos", label: "Términos de servicio", to: "/legal/terminos", icon: ScrollText },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
