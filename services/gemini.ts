
import { GoogleGenAI, Type, FunctionDeclaration, Modality, FunctionCallingConfigMode } from "@google/genai";
import { Clip, ToolAction, PlacementDecision, EditPlan, Suggestion, PlanStep, VideoIntent } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is not defined");
  }
  return new GoogleGenAI({ apiKey });
};

// --- TOOL DEFINITIONS ---

const updateVideoIntentTool: FunctionDeclaration = {
  name: 'update_video_intent',
  description: 'Call this when you have inferred or confirmed the video platform, goal, or tone from the user conversation.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      platform: { type: Type.STRING, description: "The target platform (TikTok, YouTube, Instagram, TV, Internal)." },
      goal: { type: Type.STRING, description: "The creative goal (Viral, Educational, Storytelling, Authority)." },
      tone: { type: Type.STRING, description: "The desired tone (Energetic, Cinematic, Professional, Calm)." }
    }
  }
};

const createEditPlanTool: FunctionDeclaration = {
  name: 'create_edit_plan',
  description: 'Propose a structured, multi-step plan to improve or edit the video based on high-level goals. Use this for complex requests.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      goal: {
        type: Type.STRING,
        description: 'The overall creative goal being addressed.'
      },
      analysis: {
        type: Type.STRING,
        description: 'A brief, sharp analysis of the current timeline (Director’s note).'
      },
      steps: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING },
            intent: { type: Type.STRING, description: 'What needs to happen semantically (e.g., "Add a punchy intro voiceover").' },
            category: { type: Type.STRING, enum: ['visual', 'audio', 'pacing', 'style'] },
            reasoning: { type: Type.STRING, description: 'Why this step is necessary for the goal.' },
            timestamp: { type: Type.NUMBER, description: 'Optional timeline marker in seconds.' }
          },
          required: ['id', 'intent', 'reasoning']
        }
      }
    },
    required: ['goal', 'analysis', 'steps']
  }
};

const editTimelineTool: FunctionDeclaration = {
    name: 'edit_timeline_state',
    description: 'Directly modify the timeline structure: move clips, change volume, delete clips, or trim duration. Use this for FIXING issues (overlap, silence, pacing).',
    parameters: {
        type: Type.OBJECT,
        properties: {
            operations: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        type: { type: Type.STRING, enum: ['move', 'trim', 'volume', 'delete'] },
                        clipId: { type: Type.STRING, description: 'The exact ID of the clip to modify.' },
                        newStartTime: { type: Type.NUMBER, description: 'For move: new start time in seconds.' },
                        newTrackId: { type: Type.NUMBER, description: 'For move: new track index.' },
                        newDuration: { type: Type.NUMBER, description: 'For trim: new duration in seconds.' },
                        newVolume: { type: Type.NUMBER, description: 'For volume: 0.0 to 1.0.' }
                    },
                    required: ['type', 'clipId']
                }
            },
            reasoning: { type: Type.STRING }
        },
        required: ['operations', 'reasoning']
    }
};

const suggestActionTool: FunctionDeclaration = {
  name: 'suggest_ai_action',
  description: 'Propose a single executable editing action for GENERATION tasks (creating NEW content).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tool_id: {
        type: Type.STRING,
        enum: ['GENERATE_TRANSITION', 'GENERATE_VOICEOVER', 'SMART_TRIM'],
        description: 'The specific action ID to execute.'
      },
      button_label: { type: Type.STRING },
      reasoning: { type: Type.STRING },
      timestamp: { type: Type.NUMBER },
      action_content: { type: Type.STRING, description: 'Payload for the action (script for VO, prompt for transition).' }
    },
    required: ['tool_id', 'button_label', 'reasoning']
  }
};

const performAnalysisTool: FunctionDeclaration = {
    name: 'perform_deep_analysis',
    description: 'Use this tool IMMEDIATELY when the user asks to "analyze", "review", or "check" the video. This delegates the task to a specialized factual analysis engine.',
    parameters: { type: Type.OBJECT, properties: {} }
};

// --- CHAT SERVICE ---

