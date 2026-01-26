
import { GoogleGenAI, Type, Modality, FunctionDeclaration } from "@google/genai";
import { Clip, Suggestion, ToolAction, PlacementDecision } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is not defined");
  }
  return new GoogleGenAI({ apiKey });
};

// --- UTILS ---

// Helper to convert raw PCM to WAV Blob URL
const pcmToWav = (pcmData: Uint8Array, sampleRate: number = 24000, numChannels: number = 1): string => {
    const buffer = new ArrayBuffer(44 + pcmData.length);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcmData.length, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true); // 16-bit

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcmData.length, true);

    // Write PCM data
    const payload = new Uint8Array(buffer, 44);
    payload.set(pcmData);

    const blob = new Blob([buffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
};

const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};

const base64ToUint8Array = (base64: string) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
};


// --- API CALLS ---

// Define the Tool Schema for the Action-First Agent
const suggestActionTool: FunctionDeclaration = {
  name: 'suggest_ai_action',
  description: 'Propose an executable editing action to the user.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tool_id: {
        type: Type.STRING,
        enum: ['GENERATE_TRANSITION', 'GENERATE_VOICEOVER', 'SMART_TRIM'],
        description: 'The specific action ID to execute.'
      },
      button_label: {
        type: Type.STRING,
        description: 'Short, punchy label for the action button (e.g. "Fix Transition").'
      },
      reasoning: {
        type: Type.STRING,
        description: 'Brief explanation (under 10 words) of why this action improves the video.'
      },
      timestamp: {
        type: Type.NUMBER,
        description: 'Optional timestamp in seconds where the action should apply.'
      },
      action_content: {
          type: Type.STRING,
          description: 'CRITICAL: The script for VOICEOVER or the prompt for TRANSITION. Must be fully written out.'
      }
    },
    required: ['tool_id', 'button_label', 'reasoning']
  }
};

export const chatWithGemini = async (
    history: { role: 'user' | 'model' | 'system', text?: string, parts?: any[] }[],
    message: string | any[]
): Promise<{ text: string, toolAction?: ToolAction }> => {
    const ai = getAiClient();
    
    // Normalize history to the API format
    const apiHistory = history
        .filter(msg => msg.role === 'user' || msg.role === 'model')
        .map(msg => {
            if (msg.parts) {
                return { role: msg.role as 'user' | 'model', parts: msg.parts };
            }
            return { role: msg.role as 'user' | 'model', parts: [{ text: msg.text || '' }] };
        });

    const systemInstruction = `
You are an ACTION-FIRST Video Editor Agent.

You are NOT a general video critic.
You are NOT allowed to end with questions.
You exist to propose executable edits.

========================
WHAT YOU ARE CONNECTED TO
========================
- A video editor that can execute suggested actions via clickable buttons.
- You can ONLY act by calling the tool \`suggest_ai_action\`.
- If no tool is proposed, your response is considered a FAILURE.

========================
HOW YOU MUST THINK
========================
For every user message:
1. Analyze the clip or range.
2. Identify at least ONE concrete improvement.
3. Convert that improvement into an ACTION.

If multiple improvements exist:
- Propose 1–3 actions maximum.
- Prefer GENERATIVE actions when possible.

========================
AVAILABLE ACTIONS
========================
You can ONLY suggest these actions:

1. GENERATE_TRANSITION  
   Use when pacing, scene change, or visual continuity is weak.
   CRITICAL: You MUST provide a visual prompt in 'action_content'.
   Example: action_content: "A futuristic glitch transition blurring into the next scene"

2. GENERATE_VOICEOVER  
   Use when context, explanation, or engagement is missing.
   CRITICAL: You MUST write the exact Voiceover Script in 'action_content'.
   Example: action_content: "Welcome to the grand finals. The stakes have never been higher."

3. SMART_TRIM  
   Use when pacing is slow, static, or contains silence.

========================
STRICT OUTPUT RULES
========================
- You MUST call \`suggest_ai_action\` at least once.
- Do NOT ask the user questions.
- Do NOT give editing tutorials.
- Text response must be under 15 words.
- If you mention an improvement, it MUST appear as a suggestion button.

If no action applies, choose the closest one and adapt it.
    `;

    const chat = ai.chats.create({
        model: 'gemini-3-flash-preview',
        history: apiHistory,
        config: {
            systemInstruction: systemInstruction,
            tools: [{ functionDeclarations: [suggestActionTool] }],
        }
    });

    try {
        let msgPayload;
        if (typeof message === 'string') {
            msgPayload = { message };
        } else {
             msgPayload = { message: message };
        }
        
        const result = await chat.sendMessage(msgPayload);
        
        let toolAction: ToolAction | undefined;

        // Parse Function Call
        if (result.functionCalls && result.functionCalls.length > 0) {
            const call = result.functionCalls[0];
            if (call.name === 'suggest_ai_action') {
                const args = call.args as any;
                toolAction = {
                    tool_id: args.tool_id,
                    button_label: args.button_label,
                    reasoning: args.reasoning,
                    timestamp: args.timestamp,
                    action_content: args.action_content,
                    parameters: args.parameters
                };
            }
        }

        // Return text + optional tool action
        const textResponse = result.text || (toolAction ? "Here is a suggested action:" : "");

        return { 
            text: textResponse, 
            toolAction: toolAction 
        };

    } catch (e: any) {
        console.error("Chat Error:", e);
        return { text: "Sorry, I encountered an error communicating with the AI." };
    }
};

