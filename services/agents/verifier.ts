

import { Clip } from '../../types';
import { getAiClient } from '../gemini';
import { Type } from '@google/genai';
import { AGENT_POLICY } from './agentPolicy';

export interface VerifierOutput {
  thought: string;
  passed: boolean;
  status?: 'pass' | 'fail' | 'unknown';
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
          model: AGENT_POLICY.defaults.models.verifier,
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
            passed: false,
            status: 'unknown',
            checks: {
                structural: { passed: false, issues: ['Verifier unavailable'] },
                intentAlignment: { passed: false, reasoning: "Verification skipped because verifier errored" }
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