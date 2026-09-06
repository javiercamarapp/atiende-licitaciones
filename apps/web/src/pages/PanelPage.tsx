import { BarChart3 } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: BarChart3,
  title: "Panel",
  description: "Resumen del estado de tus licitaciones activas.",
  emptyTitle: "Aún no hay datos que mostrar",
  emptyDescription:
    "Cuando descubras o gestiones convocatorias, el panel mostrará aquí las métricas de tu organización.",
});

export default Page;
