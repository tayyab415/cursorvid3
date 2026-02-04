
import { Clip } from '../../types';
import { getAiClient } from '../gemini';
import { rangeToGeminiParts } from '../geminiAdapter';
import { Type } from '@google/genai';

export interface VideoAnalysis {
  thought: string;
  pacing: { rhythm: string, deadMoments: number[] };
  visual: { quality: string, issues: string[] };
  audio: { hasSpeech: boolean, clarity: string };
  editingNeeds: string[];
}

export class EyesAgent {
  async analyze(clips: Clip[], mediaRefs: any): Promise<VideoAnalysis> {
    const ai = getAiClient();
    
    // We analyze the first 20 seconds or the whole video if shorter for efficiency in this demo
    const duration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
    const analysisRange = { start: 0, end: Math.min(duration, 20), tracks: [] as any };
    
    const mediaParts = await rangeToGeminiParts(analysisRange, clips, mediaRefs);

    const prompt = `
    ROLE: You are the EYES of a video editor.
    TASK: Watch the provided video frames/audio and analyze the content.
    
    OUTPUT JSON SCHEMA:
    {
      "thought": "Brief first-person thought about what you see (e.g., 'I see a talking head video but the start is silent.')",
      "pacing": { "rhythm": "slow|fast|inconsistent", "deadMoments": [timestamp numbers] },
      "visual": { "quality": "string", "issues": ["shaky", "dark", "static"] },
      "audio": { "hasSpeech": boolean, "clarity": "string" },
      "editingNeeds": ["string (e.g. 'Trim start', 'Add music')"]
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
                role: 'user',
                parts: [
                    ...mediaParts,
                    { text: prompt }
                ]
            },
            config: { 
                responseMimeType: 'application/json',
                systemInstruction: "You are a precise video analysis engine."
            }
        });

        const text = response.text || "{}";
        return JSON.parse(text);
    } catch (e) {
        console.error("Eyes Agent Error", e);
        return {
            thought: "I couldn't see the video clearly due to a connection error.",
            pacing: { rhythm: "unknown", deadMoments: [] },
            visual: { quality: "unknown", issues: [] },
            audio: { hasSpeech: false, clarity: "unknown" },
            editingNeeds: []
        };
    }
  }
}
