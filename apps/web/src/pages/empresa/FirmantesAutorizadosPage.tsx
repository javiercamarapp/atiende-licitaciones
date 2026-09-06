import { Signature } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Signature,
  title: "Firmantes autorizados",
  description: "Personas autorizadas para firmar documentos y propuestas en nombre de la empresa.",
  emptyTitle: "Aún no hay firmantes registrados",
  emptyDescription: "Registra a los firmantes autorizados de tu empresa antes de preparar una propuesta.",
});

export default Page;
