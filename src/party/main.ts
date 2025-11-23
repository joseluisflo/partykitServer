
import type * as Party from "partykit/server";
import { GoogleGenAI, type LiveSession } from "@google/genai";

// The LiveSession type from Google's SDK is not fully exported,
// so we define a minimal interface to satisfy TypeScript.
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

export default class CallServer implements Party.Server {
  googleAISession: MinimalLiveSession | null = null;
  
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    console.log(`[PartyKit] Twilio connected: ${conn.id}`);

    const agentId = new URL(ctx.request.url).searchParams.get("agentId");
     if (!agentId) {
      console.error("[PartyKit] Error: agentId is missing from the connection URL.");
      conn.close(1002, "Agent ID is required.");
      return;
    }
    
    // 1. Initialize Google AI
    if (!process.env.GEMINI_API_KEY) {
      console.error("[PartyKit] Error: GEMINI_API_KEY is not set in PartyKit secrets.");
      conn.close(1011, "AI service is not configured.");
      return;
    }
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });

    // 2. Connect to Google AI Live Session
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
            console.log("[PartyKit] Google AI session opened.");
          },
          onmessage: (message) => {
            // Forward AI's audio response back to Twilio
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              const twilioMessage = {
                event: "media",
                streamSid: this.room.id, 
                media: {
                  payload: audioData,
                },
              };
              conn.send(JSON.stringify(twilioMessage));
            }
          },
          onerror: (e) => {
            console.error("[PartyKit] Google AI Error:", e);
            conn.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[PartyKit] Google AI session closed.");
            if (conn.readyState === WebSocket.OPEN) {
              conn.close(1000, "AI session ended.");
            }
          },
        },
      })) as MinimalLiveSession;
    } catch (error) {
      console.error("[PartyKit] Failed to connect to Google AI:", error);
      conn.close(1011, "Could not connect to AI service.");
      return;
    }
    
     // Programmatically start the conversation after setup
    this.googleAISession.sendRealtimeInput({ text: "start" });
  }

  onMessage(message: string, sender: Party.Connection) {
    if (!this.googleAISession) {
      console.warn("[PartyKit] Received message from Twilio, but no active Google AI session.");
      return;
    }
    
    // Forward Twilio's audio to Google AI
    const twilioMessage = JSON.parse(message);
    if (twilioMessage.event === "media") {
      const audioPayload = twilioMessage.media.payload;
       this.googleAISession.sendRealtimeInput({
        media: {
            data: audioPayload,
            mimeType: "audio/pcm;rate=8000" // Twilio uses PCMU (G.711 μ-law) which is 8000 Hz
        }
       });
    } else if (twilioMessage.event === 'stop') {
        console.log('[PartyKit] Twilio stream stopped.');
        this.googleAISession?.close();
    }
  }

  onClose(conn: Party.Connection) {
    console.log(`[PartyKit] Twilio disconnected: ${conn.id}`);
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
  }

  onError(conn: Party.Connection, err: Error) {
    console.error(`[PartyKit] Twilio connection error for ${conn.id}:`, err);
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
  }
}

CallServer satisfies Party.Worker;
