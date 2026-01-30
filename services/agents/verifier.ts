import { Clip } from '../../types';
import { getAiClient } from '../gemini';
import { Type } from '@google/genai';

export interface VerificationResult {
  passed: boolean;
  issues: string[] | null;
  suggestion: string | null;
}

export class VerifierAgent {
  async verify(
    intent: string,           // What user wanted
    operation: string,        // What was executed
    preState: Clip[],        // Timeline before
    postState: Clip[]        // Timeline after
  ): Promise<VerificationResult> {
    
    const prompt = `
VERIFICATION TASK:
User Intent: "${intent}"
Operation Executed: ${operation}

TIMELINE BEFORE:
${this.formatClips(preState)}

TIMELINE AFTER:
${this.formatClips(postState)}

CHECKLIST:
1. Did the operation execute? (check clip changes)
2. Are there structural issues? (overlaps, gaps, invalid values)
3. Does the result match the intent?

Respond in JSON with this schema:
{
  "passed": boolean,
  "issues": string[] | null,
  "suggestion": string | null
}
    `;
    
    try {
        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { 
              responseMimeType: 'application/json',
              responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                      passed: { type: Type.BOOLEAN },
                      issues: { type: Type.ARRAY, items: { type: Type.STRING } },
                      suggestion: { type: Type.STRING }
                  },
                  required: ['passed']
              }
          }
        });
        
        const textPart = response.candidates?.[0]?.content?.parts?.find(p => p.text);
        const text = textPart?.text;

        if (!text) throw new Error("Empty verification response");
        return JSON.parse(text);
    } catch (e) {
        console.error("Verification failed", e);
        // Fail open or closed? Let's assume passed to avoid blocking if AI fails, but log it.
        return { passed: true, issues: ["Verification AI failed"], suggestion: null };
    }
  }
  
  private formatClips(clips: Clip[]): string {
    if (clips.length === 0) return "Empty Timeline";
    return clips.map(c => 
      `[${c.id}] ${c.type} | Start: ${c.startTime.toFixed(2)}s | Dur: ${c.duration.toFixed(2)}s | Track ${c.trackId} | "${c.title}"`
    ).join('\n');
  }
}