export const chatWithGemini = async (
    history: { role: 'user' | 'model' | 'system', text?: string, parts?: any[] }[],
    message: string | any[],
    currentIntent?: VideoIntent
): Promise<{ text: string, toolAction?: ToolAction, plan?: EditPlan, intentUpdate?: VideoIntent, shouldAnalyze?: boolean }> => {
    const ai = getAiClient();
    
    const apiHistory = history
        .filter(msg => ['user', 'model', 'system'].includes(msg.role))
        .map(msg => ({ 
            role: (msg.role === 'system' ? 'user' : msg.role) as 'user' | 'model', 
            parts: msg.parts || [{ text: msg.role === 'system' ? `[SYSTEM UPDATE]: ${msg.text}` : (msg.text || '') }] 
        }));

    const intentContext = currentIntent ? `
    ESTABLISHED VIDEO INTENT:
    - Platform: ${currentIntent.platform || 'Unknown'}
    - Goal: ${currentIntent.goal || 'Unknown'}
    - Tone: ${currentIntent.tone || 'Unknown'}
    ` : "ESTABLISHED VIDEO INTENT: None yet.";

    const systemInstruction = `
You are the INTELLIGENT DIRECTOR for an AI Video Editor.
You coordinate between the User, the Analysis Engine, and the Editing Tools.

${intentContext}

========================
THE PIPELINE (LAYERS)
========================

1. **ANALYSIS LAYER (Neutral/Factual)**
   - Trigger: User asks "Analyze this", "What's on the timeline?", "Review video", "Check my work".
   - ACTION: **You MUST call the tool \`perform_deep_analysis\` immediately.**
   - Do NOT attempt to analyze the timeline yourself using only metadata. Delegate to the Engine which sees the frames.

2. **PLANNING LAYER (Strategic)**
   - Trigger: User says "Fix it", "Make it better", "Edit for TikTok".
   - ACTION: Check if you have the *Video Intent* (Platform/Goal).
     - If MISSING: Ask the user.
     - If KNOWN: Call \`create_edit_plan\`.

3. **EXECUTION LAYER (Tactical)**
   - Trigger: User gives a specific command ("Add transition").
   - ACTION: Call \`suggest_ai_action\`.

========================
CRITICAL RULES
========================
- **DELEGATE ANALYSIS**: Never hallucinate a critique. Always use \`perform_deep_analysis\` for a fresh look at the visual evidence.
- **CONTEXT FIRST**: If the user says "Improve this" but you don't know the goal, ASK.
- **NO AUTOPILOT**: "Hi" = Conversation. "Analyze" = Tool Call.
    `;

    const chat = ai.chats.create({
        model: 'gemini-3-flash-preview',
        history: apiHistory,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ functionDeclarations: [createEditPlanTool, suggestActionTool, updateVideoIntentTool, performAnalysisTool] }],
        }
    });

    try {
        const msgPayload = typeof message === 'string' ? { message } : { message: message };
        const result = await chat.sendMessage(msgPayload);
        
        let toolAction: ToolAction | undefined;
        let editPlan: EditPlan | undefined;
        let intentUpdate: VideoIntent | undefined;
        let shouldAnalyze = false;

        if (result.functionCalls && result.functionCalls.length > 0) {
            for (const call of result.functionCalls) {
                const args = call.args as any;
                
                if (call.name === 'create_edit_plan') {
                    editPlan = {
                        goal: args.goal,
                        analysis: args.analysis,
                        steps: args.steps.map((s: any) => ({ ...s, status: 'approved' }))
                    };
                } else if (call.name === 'suggest_ai_action') {
                    toolAction = {
                        tool_id: args.tool_id,
                        button_label: args.button_label,
                        reasoning: args.reasoning,
                        timestamp: args.timestamp,
                        action_content: args.action_content,
                        parameters: args.parameters
                    };
                } else if (call.name === 'update_video_intent') {
                    intentUpdate = {
                        platform: args.platform,
                        goal: args.goal,
                        tone: args.tone
                    };
                } else if (call.name === 'perform_deep_analysis') {
                    shouldAnalyze = true;
                }
            }
        }

        return { 
            text: result.text || (shouldAnalyze ? "Initializing Analysis Engine..." : (editPlan ? "Proposed Edit Plan:" : toolAction ? "Suggested Action:" : "Intent Updated.")), 
            toolAction, 
            plan: editPlan,
            intentUpdate,
            shouldAnalyze
        };
    } catch (e: any) {
        console.error("Chat Error:", e);
        return { text: "Communication error. Please check your API key and network." };
    }
};

/**
 * INDEPENDENT ANALYSIS LAYER (Perception Engine)
 */
