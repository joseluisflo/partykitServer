import { GoogleGenAI, type LiveSession } from "@google/genai";

// Definición mínima para TypeScript
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

// 1. EL DURABLE OBJECT (Tu "Hotel" con estado)
export class PartyKitDurable {
  state: DurableObjectState;
  env: any;
  googleAISession: MinimalLiveSession | null = null;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  // ESTE ES EL METODO QUE TE FALTABA: El punto de entrada nativo
  async fetch(request: Request) {
    // Si es una petición de WebSocket, hacemos el upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Manejamos la conexión WebSocket
      this.handleWebSocket(server, request);

      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }

    // Si no es WebSocket, respondemos algo básico
    return new Response("Este es un servidor WebSocket para Twilio/GoogleAI", { status: 200 });
  }

  // Aquí adaptamos tu lógica original "onConnect"
  async handleWebSocket(ws: WebSocket, request: Request) {
    ws.accept(); // Aceptamos la conexión
    
    const url = new URL(request.url);
    const agentId = url.searchParams.get("agentId");
    
    console.log(`[DurableObject] Twilio connected. AgentID: ${agentId}`);

    if (!agentId) {
      console.error("[DurableObject] Error: agentId is missing.");
      ws.close(1002, "Agent ID is required.");
      return;
    }

    if (!this.env.GEMINI_API_KEY) {
      console.error("[DurableObject] Error: GEMINI_API_KEY is not set.");
      ws.close(1011, "AI service is not configured.");
      return;
    }

    const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

    // Configurar listeners del WebSocket de Twilio
    ws.addEventListener("message", async (event) => {
      if (!this.googleAISession) return;

      try {
        const messageStr = event.data as string;
        const twilioMessage = JSON.parse(messageStr);

        if (twilioMessage.event === "media") {
          const audioPayload = twilioMessage.media.payload;
          this.googleAISession.sendRealtimeInput({
            media: {
              data: audioPayload,
              mimeType: "audio/pcm;rate=8000"
            }
          });
        } else if (twilioMessage.event === 'stop') {
          console.log('[DurableObject] Twilio stream stopped.');
          this.googleAISession?.close();
        }
      } catch (err) {
        console.error("Error parsing Twilio message:", err);
      }
    });

    ws.addEventListener("close", () => {
        console.log("[DurableObject] Twilio disconnected");
        if (this.googleAISession) {
            this.googleAISession.close();
            this.googleAISession = null;
        }
    });

    // Conectar a Google AI
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
            console.log("[DurableObject] Google AI session opened.");
            // Iniciar conversación
             this.googleAISession?.sendRealtimeInput({ text: "start" });
          },
          onmessage: (message) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const twilioMessage = {
                event: "media",
                streamSid: "stream-placeholder", // Se actualizará si guardas el streamSid
                media: {
                  payload: audioData,
                },
              };
              // Necesitamos que el WebSocket esté abierto para enviar
              if(ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(twilioMessage));
              }
            }
          },
          onerror: (e) => {
            console.error("[DurableObject] Google AI Error:", e);
            ws.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[DurableObject] Google AI session closed.");
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1000, "AI session ended.");
            }
          },
        },
      })) as MinimalLiveSession;
    } catch (error) {
      console.error("[DurableObject] Failed to connect to Google AI:", error);
      ws.close(1011, "Could not connect to AI service.");
      return;
    }
  }
}

// 2. EL ROUTER (El "Recepcionista" Stateless)
// Esto es lo que soluciona el error "stateless".
export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    
    // Usamos una ID fija o basada en la URL para crear la instancia del Durable Object.
    // "default-room" asegura que siempre vayamos a una sala válida para probar.
    const id = env.PARTYKIT_DURABLE.idFromName("twilio-default-room");
    const stub = env.PARTYKIT_DURABLE.get(id);

    // Pasamos la petición al Durable Object
    return stub.fetch(request);
  }
};