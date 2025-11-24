import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";
import { downsampleBuffer, linear16ToMuLaw } from "../audioUtils";
import { Buffer } from "node:buffer";

interface Env {
  GEMINI_API_KEY: string;
}

interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

export class PartyKitDurable implements DurableObject {
  state: DurableObjectState;
  env: Env;
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;
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
    return new Response(null, { status: 101, webSocket: client });
  }
  
  handleConnection(webSocket: WebSocket) {
    webSocket.accept();
    this.ws = webSocket;
    this.ws.addEventListener("message", (event) => this.onMessage(event.data as string));
    this.ws.addEventListener("close", () => this.onClose());
    this.ws.addEventListener("error", (err) => {
        console.error("[WS Error]:", err);
        this.onClose();
    });
  }

  async onMessage(message: string) {
    try {
      const twilioMessage = JSON.parse(message);

      if (twilioMessage.event === "start") {
        console.log("[START] StreamSid:", twilioMessage.start.streamSid);
        this.twilioStreamSid = twilioMessage.start.streamSid;
        
        const params = twilioMessage.start.customParameters || {};
        console.log("[START] Custom Parameters:", Object.keys(params));
        
        const systemInstruction = params.systemInstruction 
            ? Buffer.from(params.systemInstruction, 'base64').toString('utf-8') 
            : "You are a helpful voice assistant.";
        const agentVoice = params.agentVoice || 'Zephyr';
        
        console.log("[START] Voice:", agentVoice);
        console.log("[START] Instruction length:", systemInstruction.length);
        
        await this.connectToGoogleAI(systemInstruction, agentVoice);
      } 
      else if (twilioMessage.event === 'media') {
        if (this.isGoogleAIConnected && this.googleAISession) {
            this.sendAudioToGoogle(twilioMessage.media.payload);
        } else {
            this.pendingAudioQueue.push(twilioMessage.media.payload);
        }
      } 
      else if (twilioMessage.event === 'stop') {
        console.log('[STOP] Call ended.');
        this.onClose();
      }
    } catch (e) {
      console.error("[ERROR] Processing message:", e);
    }
  }

  // SOLUCIÓN: Enviar Mu-Law directamente a Google
  sendAudioToGoogle(base64Payload: string) {
    try {
        // Google AI acepta Mu-Law directamente con el MIME type correcto
        this.googleAISession?.sendRealtimeInput({
            media: {
              data: base64Payload, // Enviar directamente el base64 de Twilio
              mimeType: "audio/mulaw;rate=8000" // ✅ CORRECTO: Mu-Law 8kHz
            }
        });
    } catch (err) {
        console.error("[ERROR] Sending audio to Google:", err);
    }
  }

  async connectToGoogleAI(systemInstruction: string, agentVoice: string) {
    if (!this.env.GEMINI_API_KEY) {
      console.error("[ERROR] Missing GEMINI_API_KEY");
      return;
    }
      
    console.log('[GOOGLE] Connecting to AI...');
    const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

    try {
      this.googleAISession = (await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: agentVoice } },
          },
          systemInstruction: systemInstruction, 
        },
        callbacks: {
          onopen: () => {
            console.log("[GOOGLE] ✅ Connected!");
            this.isGoogleAIConnected = true;
            
            // Procesar cola pendiente
            console.log(`[GOOGLE] Processing ${this.pendingAudioQueue.length} queued audio chunks`);
            while (this.pendingAudioQueue.length > 0) {
              const payload = this.pendingAudioQueue.shift();
              if (payload) this.sendAudioToGoogle(payload);
            }
          },
          onmessage: (message) => {
            // Extraer audio de la respuesta
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            
            if (audioData) {
                console.log(`[GOOGLE→TWILIO] Audio chunk: ${audioData.length} chars`);
                
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    try {
                        // Google devuelve PCM 24kHz, necesitamos Mu-Law 8kHz para Twilio
                        const pcm24kBuffer = Buffer.from(audioData, 'base64');
                        const pcm8kBuffer = downsampleBuffer(pcm24kBuffer, 24000, 8000);
                        const muLawBuffer = linear16ToMuLaw(pcm8kBuffer);
                        const muLawBase64 = muLawBuffer.toString('base64');

                        this.ws.send(JSON.stringify({
                            event: "media",
                            streamSid: this.twilioStreamSid,
                            media: { payload: muLawBase64 },
                        }));
                        
                        console.log(`[TWILIO] Sent ${muLawBase64.length} chars`);
                    } catch (err) {
                        console.error("[ERROR] Processing Google audio:", err);
                    }
                }
            } else if (message.serverContent?.turnComplete) {
                console.log("[GOOGLE] Turn complete");
            } else {
                // Mensaje sin audio (probablemente metadatos)
                const msgPreview = JSON.stringify(message).substring(0, 150);
                console.log("[GOOGLE] Non-audio message:", msgPreview);
            }
          },
          onerror: (e) => console.error("[GOOGLE] Error:", e),
          onclose: () => {
            console.log("[GOOGLE] Connection closed");
            this.onClose();
          },
        },
      })) as MinimalLiveSession;

    } catch (error) {
      console.error("[ERROR] Failed to connect to Google:", error);
    }
  }

  onClose() {
    console.log("[CLEANUP] Closing connections...");
    this.isGoogleAIConnected = false;
    this.googleAISession?.close();
    this.googleAISession = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
  }
}

// @ts-ignore
PartyKitDurable satisfies Party.Worker;