export const performDeepAnalysis = async (mediaParts: any[]): Promise<string> => {
    const ai = getAiClient();
    
    const systemPrompt = `
    ROLE: Independent Video Analysis Engine.
    TASK: Provide a purely factual, neutral, and technical breakdown of the video timeline based on the PROVIDED AUDIO AND VISUAL FRAMES.
    
    INSTRUCTIONS:
    1. **LOOK AT THE IMAGES**: Describe the visual content (lighting, subject, movement, color palette).
    2. **LISTEN TO THE AUDIO**: Describe what is being said, the music mood, or if it is silent.
    3. **GROUND TRUTH**: The visual/audio parts are the truth.
    4. **NO ADVICE**: Do not suggest edits.
    5. **FORMAT**: Markdown. Sections: Visuals, Audio, Pacing, Structure.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-preview',
            contents: {
                role: 'user',
                parts: [
                    ...mediaParts,
                    { text: "Generate Deep Analysis Report based on the provided frames and audio." }
                ]
            },
            config: { systemInstruction: systemPrompt }
        });
        return response.text || "Analysis could not be generated.";
    } catch (e) {
        console.error("Analysis Layer Error:", e);
        return "Error: Analysis Layer failed to respond.";
    }
};

/**
 * VERIFICATION LAYER
 * Checks if the executed plan actually achieved the goal.
 */
export const verifyTimelineState = async (mediaParts: any[], goal: string): Promise<string> => {
     const ai = getAiClient();
     
     const systemPrompt = `
     ROLE: Quality Assurance / Verification Engine.
     TASK: You are looking at the FINAL STATE of a video timeline after edits. Compare it against the USER GOAL.
     
     USER GOAL: "${goal}"
     
     INSTRUCTIONS:
     1. Analyze the audio and visuals provided.
     2. Does the video now meet the goal? 
     3. Be critical. If there is still overlap, silence, or bad pacing, say so.
     4. Start with "VERIFICATION RESULT: [SUCCESS/PARTIAL/FAIL]".
     5. Provide a short 1-sentence explanation.
     `;

     try {
         const response = await ai.models.generateContent({
             model: 'gemini-3-pro-preview',
             contents: {
                 role: 'user',
                 parts: [
                     ...mediaParts,
                     { text: "Verify if the timeline meets the goal." }
                 ]
             },
             config: { systemInstruction: systemPrompt }
         });
         return response.text || "Verification failed.";
     } catch (e) {
         return "Verification system error.";
     }
}

/**
 * AUTONOMOUS EXECUTOR
 * Now equipped with 'edit_timeline_state' to modify existing clips.
 */
export const resolvePlanStep = async (step: PlanStep, timelineContext: string): Promise<ToolAction | null> => {
    const ai = getAiClient();
    
    const prompt = `
    CONTEXT:
    You are an autonomous video editor executor. 
    Your goal is to convert a high-level PLAN STEP into a specific, machine-readable TOOL ACTION.

    TIMELINE DATA (Contains Clip IDs):
    ${timelineContext}

    STEP TO EXECUTE:
    Intent: "${step.intent}"
    Reasoning: "${step.reasoning}"
    Category: "${step.category}"
    Timestamp: ${step.timestamp ?? 'Start of relevant clip'}

    AVAILABLE TOOLS:
    1. EDIT_TIMELINE_STATE (tool_id: "EDIT_TIMELINE")
       - **PRIORITY**: Use this for FIXING things (e.g. "Fix overlap", "Lower volume", "Delete clip", "Move clip").
       - You MUST provide specific 'clipId's from the Timeline Data.
       - Operations: 'move', 'trim', 'volume', 'delete'.
       
    2. GENERATE_VOICEOVER (tool_id: "GENERATE_VOICEOVER")
       - Only use if a NEW voiceover is explicitly requested. Do not use to "fix" an existing one.
       - Parameter 'action_content': WRITE THE FULL SCRIPT.
    
    3. GENERATE_TRANSITION (tool_id: "GENERATE_TRANSITION")
       - Parameter 'action_content': WRITE A VISUAL PROMPT.
       
    4. SMART_TRIM (tool_id: "SMART_TRIM")
       - Use for general tightening if no specific ID is targetable.

    INSTRUCTIONS:
    - Analyze the intent.
    - If the goal is to "Fix overlap", "Adjust volume", or "Remove", YOU MUST USE 'EDIT_TIMELINE_STATE' targeting the specific clip IDs involved in the conflict.
    - Call 'suggest_ai_action' (wrapper) or 'edit_timeline_state'.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: { parts: [{ text: prompt }] },
            config: {
                // We allow both creation and editing tools
                tools: [{ functionDeclarations: [suggestActionTool, editTimelineTool] }],
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } } 
            }
        });

        const functionCall = response.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
        
        if (functionCall) {
            const args = functionCall.args as any;
            
            if (functionCall.name === 'edit_timeline_state') {
                 return {
                     tool_id: 'EDIT_TIMELINE',
                     button_label: 'Apply Edits',
                     reasoning: args.reasoning,
                     parameters: { operations: args.operations }
                 };
            } else if (functionCall.name === 'suggest_ai_action') {
                 return {
                    tool_id: args.tool_id,
                    button_label: args.button_label,
                    reasoning: args.reasoning,
                    timestamp: args.timestamp ?? step.timestamp,
                    action_content: args.action_content,
                    parameters: args.parameters
                 };
            }
        }
    } catch (e) {
        console.error("Executor Error:", e);
    }
    return null;
};

