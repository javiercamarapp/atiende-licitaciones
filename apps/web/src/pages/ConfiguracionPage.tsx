import { Settings } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Settings,
  title: "Configuración",
  description: "Fuentes de convocatorias, reglas de matching, notificaciones e integraciones.",
  emptyTitle: "Aún no hay configuración definida",
  emptyDescription: "Configura las fuentes e integraciones de tu organización para empezar.",
});

export default Page;
