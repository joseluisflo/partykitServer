import type * as Party from "partykit/server";
import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";
import * as admin from 'firebase-admin';

// --- INTERFACES ---
interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

interface Agent {
    instructions?: string;
    inCallWelcomeMessage?: string;
    agentVoice?: string;
    textSources?: { title: string; content: string }[];
    fileSources?: { name: string; extractedText?: string }[];
}

// --- LÓGICA DEL SERVIDOR ---
export class PartyKitDurable implements Party.Server {
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;
  firebaseInitialized = false;

  constructor(readonly room: Party.Room) {
    // Inicializar Firebase tan pronto como se crea el objeto
    this.maybeInitializeFirebase();
  }

  // Inicializa Firebase Admin SDK si no lo ha hecho ya
  maybeInitializeFirebase() {
    if (admin.apps.length === 0) {
      try {
        const serviceAccount = JSON.parse(this.room.env.FIREBASE_SERVICE_ACCOUNT as string);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        this.firebaseInitialized = true;
        console.log("[Firebase] Admin SDK initialized successfully.");
      } catch (e) {
        console.error("[Firebase] Failed to initialize Admin SDK:", e);
        this.firebaseInitialized = false;
      }
    } else {
        this.firebaseInitialized = true;
    }
  }
  
  // Obtiene los datos del agente desde Firestore
  async getAgentConfig(agentId: string): Promise<Agent | null> {
    if (!this.firebaseInitialized) {
        console.error("[Firestore] Firebase not initialized, cannot fetch agent config.");
        return null;
    }
    try {
        // Firestore no es compatible con collectionGroup en el SDK de Admin, así que buscamos la ruta completa.
        // Esto asume una estructura de ruta predecible.
        // Una solución más robusta podría implicar una colección raíz de agentes si los usuarios se vuelven muy numerosos.
        const firestore = admin.firestore();
        const usersSnapshot = await firestore.collection('users').get();
        for (const userDoc of usersSnapshot.docs) {
            const agentRef = firestore.collection('users').doc(userDoc.id).collection('agents').doc(agentId);
            const agentDoc = await agentRef.get();
            if (agentDoc.exists) {
                console.log(`[Firestore] Found agent ${agentId} for user ${userDoc.id}`);
                return agentDoc.data() as Agent;
            }
        }
        console.warn(`[Firestore] Agent with ID ${agentId} not found across all users.`);
        return null;
    } catch (error) {
        console.error(`[Firestore] Error fetching agent config for ${agentId}:`, error);
        return null;
    }
  }


  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    this.ws = conn;
    console.log(`[PartyKit] Twilio connected: ${conn.id}`);

    const url = new URL(ctx.request.url);
    const agentId = url.pathname.split('/')[3] || url.searchParams.get("agentId");

    if (!agentId) {
      console.error("[PartyKit] Error: agentId is missing from the URL.");
      conn.close(1002, "Agent ID is required.");
      return;
    }
    console.log(`[PartyKit] AgentID identified: ${agentId}`);

    const agentConfig = await this.getAgentConfig(agentId);
    if (!agentConfig) {
      conn.close(1011, `Agent configuration for ${agentId} not found.`);
      return;
    }

    const ai = new GoogleGenAI({ apiKey: this.room.env.GEMINI_API_KEY as string });

    const knowledge = [
      ...(agentConfig.textSources || []).map(t => `Title: ${t.title}\nContent: ${t.content}`),
      ...(agentConfig.fileSources || []).map(f => `File: ${f.name}\nContent: ${f.extractedText || ''}`)
    ].join('\n\n---\n\n');

    const systemInstruction = `
      You are a voice AI. Your goal is to be as responsive as possible. Your first response to a user MUST be an immediate, short acknowledgment. Then, you will provide the full answer.
      This is a real-time conversation. Keep all your answers concise and to the point. Prioritize speed. Do not use filler phrases.
      ${agentConfig.inCallWelcomeMessage ? `Your very first response in this conversation must be: "${agentConfig.inCallWelcomeMessage}"` : ''}

      Your instructions and persona are defined below.

      ### Instructions & Persona
      ${agentConfig.instructions || 'You are a helpful assistant.'}
              
      ### Knowledge Base
      Use the following information to answer questions. This is your primary source of truth.
      ---
      ${knowledge}
      ---
    `;

    try {
      this.googleAISession = (await ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: { interruptions: true },
          outputAudioTranscription: {},
          speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: agentConfig.agentVoice || 'Zephyr' } },
          },
          systemInstruction,
        },
        callbacks: {
          onopen: () => {
            console.log("[PartyKit] Google AI session opened.");
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
            console.error("[PartyKit] Google AI Error:", e);
            this.ws?.close(1011, "An AI service error occurred.");
          },
          onclose: () => {
            console.log("[PartyKit] Google AI session closed.");
            if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
                this.ws.close(1000, "AI session ended.");
            }
          },
        },
      })) as MinimalLiveSession;
    } catch (error) {
      console.error("[PartyKit] Failed to connect to Google AI:", error);
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
            console.log('[PartyKit] Twilio stream stopped message received.');
            this.onClose();
        }
    } catch (e) {
        console.error("[PartyKit] Error parsing message from Twilio", e);
    }
  }

  onClose() {
    console.log("[PartyKit] Connection closing.");
    if (this.googleAISession) {
      this.googleAISession.close();
      this.googleAISession = null;
    }
  }
}

// Punto de entrada para el router de PartyKit
export default class MainServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const pathParts = url.pathname.split("/").filter(p => p);
    
    // El nombre de la "habitación" (Durable Object) es el Call SID de Twilio
    const roomName = pathParts.find(part => part.startsWith("CA"));
    
    if (!roomName) {
      console.error("[Router] Could not find Call SID in path. Closing connection.");
      conn.close(1002, "Invalid URL format. Call SID is missing.");
      return;
    }
    console.log(`[Router] Path: ${url.pathname}, RoomName: ${roomName}`);
    
    const durableObjectId = this.room.context.parties.main.idFromName(roomName);
    const durableObjectStub = this.room.context.parties.main.get(durableObjectId);
    
    // Reenvía la conexión al Durable Object
    return durableObjectStub.fetch(ctx.request);
  }
}

MainServer satisfies Party.Worker;