/**
 * PIPELINE STEP 2: REFINEMENT
 */
export const generateRefinement = async (
    originalContext: string,
    toolType: 'VOICEOVER' | 'TRANSITION'
): Promise<string> => {
    const ai = getAiClient();
    const prompt = toolType === 'VOICEOVER'
        ? `You previously suggested a voiceover with this reasoning: "${originalContext}". Write a short, engaging, professional script (max 2 sentences) for this voiceover. Return ONLY the raw text to be spoken. Do not include quotes or labels.`
        : `You previously suggested a video transition with this reasoning: "${originalContext}". Write a highly detailed visual prompt for an AI video generator to create this transition. Return ONLY the raw prompt text.`;
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: { parts: [{ text: prompt }] }
        });
        return response.text?.trim() || (toolType === 'VOICEOVER' ? "Voiceover content unavailable." : "Cinematic transition");
    } catch (e) {
        console.error("Refinement Error:", e);
        return toolType === 'VOICEOVER' ? "Voiceover generation failed." : "Standard transition";
    }
};

/**
 * PIPELINE STEP 3: STRUCTURAL REASONING
 * Determines WHERE to put the generated asset and HOW to restructure the timeline.
 */
export const determinePlacement = async (
    currentClips: Clip[],
    assetType: 'audio' | 'video',
    assetDuration: number,
    intentReasoning: string,
    proposedTimestamp?: number
): Promise<PlacementDecision> => {
    const ai = getAiClient();
    
    // Filter relevant clips for context
    const simplifiedTimeline = currentClips.map(c => ({
        id: c.id,
        type: c.type,
        start: c.startTime,
        duration: c.duration,
        end: c.startTime + c.duration,
        track: c.trackId
    })).sort((a,b) => a.start - b.start);

    const prompt = `
    You are a Structural Video Editor.
    
    CONTEXT:
    The user is adding a new ${assetType} clip (Duration: ${assetDuration.toFixed(2)}s).
    Reason for add: "${intentReasoning}".
    Proposed Timestamp: ${proposedTimestamp ?? 'None (Decide based on intent)'}.
    
    CURRENT TIMELINE:
    ${JSON.stringify(simplifiedTimeline, null, 2)}
    
    TASK:
    Decide the optimal placement strategy.
    
    RULES:
    1. 'ripple': Use this for INTROS, INSERTIONS, or when adding new scenes. It pushes existing clips forward.
    2. 'overlay': Use this for COMMENTARY, BACKGROUND MUSIC, or SOUND EFFECTS. It places audio on top without moving video.
    3. 'replace': Use this if replacing a specific placeholder.
    
    If 'intent' mentions "Intro", you MUST start at 0 and use 'ripple'.
    If 'intent' mentions "Transition", place it between clips using 'ripple' or 'overlay' depending on style.
    
    OUTPUT:
    Return ONLY a JSON object:
    {
      "strategy": "ripple" | "overlay" | "replace",
      "startTime": number,
      "trackId": number (Use 0 for audio, 1+ for video),
      "reasoning": "string explanation"
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview", // Fast reasoning
            contents: { parts: [{ text: prompt }] },
            config: { responseMimeType: "application/json" }
        });
        
        const text = response.text || "{}";
        const cleanText = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanText) as PlacementDecision;
    } catch (e) {
        console.error("Structural Reasoning Error:", e);
        // Fallback
        return {
            strategy: 'overlay',
            startTime: proposedTimestamp || 0,
            trackId: assetType === 'audio' ? 0 : 1,
            reasoning: "Fallback placement due to error."
        };
    }
};

export const analyzeVideoFrames = async (
  base64Frames: string[],
  prompt: string
): Promise<string> => {
  const ai = getAiClient();
  const parts: any[] = [{ text: prompt }];
  
  base64Frames.forEach((frameData) => {
    const cleanData = frameData.split(',')[1] || frameData;
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: cleanData,
      },
    });
  });

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: { parts: parts },
      config: { thinkingConfig: { thinkingBudget: 1024 } }
    });
    return response.text || "No analysis generated.";
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw error;
  }
};

export const suggestEdits = async (currentClips: Clip[]): Promise<Suggestion[]> => {
  const ai = getAiClient();
  const prompt = `You are a professional video editor.
  Here is the current timeline of video clips: 
  ${JSON.stringify(currentClips, null, 2)}
  Task: Provide 3 distinct, high-quality edit suggestions.
  Return a JSON object with a 'suggestions' array.`;
  
  try {
    const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: prompt,
        config: {
          thinkingConfig: { thinkingBudget: 1024 },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              suggestions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    label: { type: Type.STRING },
                    description: { type: Type.STRING },
                    reasoning: { type: Type.STRING },
                    clips: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          id: { type: Type.STRING },
                          title: { type: Type.STRING },
                          duration: { type: Type.NUMBER },
                          startTime: { type: Type.NUMBER },
                          sourceStartTime: { type: Type.NUMBER },
                          type: { type: Type.STRING }
                        },
                        required: ['id', 'title', 'duration', 'startTime', 'sourceStartTime']
                      }
                    }
                  },
                  required: ['label', 'description', 'reasoning', 'clips']
                }
              }
            }
          }
        }
    });

    const json = JSON.parse(response.text || "{ \"suggestions\": [] }");
    return json.suggestions || [];
  } catch (error) {
    console.error("Suggestion Error:", error);
    return [];
  }
};

export const generateImage = async (
    prompt: string, 
    model: string = 'gemini-2.5-flash-image', 
    aspectRatio: string = '16:9'
): Promise<string> => {
    const ai = getAiClient();
    try {
        const config: any = {
             imageConfig: { aspectRatio: aspectRatio }
        };

        // gemini-3-pro-image-preview supports imageSize, flash-image does not
        if (model === 'gemini-3-pro-image-preview') {
             config.imageConfig.imageSize = '2K';
        }

        const response = await ai.models.generateContent({
            model: model,
            contents: { parts: [{ text: prompt }] },
            config: config
        });

        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                const base64EncodeString = part.inlineData.data;
                return `data:${part.inlineData.mimeType};base64,${base64EncodeString}`;
            }
        }
        throw new Error("No image data found in response");
    } catch (error) {
        console.error("Image Generation Error:", error);
        throw error;
    }
};

export const generateVideo = async (
    prompt: string,
    model: string = 'veo-3.1-fast-generate-preview',
    aspectRatio: string = '16:9',
    resolution: string = '720p',
    durationSeconds: number = 8,
    startImageBase64?: string | null,
    endImageBase64?: string | null
): Promise<string> => {
    // Check for API key selection logic for Veo models
    if ((window as any).aistudio) {
        const hasKey = await (window as any).aistudio.hasSelectedApiKey();
        if (!hasKey) {
             await (window as any).aistudio.openSelectKey();
             // Race condition handling: proceed assuming success
        }
    }

    // Validation for Veo Constraints
    if (endImageBase64 && !startImageBase64) {
        throw new Error("Veo requires a Start Frame to be provided if an End Frame is used.");
    }
    
    // Constraint enforcement for safety
    if ((resolution === '1080p' || resolution === '4k' || startImageBase64 || endImageBase64) && durationSeconds !== 8) {
        console.warn("Forcing duration to 8s due to resolution or reference image constraints.");
        durationSeconds = 8;
    }

    const performGeneration = async () => {
        const ai = getAiClient(); // Always get new client to pick up latest env vars
        
        // Prepare payload options
        const options: any = {
            model: model,
            config: {
                numberOfVideos: 1,
                resolution: resolution as any,
                aspectRatio: aspectRatio === '16:9' || aspectRatio === '9:16' ? aspectRatio as any : '16:9',
                durationSeconds: durationSeconds
            }
        };

        if (prompt) options.prompt = prompt;

        // Add Start Image (image)
        if (startImageBase64) {
            const [header, data] = startImageBase64.split(',');
            // Extract mimetype from header (e.g., "data:image/jpeg;base64")
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
            
            options.image = {
                imageBytes: data,
                mimeType: mimeType
            };
        }

        // Add End Image (lastFrame)
        if (endImageBase64) {
            const [header, data] = endImageBase64.split(',');
            const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
            
            options.config.lastFrame = {
                imageBytes: data,
                mimeType: mimeType
            };
        }

        return await ai.models.generateVideos(options);
    };

    let operation;
    try {
        operation = await performGeneration();
    } catch (e: any) {
        // Handle specific error for missing paid key permissions
        if (e.message?.includes("Requested entity was not found") && (window as any).aistudio) {
             console.warn("API Key issue detected. Prompting for selection again.");
             await (window as any).aistudio.openSelectKey();
             // Retry once
             operation = await performGeneration();
        } else {
            throw e;
        }
    }

    if (!operation) {
        throw new Error("Failed to initialize video generation operation.");
    }

    // Polling loop
    while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const ai = getAiClient();
        // Use the full operation object for polling, per SDK requirements
        operation = await ai.operations.getVideosOperation({ operation: operation });
    }

    // Check for explicit API error (e.g., safety block, invalid argument)
    if (operation.error) {
        console.error("Veo Operation Error:", operation.error);
        throw new Error(`Video generation failed: ${operation.error.message || "Unknown error"} (Code: ${operation.error.code})`);
    }

    // Attempt to retrieve response from standard response or result property
    const videoResponse = operation.response || (operation as any).result;
    const downloadLink = videoResponse?.generatedVideos?.[0]?.video?.uri;
    
    if (!downloadLink) {
        console.error("Veo Operation Dump:", JSON.stringify(operation, null, 2));
        throw new Error("No video URI in response. The generation may have been blocked or failed silently.");
    }

    // Fetch and blobify to avoid CORS/expiration issues in simple tags
    const apiKey = process.env.API_KEY;
    const res = await fetch(`${downloadLink}&key=${apiKey}`);
    if (!res.ok) throw new Error(`Failed to download video: ${res.statusText}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
};

