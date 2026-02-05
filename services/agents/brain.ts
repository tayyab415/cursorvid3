
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
    
    AVAILABLE TOOLS:
    - move_clip, ripple_delete, split_clip, update_clip_property
    - apply_visual_transform (zoom, pan)
    - add_text_overlay
    - generate_voiceover (TTS)
    - generate_video_asset (Veo 3 - use for intros, b-roll, transitions)
    - generate_image_asset (Imagen/Gemini - use for static backgrounds)
    - request_user_assistance (ONLY use if generation is impossible or the user explicitly asks to upload their own specific file)

    INSTRUCTIONS:
    1. **PRIORITIZE GENERATION**: If the user asks to "create", "generate", or "make" something (like an intro) and you don't have the files, DO NOT ask them to upload. Use 'generate_video_asset' or 'generate_image_asset'.
    2. **MODEL SELECTION**: 
       - For 'generate_video_asset': Use 'veo-3.1-fast-generate-preview' for quick drafts or simple concepts. Use 'veo-3.1-generate-preview' for high-quality, complex, or cinematic requests.
       - For 'generate_image_asset': Use 'gemini-2.5-flash-image' by default. Use 'gemini-3-pro-image-preview' for detailed art or text rendering.
    3. **CONTEXTUAL PROMPTING**: Write highly detailed visual prompts based on the 'analysis'.
    4. **AUTONOMY**: Be decisive.
    
    OUTPUT JSON SCHEMA:
    {
        "thought": "First-person reasoning. Explain why you chose the specific model and parameters.",
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
