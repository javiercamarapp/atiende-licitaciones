// Cliente HTTP tipado hacia apps/api. No hay backend implementado todavía en
// esta ronda: cada función expone su forma de datos y lanza ApiError con el
// mensaje real de la respuesta para que la UI lo muestre en <ErrorState/> en
// vez de fingir datos de éxito.
const API_URL = import.meta.env.VITE_API_URL;

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      headers: { "Content-Type": "application/json", ...init?.headers },
      ...init,
    });
  } catch {
    throw new ApiError("No se pudo conectar con el servidor. Verifica tu conexión e inténtalo de nuevo.");
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { message?: string };
      if (body?.message) detail = body.message;
    } catch {
      // El cuerpo no era JSON; se conserva el statusText.
    }
    throw new ApiError(detail || `Error ${response.status}`, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- Autenticación ---

export interface LoginPayload {
  email: string;
  password: string;
}

export interface MagicLinkPayload {
  email: string;
}

export interface SessionResponse {
  userId: string;
  email: string;
  organizationId: string;
}

export function login(payload: LoginPayload): Promise<SessionResponse> {
  return request<SessionResponse>("/auth/login", { method: "POST", body: JSON.stringify(payload) });
}

export function requestMagicLink(payload: MagicLinkPayload): Promise<{ sent: true }> {
  return request<{ sent: true }>("/auth/magic-link", { method: "POST", body: JSON.stringify(payload) });
}

// --- Convocatorias ---

export interface Convocatoria {
  id: string;
  titulo: string;
  entidad: string;
  fechaLimite: string;
  estado: "abierta" | "en_evaluacion" | "cerrada";
}

export function listConvocatorias(): Promise<Convocatoria[]> {
  return request<Convocatoria[]>("/convocatorias");
}

// --- Organizaciones (para el selector de organización del header) ---

export interface Organizacion {
  id: string;
  nombre: string;
}

export function listOrganizaciones(): Promise<Organizacion[]> {
  return request<Organizacion[]>("/organizaciones");
}
