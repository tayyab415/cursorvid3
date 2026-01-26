
import { Clip, TimelineRange } from '../types';
import { sliceAudioBlob, captureFrameFromVideoUrl } from '../utils/videoUtils';

/**
 * THE GEMINI ADAPTER
 * 
 * Goal: Convert a semantic "TimelineRange" (Editor Truth) into a Multimodal Payload
 * that simulates "Real Video" for Gemini.
 * 
 * Strategy:
 * 1. Audio: Slice real audio buffers (video soul/rhythm).
 * 2. Visuals: Reconstruct the FINAL COMPOSED OUTPUT (including overlays, text, layers).
 *    We do not just send raw source video; we render what the user sees.
 * 3. Text: Describe structural layer data.
 */

// Helper to load image from URL (or base64) into an HTMLImageElement for drawing
const loadImage = (url: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(e);
        img.src = url;
    });
};

// Renders a specific clip onto the given canvas context
// Matches the visual logic of App.tsx
const drawClipToContext = (
    ctx: CanvasRenderingContext2D,
    clip: Clip,
    source: CanvasImageSource | null,
    width: number,
    height: number
) => {
    const transform = clip.transform || { x: 0, y: 0, scale: 1, rotation: 0 };

    ctx.save();
    // Center origin
    ctx.translate(width / 2, height / 2);
    // Apply transforms
    ctx.translate(transform.x * width, transform.y * height);
    ctx.scale(transform.scale, transform.scale);
    ctx.rotate((transform.rotation * Math.PI) / 180);

    if (clip.type === 'text' && clip.text) {
        const style = clip.textStyle || {
            fontFamily: 'Plus Jakarta Sans',
            fontSize: 40,
            isBold: true,
            isItalic: false,
            isUnderline: false,
            color: '#ffffff',
            backgroundColor: '#000000',
            backgroundOpacity: 0,
            align: 'center'
        };

        const fontWeight = style.isBold ? 'bold' : 'normal';
        const fontStyle = style.isItalic ? 'italic' : 'normal';
        // Scale font slightly for high-res analysis context if needed, but 1:1 is usually fine
        ctx.font = `${fontStyle} ${fontWeight} ${style.fontSize}px ${style.fontFamily}, sans-serif`;
        ctx.textAlign = style.align as any || 'center';
        ctx.textBaseline = 'middle';

        const lines = clip.text.split('\n');
        const lineHeight = style.fontSize * 1.2;
        const metrics = ctx.measureText(lines[0]); // Approx width based on first line
        // Background calc
        if (style.backgroundOpacity > 0) {
            const bgWidth = metrics.width + (style.fontSize * 1.5);
            const bgHeight = lineHeight * lines.length + (style.fontSize * 0.5);
            ctx.save();
            ctx.globalAlpha = style.backgroundOpacity;
            ctx.fillStyle = style.backgroundColor;
            ctx.fillRect(-bgWidth/2, -bgHeight/2, bgWidth, bgHeight);
            ctx.restore();
        }

        ctx.fillStyle = style.color;
        lines.forEach((line, i) => {
            const yOffset = (i - (lines.length - 1) / 2) * lineHeight;
            // Stroke for readability
            if (style.backgroundOpacity < 0.5) {
                ctx.strokeStyle = 'black';
                ctx.lineWidth = style.fontSize / 15;
                ctx.strokeText(line, 0, yOffset);
            }
            ctx.fillText(line, 0, yOffset);
            
            if (style.isUnderline) {
                const lineWidth = ctx.measureText(line).width;
                ctx.fillRect(-lineWidth / 2, yOffset + style.fontSize/2, lineWidth, style.fontSize/15);
            }
        });

    } else if (source) {
        // Draw Video Frame or Image
        let srcW = 0, srcH = 0;
        if (source instanceof HTMLVideoElement) {
            srcW = source.videoWidth;
            srcH = source.videoHeight;
        } else if (source instanceof HTMLImageElement) {
            srcW = source.naturalWidth;
            srcH = source.naturalHeight;
        } else if (source instanceof ImageBitmap) {
            srcW = source.width;
            srcH = source.height;
        }

        if (srcW && srcH) {
            const aspectSrc = srcW / srcH;
            const aspectDest = width / height;
            let drawW, drawH;

            // Contain logic (match App.tsx)
            if (aspectSrc > aspectDest) {
                drawW = width;
                drawH = width / aspectSrc;
            } else {
                drawH = height;
                drawW = height * aspectSrc;
            }
            ctx.drawImage(source, -drawW/2, -drawH/2, drawW, drawH);
        }
    }

    ctx.restore();
};

