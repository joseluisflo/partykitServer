
import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";

// Definimos la interfaz del Entorno (Variables)
interface Env {
  GEMINI_API_KEY: string;
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
  
  // Mejoras para robustez
  isGoogleAIConnected = false;
  pendingAudioQueue: string[] = [];
  twilioStreamSid: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.handleConnection(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
  
  handleConnection(webSocket: WebSocket) {
    webSocket.accept();
    this.ws = webSocket;
    console.log(`[Durable Object] WebSocket connection accepted.`);

    this.ws.addEventListener("message", (event) => {
      this.onMessage(event.data as string);
    });

    this.ws.addEventListener("close", (event) => {
      console.log(`[Durable Object] WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
      this.onClose();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[Durable Object] WebSocket error:", err);
      this.onClose();
    });
  }

  async onMessage(message: string) {
    try {
      const twilioMessage = JSON.parse(message);

      if (twilioMessage.event === "start") {
        console.log("[Durable Object] Received 'start' event from Twilio.");
        this.twilioStreamSid = twilioMessage.start.streamSid;
        
        const params = twilioMessage.start.customParameters;

        if (!params || !params.systemInstruction || !params.agentId) {
          console.error('[Durable Object] ERROR: Missing required customParameters (systemInstruction, agentId).');
          this.ws?.close(1002, 'Missing required parameters');
          return;
        }

        const systemInstruction = Buffer.from(params.systemInstruction, 'base64').toString('utf-8');
        const agentVoice = params.agentVoice || 'Zephyr';
        
        await this.connectToGoogleAI(systemInstruction, agentVoice);
      } 
      else if (twilioMessage.event === 'media') {
        if (this.isGoogleAIConnected && this.googleAISession) {
          this.googleAISession.sendRealtimeInput({
            media: {
              data: twilioMessage.media.payload,
              mimeType: "audio/pcm;rate=8000"
            }
          });
        } else {
          // Queue audio if Google AI is not ready yet
          this.pendingAudioQueue.push(twilioMessage.media.payload);
        }
      } 
      else if (twilioMessage.event === 'stop') {
        console.log('[Durable Object] Received "stop" event. Closing connections.');
        this.onClose();
      }
    } catch (e) {
      console.error("[Durable Object] Error parsing message from Twilio", e);
    }
  }

  async connectToGoogleAI(systemInstruction: string, agentVoice: string) {
    if (!this.env.GEMINI_API_KEY) {
      console.error("[Durable Object] Error: GEMINI_API_KEY is not set.");
      this.ws?.close(1011, "AI service not configured.");
      return;
    }
      
    console.log('[Durable Object] Connecting to Google AI...');
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
          systemInstruction: systemInstruction, 
        },
        callbacks: {
          onopen: () => {
            console.log("[Durable Object] Google AI session opened.");
            this.isGoogleAIConnected = true;
            
            // Send any queued audio
            while (this.pendingAudioQueue.length > 0) {
              const audioPayload = this.pendingAudioQueue.shift();
              if (audioPayload) {
                 this.googleAISession?.sendRealtimeInput({
                    media: { data: audioPayload, mimeType: "audio/pcm;rate=8000" }
                 });
              }
            }
            this.googleAISession?.sendRealtimeInput({ text: "start" });
          },
          onmessage: (message) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && this.ws && this.ws.readyState === WebSocket.OPEN) {
              const twilioResponse = {
                event: "media",
                streamSid: this.twilioStreamSid,
                media: { payload: audioData },
              };
              this.ws.send(JSON.stringify(twilioResponse));
            }
          },
          onerror: (e) => {
            console.error("[Durable Object] Google AI Error:", e);
            this.ws?.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[Durable Object] Google AI session closed.");
            this.onClose();
          },
        },
      })) as MinimalLiveSession;

    } catch (error) {
      console.error("[Durable Object] Failed to connect to Google AI:", error);
      this.ws?.close(1011, "Could not connect to AI service.");
    }
  }

  onClose() {
    console.log("[Durable Object] Closing all connections.");
    this.isGoogleAIConnected = false;
    
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "Closing connection.");
    }
  }
}
PartyKitDurable satisfies Party.Worker;
