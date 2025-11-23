import type * as Party from "partykit/server";
import { GoogleGenAI, type LiveSession } from "@google/genai";

// --- DEFINICIONES DE TIPOS ---
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

// --- TU LÓGICA ORIGINAL (CallServer) ---
export class CallServer implements Party.Server {
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null; 
  
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    console.log(`[PartyKit Logic] Connecting. URL: ${ctx.request.url}`);
    
    this.ws = conn as unknown as WebSocket; 

    const url = new URL(ctx.request.url);
    
    // ✅ CAMBIO: Intentar obtener agentId de query params O del path
    let agentId = url.searchParams.get("agentId");
    
    // Si no está en query params, intentar extraerlo del path
    // Path format: /party/CALLSID/AGENTID
    if (!agentId) {
      const pathParts = url.pathname.split("/").filter(p => p);
      // pathParts = ["party", "CA...", "agentId"]
      if (pathParts.length >= 3) {
        agentId = pathParts[2];
        console.log(`[PartyKit Logic] AgentID extracted from path: ${agentId}`);
      }
    }

    if (!agentId) {
      console.error("[PartyKit Logic] FATAL: agentId is missing/null.");
      console.error(`[PartyKit Logic] Full URL: ${ctx.request.url}`);
      console.error(`[PartyKit Logic] Path: ${url.pathname}`);
      console.error(`[PartyKit Logic] Query params: ${url.search}`);
      conn.close(1002, "Agent ID is required.");
      return;
    }
    
    console.log(`[PartyKit Logic] AgentID found: ${agentId}. Proceeding with Google AI.`);

    const apiKey = (this.room.env as any).GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[PartyKit Logic] Error: GEMINI_API_KEY is not set.");
      conn.close(1011, "AI service is not configured.");
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
              if (this.ws && this.ws.readyState === 1) { 
                  conn.send(JSON.stringify(twilioMessage));
              }
            }
          },
          onerror: (e) => {
            console.error("[PartyKit Logic] Google AI Error:", e);
            conn.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[PartyKit Logic] Google AI session closed.");
            conn.close(1000, "AI session ended.");
          },
        },
      })) as MinimalLiveSession;
    } catch (error) {
      console.error("[PartyKit Logic] Failed to connect to Google AI:", error);
      conn.close(1011, "Could not connect to AI service.");
      return;
    }
  }

  onMessage(message: string, sender: Party.Connection) {
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
            this.googleAISession?.close();
        }
    } catch (e) {
        console.error("Error parsing message", e);
    }
  }
}

// --- EL ADAPTADOR BLINDADO ---
export class PartyKitDurable implements DurableObject {
  constructor(private state: DurableObjectState, private env: any) {}

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      
      server.accept();
      
      const urlObj = new URL(request.url);
      const pathSegments = urlObj.pathname.split("/").filter(p => p);
      
      // pathSegments puede ser: ["party", "CA...", "agentId"] o ["party", "CA..."]
      const callSid = pathSegments.find(s => s.startsWith("CA")) || pathSegments[1] || "unknown";

      const fakeRoom: Party.Room = {
        id: callSid,
        internalID: this.state.id.toString(),
        env: this.env, 
        storage: this.state.storage,
        parties: {} as any,
        broadcast: () => [],
        getConnection: () => undefined,
        getConnections: () => []
      } as any;

      const partyServer = new CallServer(fakeRoom);
      const conn = server as unknown as Party.Connection;
      conn.id = "twilio-conn-" + callSid;
      
      const ctx = { request } as Party.ConnectionContext;
      
      await partyServer.onConnect(conn, ctx);

      server.addEventListener("message", (event) => {
        partyServer.onMessage(event.data as string, conn);
      });

      server.addEventListener("close", () => {
        if ((partyServer as any).onClose) (partyServer as any).onClose(conn);
      });

      server.addEventListener("error", (err) => {
        if ((partyServer as any).onError) (partyServer as any).onError(conn, err as Error);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("PartyKit Adapter Active", { status: 200 });
  }
}

// --- EL RECEPCIONISTA (ROUTER) CORREGIDO ---
export default {
  async fetch(request: Request, env: any) {
    const url = new URL(request.url);
    
    const pathParts = url.pathname.split("/").filter(p => p);
    
    // pathParts puede ser: ["party", "CA...", "agentId"] o ["party", "CA..."]
    const roomName = pathParts.find(part => part.startsWith("CA")) || "default-room";

    console.log(`[Router] Path: ${url.pathname}, RoomName: ${roomName}`);

    const id = env.PARTYKIT_DURABLE.idFromName(roomName);
    const stub = env.PARTYKIT_DURABLE.get(id);

    return stub.fetch(request);
  }
};