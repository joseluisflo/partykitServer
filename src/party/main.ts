import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";

// Definimos la interfaz del Entorno (Variables)
interface Env {
  GEMINI_API_KEY: string;
  PARTYKIT_DURABLE: DurableObjectNamespace;
}

// Definimos interfaces mínimas para la sesión de Google (igual que antes)
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

export class PartyKitDurable implements DurableObject {
  state: DurableObjectState;
  env: Env;
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // -----------------------------------------------------------------------
  // 1. EL "PORTERO": Método fetch (Reemplaza a la lógica automática de PartyKit)
  // -----------------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    // Verificamos que sea una petición de WebSocket (Handshake)
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    // Creamos el par de WebSockets (Uno para el cliente/Twilio, otro para el servidor/Worker)
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Aceptamos la conexión en el lado del servidor
    this.handleConnection(server, request);

    // Devolvemos la conexión al cliente (Twilio) con estado 101 (Switching Protocols)
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // -----------------------------------------------------------------------
  // 2. LÓGICA DE CONEXIÓN (Lo que antes tenías en onConnect)
  // -----------------------------------------------------------------------
  async handleConnection(webSocket: WebSocket, request: Request) {
    // Aceptamos el socket explícitamente (Requisito nativo)
    webSocket.accept();
    this.ws = webSocket;
    console.log(`[Native Worker] Conexión WebSocket aceptada.`);

    const url = new URL(request.url);
    const systemInstruction = url.searchParams.get("systemInstruction");
    const agentVoice = url.searchParams.get("agentVoice") || 'Zephyr';

    // Validación de parámetros
    if (!systemInstruction) {
      console.error("[Native Worker] Error: systemInstruction is missing.");
      this.ws.close(1002, "Agent instruction is required.");
      return;
    }

    // Validación de API Key
    if (!this.env.GEMINI_API_KEY) {
      console.error("[Native Worker] Error: GEMINI_API_KEY is not set.");
      this.ws.close(1011, "AI service is not configured.");
      return;
    }

    // Configuración de listeners del WebSocket (Twilio -> Worker)
    this.ws.addEventListener("message", (event) => {
      // Convertimos el dato a string porque Twilio manda JSON texto
      this.onMessage(event.data as string);
    });

    this.ws.addEventListener("close", () => {
      this.onClose();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[Native Worker] WebSocket error:", err);
      this.onClose();
    });

    // Conexión a Google Gemini
    const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

    try {
      this.googleAISession = (await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: { interruptions: true },
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } },
          },
          systemInstruction: decodeURIComponent(systemInstruction),
        },
        callbacks: {
          onopen: () => {
            console.log("[Native Worker] Google AI session opened.");
            // Iniciamos la conversación
            this.googleAISession?.sendRealtimeInput({ text: "start" });
          },
          onmessage: (message) => {
            // Worker -> Twilio
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && this.ws && this.ws.readyState === WebSocket.OPEN) {
              const twilioMessage = {
                event: "media",
                streamSid: "stream-id-placeholder", // Twilio a veces necesita esto, pero en streaming broadcast suele funcionar sin ID específico
                media: { payload: audioData },
              };
              this.ws.send(JSON.stringify(twilioMessage));
            }
          },
          onerror: (e) => {
            console.error("[Native Worker] Google AI Error:", e);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1011, "An AI service error occurred.");
            }
          },
          onclose: () => {
            console.log("[Native Worker] Google AI session closed.");
            this.onClose();
          },
        },
      })) as MinimalLiveSession;

    } catch (error) {
      console.error("[Native Worker] Failed to connect to Google AI:", error);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
         this.ws.close(1011, "Could not connect to AI service.");
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3. PROCESAMIENTO DE MENSAJES (Twilio -> Worker -> AI)
  // -----------------------------------------------------------------------
  onMessage(message: string) {
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
        console.log('[Native Worker] Twilio stream stop message received.');
        this.onClose();
      }
    } catch (e) {
      console.error("[Native Worker] Error parsing message from Twilio", e);
    }
  }

  // -----------------------------------------------------------------------
  // 4. LIMPIEZA
  // -----------------------------------------------------------------------
  onClose() {
    console.log("[Native Worker] Connection closing.");
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
    // Asegurarse de cerrar el socket si sigue abierto
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "Closing connection.");
    }
  }
}