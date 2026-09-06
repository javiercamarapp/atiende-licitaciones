import { FolderKanban } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: FolderKanban,
  title: "Expediente",
  description: "Matriz de requisitos, propuesta técnica, propuesta económica, anexos y checklist de una convocatoria.",
  emptyTitle: "Aún no hay expediente iniciado",
  emptyDescription: "El expediente se arma automáticamente cuando una convocatoria entra en preparación.",
});

export default Page;
