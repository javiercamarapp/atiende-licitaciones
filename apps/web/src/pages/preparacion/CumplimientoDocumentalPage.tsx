import { FolderCheck } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: FolderCheck,
  title: "Cumplimiento documental",
  description: "Acopio y verificación de anexos, certificados y documentos obligatorios.",
  emptyTitle: "Aún no hay documentos cargados",
  emptyDescription: "Los documentos requeridos por cada convocatoria aparecerán aquí a medida que los cargues.",
});

export default Page;
