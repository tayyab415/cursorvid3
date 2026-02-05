
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
    
    // 1. DETERMINISTIC CHECKS
    const structuralIssues: string[] = [];
    
    // Check for negative durations or NaNs
    postState.forEach(c => {
        if (c.duration <= 0.1) structuralIssues.push(`Clip "${c.title}" is too short (<0.1s).`);
        if (Number.isNaN(c.startTime)) structuralIssues.push(`Clip "${c.title}" has an invalid start time.`);
    });

    // Check for Occlusion (New clips hidden behind others)
    // Identify new clips
    const preIds = new Set(preState.map(c => c.id));
    const newClips = postState.filter(c => !preIds.has(c.id));

    for (const newClip of newClips) {
        if (['video', 'image', 'text'].includes(newClip.type || '')) {
            // Find clips on HIGHER tracks that overlap
            const occluders = postState.filter(c => 
                c.id !== newClip.id && 
                c.trackId > newClip.trackId && 
                ['video', 'image', 'text'].includes(c.type || '') &&
                Math.max(c.startTime, newClip.startTime) < Math.min(c.startTime + c.duration, newClip.startTime + newClip.duration)
            );

            if (occluders.length > 0) {
                // Simplified message
                const blockingClip = occluders[0];
                structuralIssues.push(`The new clip "${newClip.title}" is covered by "${blockingClip.title}" on Track ${blockingClip.trackId + 1}.`);
            }
        }
    }

    if (structuralIssues.length > 0) {
        return {
            thought: "I found structural issues with the timeline layout.",
            passed: false,
            checks: {
                structural: { passed: false, issues: structuralIssues },
                intentAlignment: { passed: false, reasoning: "Structural failure prevents intent check." }
            },
            suggestion: "Move the new clip to a higher track or clear the space."
        };
    }

    // 2. LLM VERIFICATION
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
            passed: false, // FAIL SAFE: If we can't verify, we shouldn't blindly trust.
            checks: {
                structural: { passed: false, issues: ["Verification system error"] },
                intentAlignment: { passed: false, reasoning: "Verification skipped due to error" }
            }
        };
    }
  }
  
  private formatClips(clips: Clip[]): string {
    if (clips.length === 0) return "Empty Timeline";
    return clips.map(c => 
      `[${c.id}] ${c.type} | Start: ${c.startTime.toFixed(2)}s | Dur: ${c.duration.toFixed(2)}s | Track ${c.trackId} | Title: "${c.title}"`
    ).join('\n');
  }
}
