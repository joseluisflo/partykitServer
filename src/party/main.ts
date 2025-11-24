import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";

// Definimos la interfaz del Entorno (Variables)
interface Env {
  GEMINI_API_KEY: string;
  PARTYKIT_DURABLE: DurableObjectNamespace;
}

// Definimos interfaces mínimas para la sesión de Google
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

export class PartyKitDurable implements DurableObject {
  state: DurableObjectState;
  env: Env;
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;
  
  // Variables para guardar configuración temporal hasta que conectemos
  pendingSystemInstruction: string | null = null;
  agentVoice: string = 'Zephyr';
  streamSid: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // -----------------------------------------------------------------------
  // 1. EL "PORTERO": Método fetch
  // -----------------------------------------------------------------------
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleConnection(server, request);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // -----------------------------------------------------------------------
  // 2. LÓGICA DE CONEXIÓN INICIAL
  // -----------------------------------------------------------------------
  async handleConnection(webSocket: WebSocket, request: Request) {
    webSocket.accept();
    this.ws = webSocket;
    console.log(`[Native Worker] Conexión WebSocket aceptada.`);

    // Ya NO buscamos systemInstruction en la URL.
    // Solo recuperamos configuración ligera si existe.
    const url = new URL(request.url);
    this.agentVoice = url.searchParams.get("agentVoice") || 'Zephyr';

    if (!this.env.GEMINI_API_KEY) {
      console.error("[Native Worker] Error: GEMINI_API_KEY is not set.");
      this.ws.close(1011, "AI service is not configured.");
      return;
    }

    this.ws.addEventListener("message", (event) => {
      this.onMessage(event.data as string);
    });

    this.ws.addEventListener("close", () => {
      this.onClose();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[Native Worker] WebSocket error:", err);
      this.onClose();
    });
  }

  // -----------------------------------------------------------------------
  // 3. PROCESAMIENTO DE MENSAJES (Twilio -> Worker)
  // -----------------------------------------------------------------------
  async onMessage(message: string) {
    try {
      const twilioMessage = JSON.parse(message);

      // --- EVENTO START: Aquí recibimos los parámetros personalizados ---
      if (twilioMessage.event === "start") {
        console.log("[Native Worker] Recibido evento start de Twilio.");
        this.streamSid = twilioMessage.start.streamSid;
        
        const customParams = twilioMessage.start.customParameters;

        if (customParams && customParams.systemInstruction) {
            console.log("[Native Worker] Instrucción del sistema recibida correctamente.");
            this.pendingSystemInstruction = customParams.systemInstruction;
            
            // AHORA que tenemos la instrucción, conectamos a Google AI
            await this.connectToGoogleAI();
        } else {
            console.warn("[Native Worker] ADVERTENCIA: No se recibió systemInstruction en customParameters.");
            // Podrías poner un fallback aquí si quieres
            this.ws?.close(1002, "Missing systemInstruction");
        }
      } 
      // --- EVENTO MEDIA: Audio del usuario ---
      else if (twilioMessage.event === "media") {
        if (this.googleAISession) {
          this.googleAISession.sendRealtimeInput({
            media: {
              data: twilioMessage.media.payload,
              mimeType: "audio/pcm;rate=8000"
            }
          });
        }
      } 
      // --- EVENTO STOP ---
      else if (twilioMessage.event === 'stop') {
        console.log('[Native Worker] Twilio stream stop message received.');
        this.onClose();
      }
    } catch (e) {
      console.error("[Native Worker] Error parsing message from Twilio", e);
    }
  }

  // -----------------------------------------------------------------------
  // 4. CONEXIÓN A GOOGLE AI (Se llama solo tras recibir el evento 'start')
  // -----------------------------------------------------------------------
  async connectToGoogleAI() {
    if (!this.pendingSystemInstruction) return;

    const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

    try {
      this.googleAISession = (await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: { interruptions: true },
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.agentVoice } },
          },
          // Aquí usamos la instrucción que sacamos del parámetro de Twilio
          systemInstruction: this.pendingSystemInstruction, 
        },
        callbacks: {
          onopen: () => {
            console.log("[Native Worker] Google AI session opened.");
            this.googleAISession?.sendRealtimeInput({ text: "start" });
          },
          onmessage: (message) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && this.ws && this.ws.readyState === WebSocket.OPEN) {
              const twilioMessage = {
                event: "media",
                streamSid: this.streamSid,
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
  // 5. LIMPIEZA
  // -----------------------------------------------------------------------
  onClose() {
    console.log("[Native Worker] Connection closing.");
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "Closing connection.");
    }
  }
}