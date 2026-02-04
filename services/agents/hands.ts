
import { timelineStore } from '../../timeline/store';
import { TimelineOps } from '../../timeline/operations';
import { generateSpeech } from '../gemini'; 
import { Clip } from '../../types';

export interface HandsOutput {
  thought: string;
  success: boolean;
  changes: string[];
  error?: string;
}

export class HandsAgent {
  async execute(step: { operation: string, parameters: any, intent: string }): Promise<HandsOutput> {
    const { operation, parameters, intent } = step;
    const changes: string[] = [];
    
    try {
      // Simulate "work" time for UI visibility
      await new Promise(r => setTimeout(r, 600));

      switch (operation) {
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
              trackId: 3, 
              textStyle: textStyle as any,
              transform: { x: 0, y: isTitle ? 0 : 0.35, scale: 1, rotation: 0 } 
          };
          TimelineOps.addClip(timelineStore, textClip);
          changes.push(`Added text "${parameters.text.slice(0, 20)}..." at ${parameters.startTime}s`);
          break;

        case 'generate_voiceover':
          // Hands can use tools (API calls) but doesn't "think" about content
          const audioUrl = await generateSpeech(parameters.text, 'Kore');
          
          const tempAudio = new Audio(audioUrl);
          await new Promise<void>((resolve) => {
             tempAudio.onloadedmetadata = () => resolve();
             tempAudio.onerror = () => resolve();
          });
          
          const newClip: Clip = {
            id: `vo-${Date.now()}`,
            title: `VO: ${parameters.text.slice(0, 15)}...`,
            type: 'audio',
            startTime: Number(parameters.insertTime),
            duration: tempAudio.duration || 5,
            sourceStartTime: 0,
            sourceUrl: audioUrl,
            trackId: Number(parameters.trackId) || 2,
            volume: 1,
            speed: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
          };
          TimelineOps.addClip(timelineStore, newClip);
          changes.push(`Generated VO: "${parameters.text.slice(0, 20)}..." at ${parameters.insertTime}s`);
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
