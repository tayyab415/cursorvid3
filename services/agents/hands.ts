
import { executeTool } from '../toolRegistry';
import { timelineStore } from '../../timeline/store';

export interface HandsOutput {
  thought: string;
  success: boolean;
  changes: string[];
  error?: string;
  actionRequired?: { message: string, type: string };
  approvalRequired?: { tool: string, params: any, reasoning?: string };
}

export class HandsAgent {
  
  async execute(step: { operation: string, parameters: any, intent: string }): Promise<HandsOutput> {
    const { operation, parameters, intent } = step;
    
    try {
      // Simulate "work" time for UI visibility
      await new Promise(r => setTimeout(r, 600));

      // INTERCEPTION LOGIC FOR GENERATION TOOLS
      if (['generate_video_asset', 'generate_image_asset', 'generate_voiceover'].includes(operation)) {
          // If the brain specified a track that might be risky (0 or 1), or none, let UI verify.
          // Note: The registry handles defaults, but here we want to ensure the USER sees a safe default in the modal.
          const clips = timelineStore.getClips();
          const safeTrack = clips.length === 0 ? 1 : Math.max(...clips.map(c => c.trackId)) + 1;

          if (parameters.trackId === undefined || parameters.trackId < 2) {
              parameters.trackId = safeTrack;
          }

          return {
              thought: `Preparing to generate content (${operation}). Pausing for user approval on parameters.`,
              success: true,
              changes: [],
              approvalRequired: {
                  tool: operation,
                  params: parameters,
                  reasoning: intent // Pass the reasoning to the UI
              }
          };
      }

      if (operation === 'request_user_assistance') {
           return {
              thought: `Requesting user help: ${parameters.message}`,
              success: true,
              changes: [],
              actionRequired: { message: parameters.message, type: parameters.actionType }
          };
      }

      // Delegate to Registry
      const result = await executeTool(operation, parameters);
      
      if (!result.success) {
          throw new Error(result.error || "Unknown error");
      }

      return { 
          thought: `Executing: ${intent}`,
          success: true, 
          changes: [result.message || `Executed ${operation}`]
      };
      
    } catch (error: any) {
      console.error(`[Hands] Error:`, error);
      return { 
          thought: `Failed to execute: ${intent}`,
          success: false, 
          changes: [], 
          error: error.message 
      };
    }
  }
}