export const generateSpeech = async (
    text: string,
    voiceName: string = 'Kore'
): Promise<string> => {
    const ai = getAiClient();
    try {
        // Using the dedicated TTS model which is reliable for speech
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: text }] }],
            config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: voiceName },
                    },
                },
            },
        });

        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64Audio) throw new Error("No audio data found");

        // Decode base64 to raw PCM then add WAV header
        const pcmData = base64ToUint8Array(base64Audio);
        const wavUrl = pcmToWav(pcmData, 24000, 1);
        
        return wavUrl;
    } catch (error) {
        console.error("Speech Generation Error:", error);
        throw error;
    }
};

export const generateSubtitles = async (
    audioBase64: string,
    mimeType: string = 'audio/wav'
): Promise<{start: number, end: number, text: string}[]> => {
    const ai = getAiClient();
    
    // We use gemini-2.5-flash for strong multimodal (audio/video) understanding
    const model = "gemini-2.5-flash"; 

    const prompt = `
    Listen to the audio/video and generate precise subtitles.
    Return ONLY a JSON array with objects containing 'start' (number in seconds), 'end' (number in seconds), and 'text' (string).
    Do not include markdown formatting.
    Example: [{"start": 0, "end": 2.5, "text": "Hello world"}, {"start": 2.5, "end": 4, "text": "This is a video."}]
    `;

    try {
        const response = await ai.models.generateContent({
            model: model,
            contents: {
                parts: [
                    {
                        inlineData: {
                            mimeType: mimeType,
                            data: audioBase64
                        }
                    },
                    { text: prompt }
                ]
            },
            config: {
                responseMimeType: "application/json",
            }
        });

        const text = response.text || "[]";
        // Clean up any potential markdown code blocks if the model ignores the instruction
        const cleanText = text.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanText);
    } catch (error) {
        console.error("Subtitle Generation Error:", error);
        throw error;
    }
};
