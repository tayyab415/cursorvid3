
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
    
    if (audioClips.length > 0 && visualClips.length > 0) {
        const maxVisualEnd = Math.max(...visualClips.map(c => c.startTime + c.duration));
        const maxAudioEnd = Math.max(...audioClips.map(c => c.startTime + c.duration));
        
        // Allow a small tolerance (0.5s)
        if (maxAudioEnd > maxVisualEnd + 0.5) {
            const diff = (maxAudioEnd - maxVisualEnd).toFixed(1);
            structuralIssues.push(`CRITICAL: The audio continues for ${diff}s after the video ends (Blank Screen).`);
        }
    }

    // CHECK: Overlapping Audio (Clashing Voiceovers)
    // Sort audio clips by start time
    const sortedAudio = [...audioClips].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i < sortedAudio.length - 1; i++) {
        const current = sortedAudio[i];
        const next = sortedAudio[i+1];
        
        const overlapStart = Math.max(current.startTime, next.startTime);
        const overlapEnd = Math.min(current.startTime + current.duration, next.startTime + next.duration);
        const overlapDuration = overlapEnd - overlapStart;

        // If overlap is significant (> 0.5s) and they are likely speech (based on title usually containing VO or Speech or just assumed for safety)
        if (overlapDuration > 0.5) {
             structuralIssues.push(`AUDIO CLASH: Audio clip "${current.title}" overlaps with "${next.title}" by ${overlapDuration.toFixed(1)}s.`);
        }
    }

    // NOTE: We do NOT return early here. We pass these findings to the LLM 
    // so it can confirm them visually and provide a unified remediation plan.

    // 2. LLM VERIFICATION (With Visual Evidence if available)
    const prompt = `
    ROLE: You are the VERIFIER.
    TASK: Check if the editing operation "${operation}" was successful, safe, and SEMANTICALLY CORRECT.

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
    1. **Structural Check**: Review the DETECTED STRUCTURAL ISSUES. If any exist, confirm if they are fatal to the video experience.
    2. **SEMANTIC CHECK (HIGHEST PRIORITY)**: Look at the visual evidence (if provided). Does the ACTUAL CONTENT match what was requested?
       - **QUESTION**: "Does the video content visually represent the user's request?"
       - **EXAMPLE**: If User asked for "dinosaurs" and you see "cats", FAIL IMMEDIATELY.
       - **EXAMPLE**: If User asked for "text overlay" and you see none, FAIL.
       - **EXAMPLE**: If User asked for "high energy" and the frames look static/boring, FAIL.
    3. **Remediation**: If you find issues (structural OR semantic), write a specific, natural language command for the "Brain" agent to fix it.
       - If audio overlaps, suggest moving one clip.
       - If content is wrong, suggest generating new assets.
    
    OUTPUT JSON SCHEMA:
    {
      "thought": "First-person analysis. Critically evaluate if the content matches the intent.",
      "passed": boolean,
      "checks": {
        "structural": { "passed": boolean, "issues": ["string"] },
        "intentAlignment": { "passed": boolean, "reasoning": "string (e.g. 'Visuals do not match request for X')" }
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
            if (visualEvidence[i] && typeof visualEvidence[i] === 'string') {
                const b64 = visualEvidence[i].includes(',') ? visualEvidence[i].split(',')[1] : visualEvidence[i];
                parts.push({
                    inlineData: { mimeType: 'image/jpeg', data: b64 }
                });
                parts.push({ text: `[Playback Frame at ${i}s]` });
            }
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
        let result: any = {};
        
        try {
            result = JSON.parse(text);
        } catch (e) {
            console.warn("Verifier JSON parse error, using fallback structure", e);
        }
        
        // --- SAFEGUARD: Default missing fields to prevent crashes ---
        if (!result.checks) {
            result.checks = {
                structural: { passed: true, issues: [] },
                intentAlignment: { passed: true, reasoning: "Defaulted due to missing LLM output" }
            };
        }
        if (!result.checks.structural) {
            result.checks.structural = { passed: true, issues: [] };
        }
        if (!result.checks.intentAlignment) {
            result.checks.intentAlignment = { passed: true, reasoning: "Defaulted" };
        }
        if (result.passed === undefined) result.passed = true;
        // ------------------------------------------------------------

        // Failsafe: If structural issues exist but LLM said passed, override it.
        if (structuralIssues.length > 0 && result.passed) {
            result.passed = false;
            result.checks.structural.passed = false;
            result.checks.structural.issues = [...structuralIssues, ...(result.checks.structural.issues || [])];
            if (!result.remediation) {
                result.remediation = `Fix the detected timeline errors: ${structuralIssues.join(', ')}`;
            }
        }

        return result as VerifierOutput;

    } catch (e) {
        console.error("Verification failed", e);
        // Fallback return that respects the deterministic checks
        return {
            thought: "I couldn't complete visual verification due to an error, falling back to math checks.",
            passed: structuralIssues.length === 0,
            checks: {
                structural: { passed: structuralIssues.length === 0, issues: structuralIssues },
                intentAlignment: { passed: true, reasoning: "Skipped due to API error" }
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
