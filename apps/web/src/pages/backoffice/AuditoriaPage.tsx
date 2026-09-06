import { History } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: History,
  title: "Auditoría / Trazabilidad",
  description: "Historial de acciones relevantes realizadas en la plataforma.",
  emptyTitle: "Aún no hay eventos registrados",
  emptyDescription: "Los eventos de auditoría se irán acumulando aquí a medida que uses la plataforma.",
});

export default Page;
