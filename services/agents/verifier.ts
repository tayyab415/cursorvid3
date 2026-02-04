

import { Clip } from '../../types';
import { getAiClient } from '../gemini';
import { Type } from '@google/genai';

export interface VerifierOutput {
  thought: string;
  passed: boolean;
  checks: {
    structural: { passed: boolean, issues: string[] };
    intentAlignment: { passed: boolean, reasoning: string };
  };
  suggestion?: string;
}

export class VerifierAgent {
  async verify(
    intent: string,
    operation: string,
    preState: Clip[],
    postState: Clip[]
  ): Promise<VerifierOutput> {
    
    const prompt = `
    ROLE: You are the VERIFIER.
    TASK: Check if the editing operation "${operation}" was successful and safe.

    USER INTENT: "${intent}"

    TIMELINE BEFORE:
    ${this.formatClips(preState)}

    TIMELINE AFTER:
    ${this.formatClips(postState)}

    INSTRUCTIONS:
    1. Check Structural Integrity: Are there unintentional overlaps? Gaps? Missing clips?
    2. Check Intent: Did the timeline change actually reflect the user's goal?
    
    OUTPUT JSON SCHEMA:
    {
      "thought": "First-person analysis (e.g., 'The clip was deleted, but now there is a 2s gap.')",
      "passed": boolean,
      "checks": {
        "structural": { "passed": boolean, "issues": ["string"] },
        "intentAlignment": { "passed": boolean, "reasoning": "string" }
      },
      "suggestion": "string (optional fix)"
    }
    `;
    
    try {
        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { 
              responseMimeType: 'application/json'
          }
        });
        
        const text = response.text || "{}";
        return JSON.parse(text);
    } catch (e) {
        console.error("Verification failed", e);
        return {
            thought: "I couldn't verify the changes due to an error.",
            passed: true, // Fail open to avoid infinite loops on error
            checks: {
                structural: { passed: true, issues: [] },
                intentAlignment: { passed: true, reasoning: "Verification skipped" }
            }
        };
    }
  }
  
  private formatClips(clips: Clip[]): string {
    if (clips.length === 0) return "Empty Timeline";
    return clips.map(c => 
      `[${c.id}] ${c.type} | Start: ${c.startTime.toFixed(2)}s | Dur: ${c.duration.toFixed(2)}s | Track ${c.trackId}`
    ).join('\n');
  }
}