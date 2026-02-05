
import { timelineStore } from '../../timeline/store';
import { TimelineOps } from '../../timeline/operations';
import { generateSpeech, generateVideo, generateImage } from '../gemini'; 
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
        case 'move_clip':
          TimelineOps.moveClip(timelineStore, args.clipId, Number(args.startTime), Number(args.trackId));
          break;

        case 'request_user_assistance':
          return { success: true, operation: name, clipId: 'system-request' };

        case 'update_clip_property':
          TimelineOps.updateClipProperty(
            timelineStore, 
            args.clipId, 
            args.property, 
            Number(args.value) 
          );
          break;
          
        case 'ripple_delete':
          TimelineOps.rippleDelete(timelineStore, args.clipId);
          break;
          
        case 'smart_trim':
          TimelineOps.trimClip(timelineStore, args.clipId, Number(args.newDuration));
          break;

        case 'split_clip':
          TimelineOps.splitClip(timelineStore, args.clipId, Number(args.splitTime));
          break;

        case 'apply_visual_transform':
          TimelineOps.updateClipProperty(timelineStore, args.clipId, 'transform', {
              scale: Number(args.scale || 1),
              x: Number(args.x || 0),
              y: Number(args.y || 0),
              rotation: Number(args.rotation || 0)
          });
          break;

        case 'add_text_overlay':
          const stylePreset = args.style || 'subtitle';
          const isTitle = stylePreset === 'title';
          
          const textStyle = isTitle 
              ? { fontSize: 60, isBold: true, isItalic: false, isUnderline: false, align: 'center', color: '#ffffff', backgroundColor: '#000000', backgroundOpacity: 0.0, fontFamily: 'Plus Jakarta Sans' }
              : { fontSize: 30, isBold: true, isItalic: false, isUnderline: false, align: 'center', color: '#ffffff', backgroundColor: '#000000', backgroundOpacity: 0.6, fontFamily: 'Plus Jakarta Sans' };
          
          const textClip: Clip = {
              id: `txt-${Date.now()}`,
              title: args.text.slice(0, 15),
              type: 'text',
              text: args.text,
              startTime: Number(args.startTime),
              duration: Number(args.duration),
              sourceStartTime: 0,
              trackId: 3, 
              textStyle: textStyle as any,
              transform: { x: 0, y: isTitle ? 0 : 0.35, scale: 1, rotation: 0 } 
          };
          TimelineOps.addClip(timelineStore, textClip);
          return { success: true, operation: name, clipId: textClip.id };

        case 'generate_voiceover':
          const audioUrl = await generateSpeech(args.text, 'Kore');
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

        case 'generate_video_asset':
          const videoUrl = await generateVideo(
              args.prompt, 
              'veo-3.1-fast-generate-preview', 
              '16:9', 
              '720p', 
              Number(args.duration) || 4
          );
          
          const videoClip: Clip = {
            id: `gen-vid-${Date.now()}`,
            title: `Veo: ${args.prompt.slice(0, 15)}...`,
            type: 'video',
            startTime: Number(args.insertTime),
            duration: Number(args.duration) || 4,
            sourceStartTime: 0,
            sourceUrl: videoUrl,
            trackId: Number(args.trackId) || 1,
            volume: 1,
            speed: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
          };
          TimelineOps.addClip(timelineStore, videoClip);
          return { success: true, operation: name, clipId: videoClip.id };

        case 'generate_image_asset':
          const base64Img = await generateImage(args.prompt, 'gemini-2.5-flash-image');
          const imgUrl = `data:image/png;base64,${base64Img}`;
          
          const imgClip: Clip = {
            id: `gen-img-${Date.now()}`,
            title: `Img: ${args.prompt.slice(0, 15)}...`,
            type: 'image',
            startTime: Number(args.insertTime),
            duration: Number(args.duration) || 5,
            sourceStartTime: 0,
            sourceUrl: imgUrl,
            trackId: Number(args.trackId) || 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
          };
          TimelineOps.addClip(timelineStore, imgClip);
          return { success: true, operation: name, clipId: imgClip.id };
          
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
