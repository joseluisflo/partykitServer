import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";
import { downsampleBuffer, linear16ToMuLaw } from "../audioUtils";
import { Buffer } from "node:buffer";

interface Env {
  GEMINI_API_KEY: string;
}

interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { audio: { data: string; mimeType: string; } } | { text: string }): void;
}

// Tabla de conversión Mu-Law a Linear PCM16
function muLawToLinear16(muLawBuffer: Buffer): Buffer {
  const muLawToLinear16Table = new Int16Array(256);
  
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

// Upsample de 8kHz a 16kHz
function upsampleTo16k(pcm8k: Buffer): Buffer {
  const samples8k = new Int16Array(pcm8k.buffer, pcm8k.byteOffset, pcm8k.length / 2);
  const samples16k = new Int16Array(samples8k.length * 2);
  
  for (let i = 0; i < samples8k.length; i++) {
    samples16k[i * 2] = samples8k[i];
    samples16k[i * 2 + 1] = samples8k[i];
  }
  
  return Buffer.from(samples16k.buffer);
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
        // TEMPORAL: Deshabilitar envío de audio del usuario
        console.log("[TWILIO] Skipping audio chunk (test mode)");
        // if (this.isGoogleAIConnected && this.googleAISession) {
        //     this.sendAudioToGoogle(twilioMessage.media.payload);
        // } else {
        //     this.pendingAudioQueue.push(twilioMessage.media.payload);
        // }
      } 
      else if (twilioMessage.event === 'stop') {
        console.log('[STOP] Call ended.');
        this.onClose();
      }
    } catch (e) {
      console.error("[ERROR] Processing message:", e);
    }
  }

  // CORRECCIÓN CRÍTICA: Usar "audio" no "media"
  sendAudioToGoogle(base64Payload: string) {
    try {
        const muLawBuffer = Buffer.from(base64Payload, 'base64');
        const pcm8kBuffer = muLawToLinear16(muLawBuffer);
        const pcm16kBuffer = upsampleTo16k(pcm8kBuffer);
        const pcmBase64 = pcm16kBuffer.toString('base64');
        
        // ✅ CORRECCIÓN: "audio" no "media"
        this.googleAISession?.sendRealtimeInput({
            audio: {  // ← Cambio crítico aquí
              data: pcmBase64,
              mimeType: "audio/pcm;rate=16000"
            }
        });
    } catch (err) {
        console.error("[ERROR] Converting audio:", err);
    }
  }

  async connectToGoogleAI(systemInstruction: string, agentVoice: string) {
    if (!this.env.GEMINI_API_KEY) {
      console.error("[ERROR] Missing GEMINI_API_KEY");
      return;
    }
      
    console.log('[GOOGLE] Connecting to AI...');
    console.log('[GOOGLE] API Key present:', this.env.GEMINI_API_KEY ? 'YES' : 'NO');
    console.log('[GOOGLE] Model: gemini-2.5-flash-native-audio-preview-09-2025');
    console.log('[GOOGLE] Voice:', agentVoice);
    
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
            
            // PRUEBA: Solo texto, SIN audio del usuario
            console.log("[GOOGLE] Sending welcome message (TEXT ONLY TEST)...");
            this.googleAISession?.sendRealtimeInput({ 
              text: "Say hello in audio format. Just say 'Hello, how can I help you today?' and nothing else." 
            });
            
            // TEMPORAL: NO procesar audio del usuario
            console.log(`[GOOGLE] Skipping ${this.pendingAudioQueue.length} audio chunks for test`);
            // while (this.pendingAudioQueue.length > 0) {
            //   const payload = this.pendingAudioQueue.shift();
            //   if (payload) this.sendAudioToGoogle(payload);
            // }
          },
          onmessage: (message) => {
            // LOGGING EXHAUSTIVO
            console.log("[GOOGLE] 🔔 Message received!");
            console.log("[GOOGLE] Message type:", typeof message);
            console.log("[GOOGLE] Message keys:", Object.keys(message));
            
            // Intentar stringify para ver la estructura completa
            try {
              const preview = JSON.stringify(message, null, 2).substring(0, 500);
              console.log("[GOOGLE] Message preview:", preview);
            } catch (e) {
              console.log("[GOOGLE] Could not stringify message");
            }
            
            // Opción 1: Audio directo en message.data
            if (message.data) {
                console.log(`[GOOGLE→TWILIO] Audio in message.data: ${message.data.length} chars`);
                this.sendAudioToTwilio(message.data);
            }
            
            // Opción 2: Audio en la estructura serverContent
            else if (message.serverContent?.modelTurn?.parts) {
                console.log("[GOOGLE] Found serverContent.modelTurn.parts");
                for (const part of message.serverContent.modelTurn.parts) {
                    if (part.inlineData?.data) {
                        console.log(`[GOOGLE→TWILIO] Audio in parts: ${part.inlineData.data.length} chars`);
                        this.sendAudioToTwilio(part.inlineData.data);
                    }
                }
            }
            
            // Opción 3: turnComplete
            else if (message.serverContent?.turnComplete) {
                console.log("[GOOGLE] Turn complete");
            }
            
            // Si llegamos aquí, el mensaje no tiene audio
            else {
                console.log("[GOOGLE] ⚠️ Message received but no audio data found");
            }
          },
          onerror: (e) => {
            console.error("[GOOGLE] Error:", e);
            if (e instanceof Error) {
              console.error("[GOOGLE] Error details:", e.message);
            }
          },
          onclose: () => {
            console.log("[GOOGLE] Connection closed");
            this.onClose();
          },
        },
      })) as MinimalLiveSession;

    } catch (error) {
      console.error("[ERROR] Failed to connect to Google:", error);
      if (error instanceof Error) {
        console.error("[ERROR] Details:", error.message, error.stack);
      }
    }
  }

  // Nueva función separada para enviar audio a Twilio
  sendAudioToTwilio(audioData: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[TWILIO] WebSocket not ready");
      return;
    }

    try {
        // Google devuelve PCM 24kHz, convertir a Mu-Law 8kHz
        const pcm24kBuffer = Buffer.from(audioData, 'base64');
        const pcm8kBuffer = downsampleBuffer(pcm24kBuffer, 24000, 8000);
        const muLawBuffer = linear16ToMuLaw(pcm8kBuffer);
        const muLawBase64 = muLawBuffer.toString('base64');

        this.ws.send(JSON.stringify({
            event: "media",
            streamSid: this.twilioStreamSid,
            media: { payload: muLawBase64 },
        }));
        
        console.log(`[TWILIO] ✅ Sent ${muLawBase64.length} chars`);
    } catch (err) {
        console.error("[ERROR] Processing Google audio:", err);
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