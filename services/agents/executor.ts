import { timelineStore } from '../../timeline/store';
import { TimelineOps } from '../../timeline/operations';
import { generateSpeech } from '../gemini'; 
import { Clip } from '../../types';

interface ExecutionResult {
  success: boolean;
  operation: string;
  clipId?: string;
  error?: string;
}

export class ExecutorAgent {
  async execute(functionCall: { name: string; args: any }): Promise<ExecutionResult> {
    const { name, args } = functionCall;
    
    try {
      console.log(`[Executor] Running ${name}`, args);

      switch (name) {
        case 'update_clip_property':
          TimelineOps.updateClipProperty(
            timelineStore, 
            args.clipId, 
            args.property, 
            Number(args.value) // Ensure value is number if supposed to be
          );
          break;
          
        case 'ripple_delete':
          TimelineOps.rippleDelete(timelineStore, args.clipId);
          break;
          
        case 'smart_trim':
          TimelineOps.trimClip(timelineStore, args.clipId, Number(args.newDuration));
          break;

        case 'generate_voiceover':
          const audioUrl = await generateSpeech(args.text, 'Kore');
          // Create a temp audio element to get duration
          const tempAudio = new Audio(audioUrl);
          await new Promise<void>((resolve) => {
             tempAudio.onloadedmetadata = () => resolve();
             tempAudio.onerror = () => resolve();
          });
          
          const newClip: Clip = {
            id: `vo-${Date.now()}`,
            title: `VO: ${args.text.slice(0, 15)}...`,
            type: 'audio',
            startTime: Number(args.insertTime),
            duration: tempAudio.duration || 5,
            sourceStartTime: 0,
            sourceUrl: audioUrl,
            trackId: Number(args.trackId) || 2,
            volume: 1,
            speed: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
          };
          TimelineOps.addClip(timelineStore, newClip);
          return { success: true, operation: name, clipId: newClip.id };
          
        default:
          throw new Error(`Unknown operation: ${name}`);
      }
      
      return { success: true, operation: name, clipId: args.clipId };
      
    } catch (error: any) {
      console.error(`[Executor] Error:`, error);
      return { success: false, operation: name, error: error.message };
    }
  }
}
