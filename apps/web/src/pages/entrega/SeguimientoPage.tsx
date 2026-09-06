import { Timer } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Timer,
  title: "Seguimiento post-adjudicación",
  description: "Estado de convocatorias entregadas: adjudicación, notificación y recursos.",
  emptyTitle: "Aún no hay convocatorias en seguimiento",
  emptyDescription: "Las convocatorias entregadas aparecerán aquí hasta su resolución final.",
});

export default Page;
