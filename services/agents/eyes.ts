
import { AgentContext } from '../../types';
import { getAiClient } from '../gemini';
import { rangeToGeminiParts, storyboardToGeminiParts } from '../geminiAdapter';
import { Type } from '@google/genai';

export interface VideoAnalysis {
  thought: string;
  pacing: { rhythm: string, deadMoments: number[] };
  visual: { quality: string, issues: string[] };
  audio: { hasSpeech: boolean, clarity: string };
  editingNeeds: string[];
}

export class EyesAgent {
  async analyze(context: AgentContext, mediaRefs: any): Promise<VideoAnalysis> {
    const ai = getAiClient();
    const { clips, range } = context;
    
    // DECISION LOGIC: 
    // If we have a specific range selection (end > start), we analyze that.
    // If not, we fall back to "Survey Mode" if there are many clips, or full playback if few.
    const hasSelection = range.end > range.start && (range.end - range.start) > 0.1;
    const isSurveyMode = !hasSelection && clips.length > 3;

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
        // Use the context range or default to entire timeline
        const duration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0);
        const analysisRange = hasSelection ? 
            { start: range.start, end: range.end, tracks: [] as any } : 
            { start: 0, end: Math.min(duration, 45), tracks: [] as any };

        mediaParts = await rangeToGeminiParts(analysisRange, clips, mediaRefs);
        instructions = `
        MODE: TIMELINE PLAYBACK.
        RANGE: ${analysisRange.start.toFixed(1)}s to ${analysisRange.end.toFixed(1)}s.
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
