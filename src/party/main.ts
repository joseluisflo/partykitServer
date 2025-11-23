import type * as Party from "partykit/server";
import { GoogleGenAI, type LiveSession } from "@google/genai";

// --- DEFINICIONES DE TIPOS ---
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

// --- CLASE LÓGICA DEL SERVIDOR (SIN CAMBIOS) ---
// Esta clase contiene la lógica principal para interactuar con Google AI.
class CallServerLogic {
  googleAISession: MinimalLiveSession | null = null;
  
  constructor(
    private room: Party.Room, 
    private partyConnection: Party.Connection
  ) {}

  async connectToGoogleAI(agentId: string) {
    console.log(`[PartyKit Logic] AgentID received: ${agentId}. Proceeding with Google AI.`);

    const apiKey = (this.room.env as any).GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[PartyKit Logic] Error: GEMINI_API_KEY is not set.");
      this.partyConnection.close(1011, "AI service is not configured.");
      return;
    }
    
    const ai = new GoogleGenAI({ apiKey: apiKey });

    try {
      this.googleAISession = (await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: ["AUDIO"],
          inputAudioTranscription: { interruptions: true },
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("[PartyKit Logic] Google AI session opened.");
            this.googleAISession?.sendRealtimeInput({ text: "start" });
          },
          onmessage: (message) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const twilioMessage = {
                event: "media",
                streamSid: this.room.id,
                media: { payload: audioData },
              };
              // Envía el audio de vuelta a Twilio a través de la conexión principal
              this.partyConnection.send(JSON.stringify(twilioMessage));
            }
          },
          onerror: (e) => {
            console.error("[PartyKit Logic] Google AI Error:", e);
            this.partyConnection.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[PartyKit Logic] Google AI session closed.");
            if ((this.partyConnection as any).readyState === 1) { // 1 = OPEN
                this.partyConnection.close(1000, "AI session ended.");
            }
          },
        },
      })) as MinimalLiveSession;
    } catch (error) {
      console.error("[PartyKit Logic] Failed to connect to Google AI:", error);
      this.partyConnection.close(1011, "Could not connect to AI service.");
    }
  }

  handleIncomingMessage(message: string) {
    if (!this.googleAISession) return;
    try {
        const twilioMessage = JSON.parse(message);
        if (twilioMessage.event === "media") {
            this.googleAISession.sendRealtimeInput({
                media: {
                    data: twilioMessage.media.payload,
                    mimeType: "audio/pcm;rate=8000"
                }
            });
        } else if (twilioMessage.event === 'stop') {
            console.log('[PartyKit Logic] Twilio stream stopped.');
            this.closeAll();
        }
    } catch (e) {
        console.error("Error parsing message", e);
    }
  }

  closeAll() {
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
  }
}

// --- ADAPTADOR DE DURABLE OBJECT (LA "HABITACIÓN" DEL HOTEL) ---
// Esta es la clase que Wrangler conoce y que gestiona las conexiones.
export class PartyKitDurable implements DurableObject {
  state: DurableObjectState;
  env: any;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(p => p);
    const agentId = pathParts.length >= 3 ? pathParts[2] : url.searchParams.get("agentId");

    if (!agentId) {
        server.close(1002, "Agent ID is required.");
        return new Response(null, { status: 101, webSocket: client });
    }

    // Party.Room y Party.Connection son más abstractos de lo que necesitamos aquí.
    // Usaremos la conexión WebSocket del servidor directamente.
    const fakeRoom = { env: this.env, id: this.state.id.toString() } as Party.Room;
    const logic = new CallServerLogic(fakeRoom, server as unknown as Party.Connection);

    await logic.connectToGoogleAI(agentId);

    server.addEventListener("message", (event) => {
      logic.handleIncomingMessage(event.data as string);
    });

    const closeOrErrorHandler = () => {
      logic.closeAll();
    };
    server.addEventListener("close", closeOrErrorHandler);
    server.addEventListener("error", closeOrErrorHandler);

    return new Response(null, { status: 101, webSocket: client });
  }
}


// --- EL ENRUTADOR PRINCIPAL (EL "RECEPCIONISTA") ---
// Este es el punto de entrada principal para todas las solicitudes.
export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(p => p);
    
    // El nombre de la "habitación" (Durable Object) es el Call SID de Twilio
    const roomName = pathParts.find(part => part.startsWith("CA")) || "default-room";
    console.log(`[Router] Path: ${url.pathname}, RoomName: ${roomName}`);

    const id = env.PARTYKIT_DURABLE.idFromName(roomName);
    const stub = env.PARTYKIT_DURABLE.get(id);

    return stub.fetch(request);
  }
};