
import { timelineStore } from '../../timeline/store';
import { TimelineOps } from '../../timeline/operations';
import { generateSpeech, generateVideo, generateImage } from '../gemini'; 
import { Clip } from '../../types';

export interface HandsOutput {
  thought: string;
  success: boolean;
  changes: string[];
  error?: string;
  actionRequired?: { message: string, type: string };
  approvalRequired?: { tool: string, params: any };
}

export class HandsAgent {
  
  // Helper to find a safe track index (top of stack)
  private getSafeTrackId(): number {
      const clips = timelineStore.getClips();
      if (clips.length === 0) return 1;
      const maxTrack = Math.max(...clips.map(c => c.trackId));
      return maxTrack + 1;
  }

  async execute(step: { operation: string, parameters: any, intent: string }): Promise<HandsOutput> {
    const { operation, parameters, intent } = step;
    const changes: string[] = [];
    
    try {
      // Simulate "work" time for UI visibility
      await new Promise(r => setTimeout(r, 600));

      // INTERCEPTION LOGIC FOR GENERATION TOOLS
      if (['generate_video_asset', 'generate_image_asset', 'generate_voiceover'].includes(operation)) {
          // Intelligent Track Assignment Override
          // If the brain didn't specify a track, or specified a potentially occluded one (0 or 1), 
          // let's suggest a safe top track.
          if (!parameters.trackId || parameters.trackId < 2) {
              parameters.trackId = this.getSafeTrackId();
          }

          return {
              thought: `Preparing to generate content (${operation}). Pausing for user approval on parameters.`,
              success: true,
              changes: [],
              approvalRequired: {
                  tool: operation,
                  params: parameters
              }
          };
      }

      switch (operation) {
        case 'move_clip':
          TimelineOps.moveClip(timelineStore, parameters.clipId, Number(parameters.startTime), Number(parameters.trackId));
          changes.push(`Moved ${parameters.clipId} to ${parameters.startTime}s (Track ${parameters.trackId})`);
          break;

        case 'request_user_assistance':
          return {
              thought: `Requesting user help: ${parameters.message}`,
              success: true,
              changes: [],
              actionRequired: { message: parameters.message, type: parameters.actionType }
          };

        case 'update_clip_property':
          TimelineOps.updateClipProperty(
            timelineStore, 
            parameters.clipId, 
            parameters.property, 
            Number(parameters.value)
          );
          changes.push(`Updated ${parameters.clipId}: ${parameters.property} -> ${parameters.value}`);
          break;
          
        case 'ripple_delete':
          TimelineOps.rippleDelete(timelineStore, parameters.clipId);
          changes.push(`Deleted clip ${parameters.clipId} and shifted timeline.`);
          break;
          
        case 'smart_trim':
          TimelineOps.trimClip(timelineStore, parameters.clipId, Number(parameters.newDuration));
          changes.push(`Trimmed ${parameters.clipId} to ${parameters.newDuration}s`);
          break;

        case 'split_clip':
          TimelineOps.splitClip(timelineStore, parameters.clipId, Number(parameters.splitTime));
          changes.push(`Split clip ${parameters.clipId} at ${parameters.splitTime}s`);
          break;

        case 'apply_visual_transform':
          TimelineOps.updateClipProperty(timelineStore, parameters.clipId, 'transform', {
              scale: Number(parameters.scale || 1),
              x: Number(parameters.x || 0),
              y: Number(parameters.y || 0),
              rotation: Number(parameters.rotation || 0)
          });
          changes.push(`Applied transform to ${parameters.clipId}: scale ${parameters.scale}x`);
          break;

        case 'add_text_overlay':
          const stylePreset = parameters.style || 'subtitle';
          const isTitle = stylePreset === 'title';
          
          const textStyle = isTitle 
              ? { fontSize: 60, isBold: true, isItalic: false, isUnderline: false, align: 'center', color: '#ffffff', backgroundColor: '#000000', backgroundOpacity: 0.0, fontFamily: 'Plus Jakarta Sans' }
              : { fontSize: 30, isBold: true, isItalic: false, isUnderline: false, align: 'center', color: '#ffffff', backgroundColor: '#000000', backgroundOpacity: 0.6, fontFamily: 'Plus Jakarta Sans' };
          
          const textClip: Clip = {
              id: `txt-${Date.now()}`,
              title: parameters.text.slice(0, 15),
              type: 'text',
              text: parameters.text,
              startTime: Number(parameters.startTime),
              duration: Number(parameters.duration),
              sourceStartTime: 0,
              trackId: this.getSafeTrackId(), // Always place text on top
              textStyle: textStyle as any,
              transform: { x: 0, y: isTitle ? 0 : 0.35, scale: 1, rotation: 0 } 
          };
          TimelineOps.addClip(timelineStore, textClip);
          changes.push(`Added text "${parameters.text.slice(0, 20)}..." at ${parameters.startTime}s`);
          break;
          
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
      
      return { 
          thought: `Executing: ${intent}`,
          success: true, 
          changes 
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
