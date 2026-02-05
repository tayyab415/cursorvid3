
import { Clip, PlanStep, AgentContext } from '../../types';
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
  async plan(userIntent: string, analysis: VideoAnalysis, context: AgentContext): Promise<BrainOutput> {
    const ai = getAiClient();
    const { clips, selectedClipIds, currentTime } = context;
    
    // Calculate timeline bounds
    const timelineDuration = clips.length > 0 
        ? Math.max(...clips.map(c => c.startTime + c.duration)) 
        : 0;

    // Create a rich context string for the LLM
    const timelineContext = clips.map(c => ({
        id: c.id,
        title: c.title,
        type: c.type,
        start: c.startTime.toFixed(2),
        duration: c.duration.toFixed(2),
        track: c.trackId,
        text: c.text ? c.text.slice(0, 30) : undefined,
        isSelected: selectedClipIds.includes(c.id)
    }));

    // Extract visual style for consistency
    const detectedStyle = analysis.visual?.styleDescription || "Cinematic, high quality, consistent with existing footage";

    const prompt = `
    ROLE: You are the BRAIN of a video editor.
    TASK: Create a concrete editing plan to satisfy the User Intent, considering the Visual Analysis.
    
    USER INTENT: "${userIntent}"
    
    EYES ANALYSIS: 
    - Thought: ${analysis.thought}
    - Visual Style: ${detectedStyle}
    - Editing Needs: ${analysis.editingNeeds?.join(', ')}
    
    TIMELINE STATE:
    - Total Duration: ${timelineDuration.toFixed(2)}s
    - Playhead Position: ${currentTime.toFixed(2)}s
    - Selected Clips: ${selectedClipIds.length > 0 ? selectedClipIds.join(', ') : 'None'}
    - Clips: ${JSON.stringify(timelineContext)}
    
    AVAILABLE TOOLS:
    - move_clip, ripple_delete, split_clip, update_clip_property
    - apply_visual_transform (zoom, pan)
    - add_text_overlay
    - generate_voiceover (TTS)
    - generate_video_asset (Veo 3 - use for intros, b-roll, transitions)
    - generate_image_asset (Imagen/Gemini - use for static backgrounds)
    - request_user_assistance (ONLY use if generation is impossible or the user explicitly asks to upload their own specific file)

    INSTRUCTIONS:
    1. **APPENDING CONTENT**: If adding an Outro or End Screen, use 'insertTime' = ${timelineDuration.toFixed(2)}. Do NOT put it at 0.
    2. **PRIORITIZE GENERATION**: If the user asks to "create", "generate", or "make" something (like an intro) and you don't have the files, DO NOT ask them to upload. Use 'generate_video_asset' or 'generate_image_asset'.
    3. **STYLE MATCHING (CRITICAL)**: When calling 'generate_video_asset' or 'generate_image_asset', you MUST incorporate the 'Visual Style' detected by Eyes.
       - INSTEAD OF: "A generic intro video"
       - USE: "A video representing [Topic] with style: ${detectedStyle}"
    4. **MODEL SELECTION**: 
       - For 'generate_video_asset': Use 'veo-3.1-fast-generate-preview' for quick drafts or simple concepts. Use 'veo-3.1-generate-preview' for high-quality, complex, or cinematic requests.
       - For 'generate_image_asset': Use 'gemini-2.5-flash-image' by default. Use 'gemini-3-pro-image-preview' for detailed art or text rendering.
    5. **AUTONOMY**: Be decisive.
    6. **REFERENCING**: Use specific Clip IDs from the TIMELINE STATE in your plan operations.
    
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
        let parsed: any = {};
        
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            console.warn("Failed to parse Brain JSON directly, attempting fallback cleanup", e);
            // Try to salvage if it's wrapped in markdown
            const match = text.match(/```json\n([\s\S]*?)\n```/);
            if (match) {
                try { parsed = JSON.parse(match[1]); } catch {}
            } else {
                // Try simpler brace matching
                const match2 = text.match(/\{[\s\S]*\}/);
                if (match2) {
                    try { parsed = JSON.parse(match2[0]); } catch {}
                }
            }
        }

        // Validate and Default
        const finalPlan = {
            thought: parsed.thought || "I have formulated a plan.",
            plan: {
                goal: parsed.plan?.goal || "Edit Timeline",
                reasoning: parsed.plan?.reasoning || "Executing based on user request.",
                steps: Array.isArray(parsed.plan?.steps) ? parsed.plan.steps : []
            }
        };

        return finalPlan;

    } catch (e) {
        console.error("Brain Agent Error", e);
        return {
            thought: "My planning process was interrupted by an error.",
            plan: { goal: "Error Recovery", reasoning: "Failed to generate plan structure.", steps: [] }
        };
    }
  }
}
