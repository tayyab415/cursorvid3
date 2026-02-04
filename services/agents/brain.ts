
import { Clip, PlanStep } from '../../types';
import { getAiClient } from '../gemini';
import { TIMELINE_PRIMITIVES } from '../timelinePrimitives';
import { VideoAnalysis } from './eyes';
import { Type, FunctionCallingConfigMode } from '@google/genai';

export interface BrainOutput {
  thought: string;
  plan: {
    goal: string;
    reasoning: string;
    steps: Array<{
      id: string;
      intent: string;
      operation: string;
      parameters: any;
      reasoning: string;
    }>;
  };
}

export class BrainAgent {
  async plan(userIntent: string, analysis: VideoAnalysis, clips: Clip[]): Promise<BrainOutput> {
    const ai = getAiClient();
    
    const timelineContext = clips.map(c => ({
        id: c.id,
        type: c.type,
        start: c.startTime.toFixed(2),
        duration: c.duration.toFixed(2),
        track: c.trackId,
        title: c.title
    }));

    const prompt = `
    ROLE: You are the BRAIN of a video editor.
    TASK: Create a concrete editing plan to satisfy the User Intent, considering the Visual Analysis.
    
    USER INTENT: "${userIntent}"
    EYES ANALYSIS: ${JSON.stringify(analysis)}
    CURRENT TIMELINE: ${JSON.stringify(timelineContext)}
    
    INSTRUCTIONS:
    1. Break the task into 1-5 atomic steps.
    2. Each step MUST map to a function: 
       - update_clip_property (move, resize, volume, speed, track)
       - apply_visual_transform (zoom, pan, scale, crop, rotate)
       - ripple_delete (remove clip and close gap)
       - split_clip (cut a clip in half)
       - generate_voiceover (create audio)
       - add_text_overlay (add subtitles, titles)
    3. Be specific with timestamps and values.
    
    OUTPUT JSON SCHEMA:
    {
        "thought": "First-person reasoning...",
        "plan": {
            "goal": "High level goal",
            "reasoning": "Why this plan works",
            "steps": [
                {
                    "id": "step_1",
                    "intent": "Human readable intent",
                    "operation": "function_name",
                    "parameters": { ...args for function... },
                    "reasoning": "Why this specific step"
                }
            ]
        }
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                tools: [{ functionDeclarations: TIMELINE_PRIMITIVES }], 
            }
        });

        const text = response.text || "{}";
        return JSON.parse(text);
    } catch (e) {
        console.error("Brain Agent Error", e);
        return {
            thought: "My planning process was interrupted.",
            plan: { goal: "Error", reasoning: "Failed to generate plan", steps: [] }
        };
    }
  }
}
