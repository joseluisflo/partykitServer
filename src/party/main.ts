import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";
import { downsampleBuffer, linear16ToMuLaw } from "../audioUtils";
// 1. IMPORTANTE: Importar Buffer para asegurar compatibilidad en Cloudflare
import { Buffer } from "node:buffer"; 

interface Env {
  GEMINI_API_KEY: string;
}

interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

// --- FUNCIÓN AUXILIAR FALTANTE: DECODIFICAR TWILIO (MuLaw -> Linear16) ---
// Google necesita PCM 16-bit, no Mu-Law.
function muLawToLinear16(muLawBuffer: Buffer): Buffer {
  const muLawToLinear16Table = new Int16Array(256);
  // Generar tabla de búsqueda (estándar G.711)
  for (let i = 0; i < 256; i++) {
    let sample = ~i;
    let sign = (sample & 0x80) ? -1 : 1;
    let exponent = (sample >> 4) & 0x07;
    let mantissa = sample & 0x0F;
    let linear = (mantissa << 1) + 33;
    linear <<= ((exponent + 2));
    linear -= 33;
    muLawToLinear16Table[i] = sign * linear;
  }
  
  const output = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i++) {
    output[i] = muLawToLinear16Table[muLawBuffer[i]];
  }
  return Buffer.from(output.buffer);
}

export class PartyKitDurable implements DurableObject {
  state: DurableObjectState;
  env: Env;
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;
  isGoogleAIConnected = false;
  pendingAudioQueue: string[] = []; // Guardamos el base64 original
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
        console.error("WS Error:", err);
        this.onClose();
    });
  }

  async onMessage(message: string) {
    try {
      const twilioMessage = JSON.parse(message);

      if (twilioMessage.event === "start") {
        console.log("[Durable Object] Call started. StreamSid:", twilioMessage.start.streamSid);
        this.twilioStreamSid = twilioMessage.start.streamSid;
        
        const params = twilioMessage.start.customParameters || {};
        const systemInstruction = params.systemInstruction 
            ? Buffer.from(params.systemInstruction, 'base64').toString('utf-8') 
            : "You are a helpful assistant.";
        const agentVoice = params.agentVoice || 'Zephyr';
        
        await this.connectToGoogleAI(systemInstruction, agentVoice);
      } 
      else if (twilioMessage.event === 'media') {
        // CORRECCIÓN CRÍTICA #1: Convertir audio antes de enviar a Google
        if (this.isGoogleAIConnected && this.googleAISession) {
            this.sendAudioToGoogle(twilioMessage.media.payload);
        } else {
            this.pendingAudioQueue.push(twilioMessage.media.payload);
        }
      } 
      else if (twilioMessage.event === 'stop') {
        console.log('[Durable Object] Call ended by user.');
        this.onClose();
      }
    } catch (e) {
      console.error("Error processing Twilio message:", e);
    }
  }

  // Nueva función para manejar el envío y conversión correcto hacia Google
  sendAudioToGoogle(base64Payload: string) {
    try {
        // 1. Decodificar Base64 de Twilio
        const muLawBuffer = Buffer.from(base64Payload, 'base64');
        // 2. Convertir Mu-Law a Linear PCM 16-bit (Lo que Google entiende)
        const pcmBuffer = muLawToLinear16(muLawBuffer);
        // 3. Re-codificar a Base64
        const pcmBase64 = pcmBuffer.toString('base64');

        this.googleAISession?.sendRealtimeInput({
            media: {
              data: pcmBase64,
              // Nota: Google prefiere 16kHz o 24kHz, pero suele aceptar 8000 si es PCM lineal
              mimeType: "audio/pcm;rate=8000" 
            }
        });
    } catch (err) {
        console.error("Error converting audio for Google:", err);
    }
  }

  async connectToGoogleAI(systemInstruction: string, agentVoice: string) {
    if (!this.env.GEMINI_API_KEY) return;
      
    console.log('[Durable Object] Connecting to Google AI...');
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
            console.log("[Durable Object] Google AI Connected.");
            this.isGoogleAIConnected = true;
            
            // Procesar cola pendiente
            while (this.pendingAudioQueue.length > 0) {
              const payload = this.pendingAudioQueue.shift();
              if (payload) this.sendAudioToGoogle(payload);
            }
            
            // Enviar saludo inicial para forzar a la IA a hablar
            // Usamos un mensaje de sistema/usuario para "activar" la voz
            this.googleAISession?.sendRealtimeInput({ text: "Hello, please introduce yourself briefly." });
          },
          onmessage: (message) => {
            // CORRECCIÓN #2: Logs para ver si Google responde
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            
            if (audioData) {
                // console.log(`[Google] Audio chunk received: ${audioData.length} bytes`); // Descomentar para debug
                
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    // Procesamiento de audio
                    const pcm16Data = Buffer.from(audioData, 'base64');
                    // Asegurarse de que downsampleBuffer maneje bien los datos
                    // (Asumiendo que tus utils funcionan bien con Buffer)
                    const pcm8kData = downsampleBuffer(pcm16Data, 24000, 8000);
                    const muLawData = linear16ToMuLaw(pcm8kData);
                    const muLawBase64 = Buffer.from(muLawData).toString('base64');

                    this.ws.send(JSON.stringify({
                        event: "media",
                        streamSid: this.twilioStreamSid,
                        media: { payload: muLawBase64 },
                    }));
                }
            } else {
                // Log para ver si Google manda texto en vez de audio
                // console.log("Google msg (no audio):", JSON.stringify(message).substring(0, 100));
            }
          },
          onerror: (e) => console.error("Google AI Error:", e),
          onclose: () => this.onClose(),
        },
      })) as MinimalLiveSession;

    } catch (error) {
      console.error("Failed to connect to Google:", error);
    }
  }

  onClose() {
    this.isGoogleAIConnected = false;
    this.googleAISession?.close();
    this.googleAISession = null;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
  }
}
PartyKitDurable satisfies Party.Worker;