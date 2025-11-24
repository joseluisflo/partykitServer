
import type * as Party from "partykit/server";
import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";

// Define minimal interfaces to satisfy TypeScript
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

export default class PartyKitDurable implements Party.Server {
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;

  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    this.ws = conn as WebSocket;
    console.log(`[PartyKit Worker] Connection received for room: ${this.room.id}`);

    const url = new URL(ctx.request.url);
    const systemInstruction = url.searchParams.get("systemInstruction");
    const agentVoice = url.searchParams.get("agentVoice") || 'Zephyr';

    if (!systemInstruction) {
      console.error("[PartyKit Worker] Error: systemInstruction is missing from query parameters.");
      this.ws.close(1002, "Agent instruction is required.");
      return;
    }

    if (!this.room.env.GEMINI_API_KEY) {
      console.error("[PartyKit Worker] Error: GEMINI_API_KEY is not set.");
      this.ws.close(1011, "AI service is not configured.");
      return;
    }

    const ai = new GoogleGenAI({ apiKey: this.room.env.GEMINI_API_KEY as string });

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
            console.log("[PartyKit Worker] Google AI session opened.");
            // Programmatically start the conversation
            this.googleAISession?.sendRealtimeInput({ text: "start" });
          },
          onmessage: (message) => {
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && this.ws) {
              const twilioMessage = {
                event: "media",
                streamSid: this.room.id,
                media: { payload: audioData },
              };
              this.ws.send(JSON.stringify(twilioMessage));
            }
          },
          onerror: (e) => {
            console.error("[PartyKit Worker] Google AI Error:", e);
            this.ws?.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[PartyKit Worker] Google AI session closed.");
            this.onClose();
          },
        },
      })) as MinimalLiveSession;
    } catch (error) {
      console.error("[PartyKit Worker] Failed to connect to Google AI:", error);
      this.ws.close(1011, "Could not connect to AI service.");
    }
  }

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
            console.log('[PartyKit Worker] Twilio stream stop message received.');
            this.onClose();
        }
    } catch (e) {
        console.error("[PartyKit Worker] Error parsing message from Twilio", e);
    }
  }

  onClose() {
    console.log("[PartyKit Worker] Connection closing.");
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
     if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
        this.ws.close(1000, "Closing connection.");
    }
  }
}

// This export is required for Wrangler to correctly identify the Durable Object class.
PartyKitDurable satisfies Party.Worker;

export { PartyKitDurable };
