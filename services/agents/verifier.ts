
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
  remediation?: string; // New field for specific fix instructions
}

export class VerifierAgent {
  async verify(
    intent: string,
    operation: string,
    preState: Clip[],
    postState: Clip[],
    visualEvidence: string[] = []
  ): Promise<VerifierOutput> {
    
    // 1. DETERMINISTIC CHECKS
    const structuralIssues: string[] = [];
    
    // Check for negative durations or NaNs
    postState.forEach(c => {
        if (c.duration <= 0.1) structuralIssues.push(`Clip "${c.title}" is too short (<0.1s).`);
        if (Number.isNaN(c.startTime)) structuralIssues.push(`Clip "${c.title}" has an invalid start time.`);
    });

    // Check for Occlusion (New clips hidden behind others)
    const preIds = new Set(preState.map(c => c.id));
    const newClips = postState.filter(c => !preIds.has(c.id));

    // Get max visual track to understand layering
    const visualClips = postState.filter(c => ['video', 'image', 'text'].includes(c.type || ''));
    
    for (const newClip of newClips) {
        if (['video', 'image', 'text'].includes(newClip.type || '')) {
            // Find clips on HIGHER tracks that overlap
            const occluders = visualClips.filter(c => 
                c.id !== newClip.id && 
                c.trackId > newClip.trackId && 
                Math.max(c.startTime, newClip.startTime) < Math.min(c.startTime + c.duration, newClip.startTime + newClip.duration)
            );

            if (occluders.length > 0) {
                const blockingClip = occluders[0];
                structuralIssues.push(`The new clip "${newClip.title}" is covered by "${blockingClip.title}" on Track ${blockingClip.trackId + 1}.`);
            }
        }
    }

    // CHECK: Audio extending beyond visuals (Blank Screen / "Radio Mode")
    const audioClips = postState.filter(c => c.type === 'audio');
    let audioExceedsVisuals = false;
    
    if (audioClips.length > 0 && visualClips.length > 0) {
        const maxVisualEnd = Math.max(...visualClips.map(c => c.startTime + c.duration));
        const maxAudioEnd = Math.max(...audioClips.map(c => c.startTime + c.duration));
        
        // Allow a small tolerance (0.5s)
        if (maxAudioEnd > maxVisualEnd + 0.5) {
            audioExceedsVisuals = true;
            const diff = (maxAudioEnd - maxVisualEnd).toFixed(1);
            structuralIssues.push(`CRITICAL: The audio continues for ${diff}s after the video ends (Blank Screen).`);
        }
    }

    // NOTE: We do NOT return early here. We pass these findings to the LLM 
    // so it can confirm them visually and provide a unified remediation plan.

    // 2. LLM VERIFICATION (With Visual Evidence if available)
    const prompt = `
    ROLE: You are the VERIFIER.
    TASK: Check if the editing operation "${operation}" was successful and safe.

    USER INTENT: "${intent}"

    TIMELINE BEFORE:
    ${this.formatClips(preState)}

    TIMELINE AFTER:
    ${this.formatClips(postState)}
    
    DETECTED STRUCTURAL ISSUES (Math-based):
    ${structuralIssues.length > 0 ? structuralIssues.map(i => `- ${i}`).join('\n') : "No obvious math errors."}
    
    VISUAL EVIDENCE:
    ${visualEvidence.length > 0 ? `I have attached ${visualEvidence.length} frames recorded from the actual playback. Each frame corresponds to ~1 second of video.` : "No visual playback available."}

    INSTRUCTIONS:
    1. **Visual Confirmation**: Look at the last few frames of the Visual Evidence. If the screen is BLACK but the audio tracks are still active (see Timeline), this is a FAILURE.
    2. **Correlate**: Do the detected structural issues actually look bad in the frames?
    3. **Remediation**: If you find issues, write a specific, natural language command for the "Brain" agent to fix it (e.g., "Extend the last image by 5 seconds to cover the voiceover").
    
    OUTPUT JSON SCHEMA:
    {
      "thought": "First-person analysis. Explicitly mention if you see a black screen in the evidence.",
      "passed": boolean,
      "checks": {
        "structural": { "passed": boolean, "issues": ["string"] },
        "intentAlignment": { "passed": boolean, "reasoning": "string" }
      },
      "suggestion": "string (polite advice)",
      "remediation": "string (imperative command to fix the issue)"
    }
    `;
    
    // Prepare parts
    const parts: any[] = [{ text: prompt }];
    
    // Add visual evidence if present (Sampling to avoid token limits if too many)
    if (visualEvidence.length > 0) {
        // Limit to 20 frames max for bandwidth/token sanity
        const step = Math.ceil(visualEvidence.length / 20);
        for(let i=0; i<visualEvidence.length; i+=step) {
            const b64 = visualEvidence[i].includes(',') ? visualEvidence[i].split(',')[1] : visualEvidence[i];
            parts.push({
                inlineData: { mimeType: 'image/jpeg', data: b64 }
            });
            parts.push({ text: `[Playback Frame at ${i}s]` });
        }
    }

    try {
        const ai = getAiClient();
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: { role: 'user', parts: parts },
          config: { 
              responseMimeType: 'application/json'
          }
        });
        
        const text = response.text || "{}";
        let result = JSON.parse(text);
        
        // Failsafe: If structural issues exist but LLM said passed, override it.
        if (structuralIssues.length > 0 && result.passed) {
            result.passed = false;
            result.checks.structural.passed = false;
            result.checks.structural.issues = [...structuralIssues, ...result.checks.structural.issues];
            if (!result.remediation) {
                result.remediation = "Fix the detected timeline structural errors.";
            }
        }

        return result;

    } catch (e) {
        console.error("Verification failed", e);
        // Fallback return that respects the deterministic checks
        return {
            thought: "I couldn't complete visual verification due to an error, falling back to math checks.",
            passed: structuralIssues.length === 0,
            checks: {
                structural: { passed: structuralIssues.length === 0, issues: structuralIssues },
                intentAlignment: { passed: true, reasoning: "Skipped" }
            },
            suggestion: structuralIssues.length > 0 ? "Check timeline for gaps." : undefined,
            remediation: structuralIssues.length > 0 ? "Fix the timeline gaps or overlaps." : undefined
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