// ... existing helper functions ...
export const generateRefinement = async (originalContext: string, toolType: 'VOICEOVER' | 'TRANSITION'): Promise<string> => {
    const ai = getAiClient();
    const prompt = toolType === 'VOICEOVER'
        ? `You previously suggested a voiceover with this reasoning: "${originalContext}". Write a short, engaging, professional script (max 2 sentences) for this voiceover. Return ONLY the raw text to be spoken. Do not include quotes or labels.`
        : `You previously suggested a video transition with this reasoning: "${originalContext}". Write a highly detailed visual prompt for an AI video generator to create this transition. Return ONLY the raw prompt text.`;
    const response = await ai.models.generateContent({ model: 'gemini-3-flash-preview', contents: prompt });
    return response.text?.trim() || "";
};

export const determinePlacement = async (currentClips: Clip[], assetType: 'audio' | 'video', assetDuration: number, intentReasoning: string, proposedTimestamp?: number): Promise<PlacementDecision> => {
    const ai = getAiClient();
    const prompt = `Timeline: ${JSON.stringify(currentClips.map(c=>({id:c.id, t:c.type, s:c.startTime, d:c.duration})))}. User intent: "${intentReasoning}". New asset: ${assetType} (${assetDuration}s). Decision? JSON: {strategy, startTime, trackId, reasoning}`;
    const response = await ai.models.generateContent({ model: "gemini-3-flash-preview", contents: prompt, config: { responseMimeType: "application/json" }});
    return JSON.parse(response.text || "{}");
};

export const analyzeVideoFrames = async (base64Frames: string[], prompt: string): Promise<string> => {
  const ai = getAiClient();
  const parts: any[] = [{ text: prompt }];
  base64Frames.forEach((frameData) => {
    const cleanData = frameData.split(',')[1] || frameData;
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: cleanData }});
  });
  const response = await ai.models.generateContent({ model: 'gemini-3-pro-preview', contents: { parts: parts }});
  return response.text || "";
};

export const suggestEdits = async (currentClips: Clip[]): Promise<Suggestion[]> => { return []; };
export const generateImage = async (prompt: string, model: string = 'gemini-2.5-flash-image', aspectRatio: string = '16:9'): Promise<string> => { return ""; };
export const generateVideo = async (p: string, m: string = 'veo-3.1-fast-generate-preview', a: string = '16:9', r: string = '720p', d: number = 8, s?: string | null, e?: string | null): Promise<string> => { return ""; };

const base64ToUint8Array = (base64: string) => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

const pcmToWav = (pcmData: Uint8Array, sampleRate: number, numChannels: number): string => {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + pcmData.length, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); 
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true); 
  view.setUint16(32, numChannels * 2, true); 
  view.setUint16(34, 16, true); 
  writeString(36, 'data');
  view.setUint32(40, pcmData.length, true);

  const blob = new Blob([header, pcmData], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
};

export const generateSpeech = async (text: string, voiceName: string = 'Kore'): Promise<string> => {
    const ai = getAiClient();
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text }] }],
        config: { 
          responseModalities: [Modality.AUDIO], 
          speechConfig: { 
            voiceConfig: { 
              prebuiltVoiceConfig: { voiceName }
            }
          }
        }
    });
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
    const pcmData = base64ToUint8Array(base64Audio);
    return pcmToWav(pcmData, 24000, 1);
};
export const generateSubtitles = async (audioBase64: string): Promise<{start: number, end: number, text: string}[]> => { return []; };
