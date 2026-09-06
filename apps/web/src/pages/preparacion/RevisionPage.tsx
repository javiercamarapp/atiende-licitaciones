import { ClipboardCheck } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: ClipboardCheck,
  title: "Revisión",
  description: "Control de calidad antes de la entrega de la propuesta.",
  emptyTitle: "Aún no hay revisiones pendientes",
  emptyDescription: "Las propuestas listas para revisión aparecerán aquí antes de su entrega.",
});

export default Page;
