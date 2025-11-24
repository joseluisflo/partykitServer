import { PartyKitDurable } from "./party/main";

export { PartyKitDurable }; // Exportamos la clase para que Cloudflare la encuentre

interface Env {
  PARTYKIT_DURABLE: DurableObjectNamespace; // <--- COINCIDE CON EL TOML
  GEMINI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Extraer ID de la sala (ej: /party/ID_DE_LA_SALA)
    // Ajusta esto según cómo sea tu URL real. Si es "partykit...dev/party/abc", usa:
    const pathParts = url.pathname.split("/");
    const roomId = pathParts[2]; // [0]="", [1]="party", [2]="ID"

    if (!roomId) {
      return new Response("Room ID not found", { status: 404 });
    }

    const id = env.PARTYKIT_DURABLE.idFromName(roomId); // <--- USAMOS EL BINDING CORRECTO
    const stub = env.PARTYKIT_DURABLE.get(id);

    return stub.fetch(request);
  },
};