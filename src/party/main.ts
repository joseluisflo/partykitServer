
import type * as Party from "partykit/server";
import { GoogleGenAI, type LiveSession, Modality } from "@google/genai";
import * as admin from 'firebase-admin';

// Define minimal interfaces to satisfy TypeScript
interface Agent {
  instructions?: string;
  inCallWelcomeMessage?: string;
  agentVoice?: string;
  textSources?: { title: string; content: string }[];
  fileSources?: { name: string; extractedText?: string }[];
}

interface MinimalLiveSession extends LiveSession {
  close(): void;
  sendRealtimeInput(request: { media: { data: string; mimeType: string; } } | { text: string }): void;
}

// Helper to initialize Firebase Admin
function initializeFirebaseAdmin(serviceAccount: admin.ServiceAccount) {
  if (admin.apps.length > 0) {
    return admin.app();
  }
  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// Function to fetch agent configuration from Firestore
async function getAgentConfig(firestore: admin.firestore.Firestore, agentId: string): Promise<Agent | null> {
    const agentQuerySnapshot = await firestore.collectionGroup('agents').where('__name__', '==', agentId).limit(1).get();

    if (agentQuerySnapshot.empty) {
        console.error(`[PartyKit] Agent with ID ${agentId} not found.`);
        return null;
    }
    const agentDoc = agentQuerySnapshot.docs[0];
    const agent = agentDoc.data() as Agent;
    const agentRef = agentDoc.ref;

    const textsSnapshot = await agentRef.collection('texts').get();
    const filesSnapshot = await agentRef.collection('files').get();

    agent.textSources = textsSnapshot.docs.map(doc => doc.data() as { title: string; content: string });
    agent.fileSources = filesSnapshot.docs.map(doc => doc.data() as { name: string; extractedText?: string });

    return agent;
}

export default class PartyKitDurable implements Party.Server {
  googleAISession: MinimalLiveSession | null = null;
  ws: WebSocket | null = null;

  constructor(readonly room: Party.Room) {}

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    this.ws = conn as WebSocket;
    console.log(`[PartyKit] Connection received for room: ${this.room.id}`);

    const url = new URL(ctx.request.url);
    const agentId = url.searchParams.get("agentId");

    if (!agentId) {
      console.error("[PartyKit] Error: agentId is missing from query parameters.");
      this.ws.close(1002, "Agent ID is required.");
      return;
    }
    console.log(`[PartyKit] agentId found: ${agentId}`);

    // --- Firebase & Agent Config ---
    let agentConfig: Agent | null = null;
    try {
        const serviceAccountJson = JSON.parse(this.room.env.FIREBASE_SERVICE_ACCOUNT as string);
        const firestore = initializeFirebaseAdmin(serviceAccountJson).firestore();
        agentConfig = await getAgentConfig(firestore, agentId);
    } catch (e) {
        console.error('[PartyKit] Firebase initialization or data fetch failed:', e);
        this.ws.close(1011, 'Failed to retrieve agent configuration.');
        return;
    }

    if (!agentConfig) {
        this.ws.close(1011, `Agent configuration for ${agentId} not found.`);
        return;
    }
    
    const knowledge = [
        ...(agentConfig.textSources || []).map(t => `Title: ${t.title}\\nContent: ${t.content}`),
        ...(agentConfig.fileSources || []).map(f => `File: ${f.name}\\nContent: ${f.extractedText || ''}`)
    ].join('\\n\\n---\\n\\n');

    const systemInstruction = `
You are a voice AI. Your goal is to be as responsive as possible. Your first response to a user MUST be an immediate, short acknowledgment like "Of course, let me check that" or "Sure, one moment". Then, you will provide the full answer.
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

    // --- Google AI Connection ---
    if (!this.room.env.GEMINI_API_KEY) {
      console.error("[PartyKit] Error: GEMINI_API_KEY is not set.");
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
              voiceConfig: { prebuiltVoiceConfig: { voiceName: agentConfig.agentVoice || 'Zephyr' } },
          },
          systemInstruction: systemInstruction,
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
            this.onClose();
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
            console.log('[PartyKit] Twilio stream stop message received.');
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
     if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
        this.ws.close(1000, "Closing connection.");
    }
  }
}
