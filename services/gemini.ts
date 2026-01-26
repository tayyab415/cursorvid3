import { GoogleGenAI, Type, Modality } from "@google/genai";
import { Clip, Suggestion } from "../types";

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

export const chatWithGemini = async (
    history: { role: 'user' | 'model' | 'system', text: string }[],
    message: string
): Promise<string> => {
    const ai = getAiClient();
    const apiHistory = history
        .filter(msg => msg.role === 'user' || msg.role === 'model')
        .map(msg => ({
            role: msg.role as 'user' | 'model',
            parts: [{ text: msg.text }]
        }));

    const chat = ai.chats.create({
        model: 'gemini-3-flash-preview',
        history: apiHistory,
        config: {
            systemInstruction: "You are an intelligent video editing assistant. You help users navigate the editor, suggest creative ideas, and analyze video content.",
        }
    });

    try {
        const result = await chat.sendMessage({ message });
        return result.text;
    } catch (e: any) {
        console.error("Chat Error:", e);
        return "Sorry, I encountered an error communicating with the AI.";
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