export const rangeToGeminiParts = async (
    range: TimelineRange,
    clips: Clip[], // Full clip list
    mediaRefs: { [key: string]: HTMLVideoElement | HTMLAudioElement | null } // Live refs (unused for offscreen composition usually, but kept for signature)
): Promise<any[]> => {
    const parts: any[] = [];
    
    // 1. CONTEXTUAL METADATA
    const contextDescription = {
        type: "TimelineContext",
        range: `${range.start.toFixed(1)}s to ${range.end.toFixed(1)}s`,
        layers: range.tracks.map(t => ({
            trackId: t.id,
            clips: t.clips.map(c => ({
                type: c.type,
                title: c.title,
                text: c.text
            }))
        }))
    };
    parts.push({ text: `Timeline Metadata: ${JSON.stringify(contextDescription)}` });

    // 2. AUDIO SLICING
    // Extract dominant audio
    const activeAudioVideo = clips.filter(c => 
        c.startTime < range.end && (c.startTime + c.duration) > range.start &&
        (c.type === 'video' || c.type === 'audio')
    );
    const dominantClip = activeAudioVideo.find(c => c.type === 'audio') || activeAudioVideo.find(c => c.type === 'video');

    if (dominantClip && dominantClip.sourceUrl) {
        const intersectionStart = Math.max(range.start, dominantClip.startTime);
        const intersectionEnd = Math.min(range.end, dominantClip.startTime + dominantClip.duration);
        const offsetInClip = intersectionStart - dominantClip.startTime;
        const sourceStart = dominantClip.sourceStartTime + (offsetInClip * (dominantClip.speed || 1));
        
        try {
            const audioBase64 = await sliceAudioBlob(dominantClip.sourceUrl, sourceStart, intersectionEnd - intersectionStart);
            if (audioBase64) {
                parts.push({ inlineData: { mimeType: 'audio/wav', data: audioBase64 } });
                parts.push({ text: `(Audio from: ${dominantClip.title})` });
            }
        } catch (e) {
            console.error("Audio slice failed", e);
        }
    }

    // 3. VISUAL COMPOSITION (The "Visual Truth")
    // We render the ACTUAL composed canvas for keyframes.
    // This allows Gemini to see text overlays, images, and layout.
    
    const duration = range.end - range.start;
    // Capture up to 3 frames depending on duration
    const frameCount = duration > 5 ? 3 : (duration > 2 ? 2 : 1);
    const step = duration / (frameCount + 1);
    
    const sampleTimes: number[] = [];
    for(let i=1; i<=frameCount; i++) {
        sampleTimes.push(range.start + (step * i));
    }

    for (const t of sampleTimes) {
        // Create offscreen canvas for composition
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;

        // Fill background
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Find active clips at time `t`
        const activeClips = clips
            .filter(c => t >= c.startTime && t < c.startTime + c.duration)
            .sort((a, b) => a.trackId - b.trackId); // Draw bottom-up

        for (const clip of activeClips) {
            if (clip.type === 'audio') continue;

            let renderSource: HTMLImageElement | null = null;

            // PREPARE SOURCE
            if (clip.type === 'text') {
                // Text doesn't need a source image, handled in draw
            } 
            else if (clip.type === 'image' && clip.sourceUrl) {
                try {
                    renderSource = await loadImage(clip.sourceUrl);
                } catch (e) { console.warn("Failed to load image for composition", e); }
            } 
            else if (clip.type === 'video' && clip.sourceUrl) {
                // Determine exact source frame timestamp
                const offset = t - clip.startTime;
                const sourceTime = clip.sourceStartTime + (offset * (clip.speed || 1));
                
                try {
                    // Capture raw frame from video file
                    // This is slightly slow but accurate
                    const frameBase64 = await captureFrameFromVideoUrl(clip.sourceUrl, sourceTime);
                    renderSource = await loadImage(frameBase64);
                } catch (e) { console.warn("Failed to capture video frame for composition", e); }
            }

            // DRAW TO CANVAS
            // Only draw if we have a source OR it's a text clip
            if (clip.type === 'text' || renderSource) {
                drawClipToContext(ctx, clip, renderSource, canvas.width, canvas.height);
            }
        }

        // Export Composed Frame
        try {
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7); // 70% quality to save tokens
            const base64 = dataUrl.split(',')[1];
            parts.push({
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64
                }
            });
            parts.push({ text: `[Composed Visual Frame at ${t.toFixed(1)}s]` });
        } catch (e) {
            console.error("Canvas export failed", e);
        }
    }

    return parts;
};
