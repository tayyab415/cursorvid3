
import { Clip } from '../../types';
import { getAiClient } from '../gemini';
import { rangeToGeminiParts, storyboardToGeminiParts } from '../geminiAdapter';
import { Type } from '@google/genai';
import { AGENT_POLICY } from './agentPolicy';

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
    
    // DECISION LOGIC: 
    // If the timeline is messy (overlapping clips at 0) or contains many clips, 
    // we should do a "Survey" to help the Brain arrange them.
    // For this demo, we'll do a survey if we see > 2 clips.
    const hasOverlaps = clips.some((a, i) => clips.some((b, j) => i !== j && a.trackId === b.trackId && a.startTime < b.startTime + b.duration && b.startTime < a.startTime + a.duration));
    const duration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
    const isSurveyMode = clips.length > 4 || hasOverlaps || duration > 45;

    let mediaParts: any[] = [];
    let instructions = "";

    if (isSurveyMode) {
        mediaParts = await storyboardToGeminiParts(clips);
        instructions = `
        MODE: INVENTORY SURVEY.
        TASK: Look at the individual clips provided in the "Storyboard". 
        Identify what each clip is (Intros, Interviews, B-roll, Outros).
        
        OUTPUT JSON:
        - "thought": Describe the inventory found.
        - "editingNeeds": Suggest an order. E.g. "Move the Intro clip to start", "Place Interview after Intro".
        `;
    } else {
        const analysisRange = { start: 0, end: Math.min(duration, 30), tracks: [] as any };
        mediaParts = await rangeToGeminiParts(analysisRange, clips, mediaRefs);
        instructions = `
        MODE: TIMELINE PLAYBACK.
        TASK: Watch the composed video. Analyze Pacing, Visual Quality, and Audio.
        `;
    }

    const prompt = `
    ROLE: You are the EYES of a video editor.
    ${instructions}
    
    OUTPUT JSON SCHEMA:
    {
      "thought": "Brief first-person thought about what you see.",
      "pacing": { "rhythm": "slow|fast|inconsistent", "deadMoments": [timestamp numbers] },
      "visual": { "quality": "string", "issues": ["shaky", "dark", "static"] },
      "audio": { "hasSpeech": boolean, "clarity": "string" },
      "editingNeeds": ["string"]
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: AGENT_POLICY.defaults.models.eyes,
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
