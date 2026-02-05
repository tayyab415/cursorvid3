
import { Clip } from '../types';
import { timelineStore } from '../timeline/store';
import { TimelineOps } from '../timeline/operations';
import { generateSpeech, generateVideo, generateImage } from './gemini';
import { TIMELINE_PRIMITIVES } from './timelinePrimitives';

export interface ToolExecutionResult {
    success: boolean;
    message?: string;
    data?: any;
    error?: string;
    clipId?: string;
}

type ToolFunction = (args: any) => Promise<ToolExecutionResult>;

// Helper for safe track assignment
const getSafeTrackId = () => {
    const clips = timelineStore.getClips();
    if (clips.length === 0) return 1;
    return Math.max(...clips.map(c => c.trackId)) + 1;
};

const toolImplementations: Record<string, ToolFunction> = {
    'move_clip': async (args) => {
        TimelineOps.moveClip(timelineStore, args.clipId, Number(args.startTime), Number(args.trackId));
        return { success: true, message: `Moved clip ${args.clipId}` };
    },

    'request_user_assistance': async (args) => {
        // This is a special case handled by the agent loop, but if executed directly:
        return { success: true, message: `Requested user assistance: ${args.message}`, clipId: 'system-request' };
    },

    'update_clip_property': async (args) => {
        TimelineOps.updateClipProperty(timelineStore, args.clipId, args.property, Number(args.value));
        return { success: true, message: `Updated ${args.property} for ${args.clipId}` };
    },

    'ripple_delete': async (args) => {
        TimelineOps.rippleDelete(timelineStore, args.clipId);
        return { success: true, message: `Ripple deleted ${args.clipId}` };
    },

    'smart_trim': async (args) => {
        TimelineOps.trimClip(timelineStore, args.clipId, Number(args.newDuration));
        return { success: true, message: `Trimmed ${args.clipId}` };
    },

    'split_clip': async (args) => {
        TimelineOps.splitClip(timelineStore, args.clipId, Number(args.splitTime));
        return { success: true, message: `Split ${args.clipId}` };
    },

    'apply_visual_transform': async (args) => {
        TimelineOps.updateClipProperty(timelineStore, args.clipId, 'transform', {
            scale: Number(args.scale || 1),
            x: Number(args.x || 0),
            y: Number(args.y || 0),
            rotation: Number(args.rotation || 0)
        });
        return { success: true, message: `Transformed ${args.clipId}` };
    },

    'add_text_overlay': async (args) => {
        const stylePreset = args.style || 'subtitle';
        const isTitle = stylePreset === 'title';
        
        // Base styles based on preset
        const baseStyle = isTitle 
            ? { fontSize: 60, isBold: true, isItalic: false, isUnderline: false, align: 'center', color: '#ffffff', backgroundColor: '#000000', backgroundOpacity: 0.0, fontFamily: 'Plus Jakarta Sans' }
            : { fontSize: 30, isBold: true, isItalic: false, isUnderline: false, align: 'center', color: '#ffffff', backgroundColor: '#000000', backgroundOpacity: 0.6, fontFamily: 'Plus Jakarta Sans' };

        // Apply Brain overrides if provided
        const finalStyle = { ...baseStyle, ...(args.textStyle || {}) };
        
        const textClip: Clip = {
            id: `txt-${Date.now()}`,
            title: args.text.slice(0, 15),
            type: 'text',
            text: args.text,
            startTime: Number(args.startTime),
            duration: Number(args.duration),
            sourceStartTime: 0,
            trackId: 3, // Text usually stays on top
            textStyle: finalStyle as any,
            transform: { x: 0, y: isTitle ? 0 : 0.35, scale: 1, rotation: 0 } 
        };
        TimelineOps.addClip(timelineStore, textClip);
        return { success: true, message: `Added text "${args.text}"`, clipId: textClip.id };
    },

    'generate_voiceover': async (args) => {
        const audioUrl = await generateSpeech(args.text, args.voice || 'Kore');
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
            trackId: args.trackId !== undefined ? Number(args.trackId) : 2,
            volume: 1,
            speed: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        };
        TimelineOps.addClip(timelineStore, newClip);
        return { success: true, message: `Generated voiceover`, clipId: newClip.id };
    },

    'generate_video_asset': async (args) => {
        const videoUrl = await generateVideo(
            args.prompt, 
            args.model || 'veo-3.1-fast-generate-preview',
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
            trackId: args.trackId !== undefined ? Number(args.trackId) : getSafeTrackId(),
            volume: 1,
            speed: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        };
        TimelineOps.addClip(timelineStore, videoClip);
        return { success: true, message: `Generated video`, clipId: videoClip.id };
    },

    'generate_image_asset': async (args) => {
        const base64Img = await generateImage(args.prompt, args.model || 'gemini-2.5-flash-image');
        const imgUrl = `data:image/png;base64,${base64Img}`;
        
        const imgClip: Clip = {
            id: `gen-img-${Date.now()}`,
            title: `Img: ${args.prompt.slice(0, 15)}...`,
            type: 'image',
            startTime: Number(args.insertTime),
            duration: Number(args.duration) || 5,
            sourceStartTime: 0,
            sourceUrl: imgUrl,
            trackId: args.trackId !== undefined ? Number(args.trackId) : getSafeTrackId(),
            transform: { x: 0, y: 0, scale: 1, rotation: 0 }
        };
        TimelineOps.addClip(timelineStore, imgClip);
        return { success: true, message: `Generated image`, clipId: imgClip.id };
    }
};

export const executeTool = async (name: string, args: any): Promise<ToolExecutionResult> => {
    const impl = toolImplementations[name];
    if (!impl) {
        throw new Error(`Tool "${name}" is not implemented in the registry.`);
    }
    return impl(args);
};

export const getToolDescriptions = (): string => {
    return TIMELINE_PRIMITIVES.map(t => `- ${t.name}: ${t.description}`).join('\n');
};
