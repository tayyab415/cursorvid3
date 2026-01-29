
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Timeline } from './components/Timeline';
import { CanvasControls } from './components/CanvasControls';
import { AIAssistant } from './components/sidebar/AIAssistant';
import { Clip, ChatMessage, Suggestion, ToolAction } from './types';
import { analyzeVideoFrames, suggestEdits, generateImage, generateVideo, generateSpeech, generateSubtitles, chatWithGemini, generateRefinement, determinePlacement } from './services/gemini';
import { extractFramesFromVideo, captureFrameFromVideoUrl, extractAudioFromVideo } from './utils/videoUtils';
import { Video, Wand2, Play, Pause, Loader2, Upload, MessageSquare, RotateCcw, RotateCw, Sparkles, ArrowRight, Scissors, Maximize2, Gauge, ChevronUp, ChevronRight, ChevronLeft, Download, Volume2, VolumeX, X, Image as ImageIcon, Music, Film, Mic, Camera, Trash2, Info, ArrowLeftRight, FileAudio, Captions, Type, Bold, Italic, Underline, Palette, AlignCenter, AlignLeft, AlignRight, Check, Clock, RefreshCcw, GripVertical } from 'lucide-react';
import * as Mp4Muxer from 'mp4-muxer';

// ... (Rest of imports and constants same as before)
const INITIAL_CLIPS: Clip[] = [
  { id: 'c1', title: 'Intro Scene', duration: 5, startTime: 0, sourceStartTime: 0, type: 'video', totalDuration: 60, trackId: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 },
  { id: 'c2', title: 'Main Action', duration: 8, startTime: 5, sourceStartTime: 5, type: 'video', totalDuration: 60, trackId: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 },
];

const DEFAULT_TEXT_STYLE = {
    fontFamily: 'Plus Jakarta Sans',
    fontSize: 40,
    isBold: true,
    isItalic: false,
    isUnderline: false,
    color: '#ffffff',
    backgroundColor: '#000000',
    backgroundOpacity: 0.0,
    align: 'center' as const
};

interface HistoryState {
  past: Clip[][];
  present: Clip[];
  future: Clip[][];
}

const MarkdownText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return (
    <span className="leading-relaxed">
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="font-bold text-white/90">{part.slice(2, -2)}</strong>;
        }
        return part;
      })}
    </span>
  );
};

const drawClipToCanvas = (
    ctx: CanvasRenderingContext2D, 
    clip: Clip, 
    source: CanvasImageSource | null, 
    containerW: number, 
    containerH: number
) => {
    const transform = clip.transform || { x: 0, y: 0, scale: 1, rotation: 0 };
    ctx.save();
    ctx.translate(containerW / 2, containerH / 2);
    ctx.translate(transform.x * containerW, transform.y * containerH);
    ctx.scale(transform.scale, transform.scale);
    ctx.rotate((transform.rotation * Math.PI) / 180);

    if (clip.type === 'text' && clip.text) {
        const style = clip.textStyle || DEFAULT_TEXT_STYLE;
        const fontWeight = style.isBold ? 'bold' : 'normal';
        const fontStyle = style.isItalic ? 'italic' : 'normal';
        
        ctx.font = `${fontStyle} ${fontWeight} ${style.fontSize}px ${style.fontFamily || 'Plus Jakarta Sans'}, sans-serif`;
        ctx.textAlign = style.align || 'center';
        ctx.textBaseline = 'middle';
        
        const lines = clip.text.split('\n');
        const metrics = ctx.measureText(lines[0]); 
        const lineHeight = style.fontSize * 1.2;
        const bgWidth = metrics.width + (style.fontSize * 0.5);
        const bgHeight = lineHeight * lines.length + (style.fontSize * 0.2);

        if (style.backgroundOpacity > 0) {
            const prevAlpha = ctx.globalAlpha;
            ctx.globalAlpha = style.backgroundOpacity;
            ctx.fillStyle = style.backgroundColor;
            ctx.fillRect(-bgWidth/2, -bgHeight/2, bgWidth, bgHeight);
            ctx.globalAlpha = prevAlpha;
        }

        ctx.fillStyle = style.color;
        lines.forEach((line, i) => {
            const yOffset = (i - (lines.length - 1) / 2) * lineHeight;
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
      let srcW = 0, srcH = 0;
      if (source instanceof HTMLVideoElement) { srcW = source.videoWidth; srcH = source.videoHeight; } 
      else if (source instanceof HTMLImageElement) { srcW = source.naturalWidth; srcH = source.naturalHeight; }

      if (srcW && srcH) {
          const aspectSrc = srcW / srcH;
          const aspectDest = containerW / containerH;
          let drawW, drawH;
          if (aspectSrc > aspectDest) { drawW = containerW; drawH = containerW / aspectSrc; } 
          else { drawH = containerH; drawW = containerH * aspectSrc; }
          ctx.drawImage(source, -drawW/2, -drawH/2, drawW, drawH);
      }
    }
    ctx.restore();
};

const RangeEditorModal = ({ 
    isOpen, 
    onClose, 
    onConfirm, 
    initialRange,
    clips,
    mediaRefs
}: { 
    isOpen: boolean; 
    onClose: () => void; 
    onConfirm: (range: { start: number, end: number }) => void;
    initialRange: { start: number, end: number };
    clips: Clip[];
    mediaRefs: React.MutableRefObject<{[key: string]: HTMLVideoElement | HTMLAudioElement | null}>;
}) => {
    const [range, setRange] = useState(initialRange);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const [isPlaying, setIsPlaying] = useState(true);
    // Find max duration from clips for slider context
    const duration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 10);
    const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
    const playbackTimeRef = useRef(initialRange.start);

    useEffect(() => {
        setRange(initialRange);
        playbackTimeRef.current = initialRange.start;
    }, [initialRange, isOpen]);

    // Playback & Sync Loop
    useEffect(() => {
        if (!isOpen) return;
        
        let animationFrameId: number;
        let lastTime = performance.now();

        const loop = (time: number) => {
            const dt = (time - lastTime) / 1000;
            lastTime = time;

            if (isPlaying) {
                playbackTimeRef.current += dt;
                // Loop Logic
                if (playbackTimeRef.current >= range.end) {
                    playbackTimeRef.current = range.start;
                }
            }

            const currentT = playbackTimeRef.current;
            const visibleClipIds = new Set<string>();

            // 1. Media Sync Loop (Video & Audio)
            clips.forEach(clip => {
                 const isVisible = currentT >= clip.startTime && currentT < clip.startTime + clip.duration;
                 if (isVisible) visibleClipIds.add(clip.id);

                 if (clip.type === 'video' || clip.type === 'audio') {
                     const el = mediaRefs.current[clip.id];
                     if (el) {
                         if (isVisible) {
                             const offset = currentT - clip.startTime;
                             const mediaTime = clip.sourceStartTime + offset * (clip.speed || 1);
                             
                             const tolerance = clip.type === 'audio' ? 0.15 : 0.1;
                             if (Math.abs(el.currentTime - mediaTime) > tolerance) {
                                 el.currentTime = mediaTime;
                             }
                             
                             el.muted = false;
                             const vol = clip.volume ?? 1;
                             if (Math.abs(el.volume - vol) > 0.01) el.volume = vol;
                             
                             if (isPlaying && el.paused) el.play().catch(() => {});
                             else if (!isPlaying && !el.paused) el.pause();
                         } else {
                             if (!el.paused) el.pause();
                             if (!el.muted) el.muted = true;
                         }
                     }
                 }
            });
            
            // 2. Draw Composition
            if (canvasRef.current) {
                const ctx = canvasRef.current.getContext('2d');
                if (ctx) {
                    const width = canvasRef.current.width;
                    const height = canvasRef.current.height;
                    ctx.clearRect(0, 0, width, height);
                    ctx.fillStyle = '#000000';
                    ctx.fillRect(0, 0, width, height);

                    const visibleClips = clips
                        .filter(c => visibleClipIds.has(c.id))
                        .sort((a, b) => a.trackId - b.trackId);

                    visibleClips.forEach(clip => {
                        if (clip.type === 'audio') return;
                        if (clip.type === 'text') {
                            drawClipToCanvas(ctx, clip, null, width, height);
                        } else {
                            let source: CanvasImageSource | null = null;
                            if (clip.type === 'video') {
                                const el = mediaRefs.current[clip.id] as HTMLVideoElement;
                                if (el) source = el;
                            } else if (clip.type === 'image') {
                                const el = mediaRefs.current[clip.id] as unknown as HTMLImageElement;
                                if (el && el.complete) {
                                    source = el;
                                } else if (clip.sourceUrl) {
                                    const img = new Image();
                                    img.src = clip.sourceUrl;
                                    if (img.complete) source = img;
                                }
                            }
                            if (source) drawClipToCanvas(ctx, clip, source, width, height);
                        }
                    });
                }
            }

            animationFrameId = requestAnimationFrame(loop);
        };

        animationFrameId = requestAnimationFrame(loop);
        
        return () => {
             cancelAnimationFrame(animationFrameId);
             clips.forEach(clip => {
                 if (clip.type === 'video' || clip.type === 'audio') {
                     const el = mediaRefs.current[clip.id] as HTMLMediaElement | null;
                     if (el) { el.pause(); el.muted = true; }
                 }
             });
        };
    }, [isOpen, isPlaying, range, clips, mediaRefs]);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!dragging || !trackRef.current) return;
            e.preventDefault();
            const rect = trackRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            const time = percentage * duration;

            if (dragging === 'start') {
                const newStart = Math.min(time, range.end - 0.5);
                setRange(prev => ({ ...prev, start: newStart }));
                playbackTimeRef.current = newStart;
            } else {
                const newEnd = Math.max(time, range.start + 0.5);
                setRange(prev => ({ ...prev, end: newEnd }));
                playbackTimeRef.current = Math.max(range.start, Math.min(playbackTimeRef.current, newEnd));
            }
        };

        const handleMouseUp = () => setDragging(null);

        if (dragging) {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [dragging, duration, range]);

    if (!isOpen) return null;

    const loopDuration = Math.max(0, range.end - range.start);
    const startPct = (range.start / duration) * 100;
    const endPct = (range.end / duration) * 100;
    const widthPct = endPct - startPct;
    const formatTime = (t: number) => t.toFixed(2) + 's';

    return (
        <div className="fixed inset-0 z-[700] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col">
                <div className="p-4 border-b border-neutral-800 bg-neutral-950 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Scissors className="w-4 h-4 text-yellow-500" />
                        <h3 className="text-sm font-bold text-white uppercase tracking-wide">Refine Selection</h3>
                    </div>
                    <button onClick={onClose} className="text-neutral-500 hover:text-white"><X size={18} /></button>
                </div>
                <div className="aspect-video bg-black relative flex items-center justify-center border-b border-neutral-800">
                    <canvas ref={canvasRef} width={1280} height={720} className="w-full h-full object-contain" />
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-neutral-900/80 backdrop-blur border border-neutral-700 rounded-full px-4 py-1.5 flex items-center gap-3">
                        <button onClick={() => setIsPlaying(p => !p)}>{isPlaying ? <Pause size={14} className="fill-white" /> : <Play size={14} className="fill-white" />}</button>
                        <div className="w-px h-3 bg-neutral-700" />
                        <span className="text-xs font-mono text-yellow-400 font-bold">{loopDuration.toFixed(1)}s Loop</span>
                    </div>
                </div>
                <div className="p-8 bg-neutral-900 select-none">
                    <div className="relative h-12 w-full" ref={trackRef}>
                        <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-2 bg-neutral-800 rounded-full overflow-hidden"><div className="h-full bg-neutral-700 w-full" /></div>
                        <div className="absolute top-1/2 -translate-y-1/2 h-2 bg-yellow-500/50" style={{ left: `${startPct}%`, width: `${widthPct}%` }} />
                        <div className="absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize group z-10" style={{ left: `${startPct}%` }} onMouseDown={() => setDragging('start')}>
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full mb-1 bg-neutral-800 text-white text-[10px] font-mono px-1.5 py-0.5 rounded border border-neutral-700 whitespace-nowrap">{formatTime(range.start)}</div>
                            <div className="h-full w-1 bg-yellow-500 mx-auto rounded-full group-hover:w-1.5 transition-all shadow-[0_0_10px_rgba(234,179,8,0.5)]" />
                        </div>
                        <div className="absolute top-0 bottom-0 w-4 -ml-2 cursor-ew-resize group z-10" style={{ left: `${endPct}%` }} onMouseDown={() => setDragging('end')}>
                            <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full mb-1 bg-neutral-800 text-white text-[10px] font-mono px-1.5 py-0.5 rounded border border-neutral-700 whitespace-nowrap">{formatTime(range.end)}</div>
                            <div className="h-full w-1 bg-yellow-500 mx-auto rounded-full group-hover:w-1.5 transition-all shadow-[0_0_10px_rgba(234,179,8,0.5)]" />
                        </div>
                    </div>
                    <div className="flex justify-between mt-2 text-[10px] text-neutral-500 font-mono uppercase"><span>0.00s</span><span>{formatTime(duration)}</span></div>
                </div>
                <div className="p-4 border-t border-neutral-800 bg-neutral-950 flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-xs font-bold text-neutral-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={() => onConfirm(range)} className="px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold rounded-lg shadow-lg flex items-center gap-2 transition-transform active:scale-95"><Check size={14} strokeWidth={3} /> Confirm Selection</button>
                </div>
            </div>
        </div>
    );
};

const GeminiLogo = ({ className = "w-6 h-6" }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
        <path d="M16 3C16 3 16.0375 8.525 21.0625 10.9375C16.0375 13.35 16 19 16 19C16 19 15.9625 13.35 11 11C15.9625 8.525 16 3 16 3Z" fill="url(#gemini-gradient)" />
        <path d="M4 11C4 11 4.5 13.5 7 14.5C4.5 15.5 4 18 4 18C4 18 3.5 15.5 1 14.5C3.5 13.5 4 11 4 11Z" fill="url(#gemini-gradient)" />
        <defs>
            <linearGradient id="gemini-gradient" x1="1" y1="3" x2="21" y2="19" gradientUnits="userSpaceOnUse">
                <stop stopColor="#4E75F6" />
                <stop offset="1" stopColor="#E93F33" />
            </linearGradient>
        </defs>
    </svg>
);

const TextControls = ({ values, onChange }: { values: any, onChange: (updates: any) => void }) => {
    return (
        <div className="space-y-3">
             <div className="grid grid-cols-2 gap-2">
                 <div>
                     <label className="text-[10px] text-neutral-500 mb-1 block">Font</label>
                     <select value={values.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })} className="w-full bg-neutral-900 border border-neutral-700 rounded p-1 text-xs focus:border-blue-500 outline-none text-white">
                         <option value="Plus Jakarta Sans">Sans Serif</option>
                         <option value="serif">Serif</option>
                         <option value="monospace">Monospace</option>
                         <option value="cursive">Handwritten</option>
                     </select>
                 </div>
                 <div>
                     <label className="text-[10px] text-neutral-500 mb-1 block">Size</label>
                     <input type="number" value={values.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })} className="w-full bg-neutral-900 border border-neutral-700 rounded p-1 text-xs focus:border-blue-500 outline-none text-white" />
                 </div>
             </div>
             <div className="flex items-center justify-between border-y border-neutral-700/50 py-2">
                 <div className="flex bg-neutral-900 rounded border border-neutral-700 p-0.5">
                     <button onClick={() => onChange({ isBold: !values.isBold })} className={`p-1.5 rounded transition-colors ${values.isBold ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'}`}><Bold size={12} /></button>
                     <button onClick={() => onChange({ isItalic: !values.isItalic })} className={`p-1.5 rounded transition-colors ${values.isItalic ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'}`}><Italic size={12} /></button>
                     <button onClick={() => onChange({ isUnderline: !values.isUnderline })} className={`p-1.5 rounded transition-colors ${values.isUnderline ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'}`}><Underline size={12} /></button>
                 </div>
                 <div className="flex bg-neutral-900 rounded border border-neutral-700 p-0.5">
                     <button onClick={() => onChange({ align: 'left' })} className={`p-1.5 rounded transition-colors ${values.align === 'left' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'}`}><AlignLeft size={12} /></button>
                     <button onClick={() => onChange({ align: 'center' })} className={`p-1.5 rounded transition-colors ${values.align === 'center' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'}`}><AlignCenter size={12} /></button>
                     <button onClick={() => onChange({ align: 'right' })} className={`p-1.5 rounded transition-colors ${values.align === 'right' ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-white'}`}><AlignRight size={12} /></button>
                 </div>
             </div>
             <div>
                  <label className="text-[10px] text-neutral-500 mb-1 block">Color</label>
                  <div className="flex items-center gap-2">
                      <input type="color" value={values.color} onChange={(e) => onChange({ color: e.target.value })} className="w-6 h-6 rounded cursor-pointer border-none p-0 bg-transparent" />
                      <input type="text" value={values.color} onChange={(e) => onChange({ color: e.target.value })} className="flex-1 bg-neutral-900 border border-neutral-700 rounded p-1 text-xs font-mono uppercase focus:border-blue-500 outline-none text-white" />
                  </div>
             </div>
              <div>
                  <label className="text-[10px] text-neutral-500 mb-1 block">Background</label>
                  <div className="flex items-center gap-2 mb-1">
                      <input type="color" value={values.backgroundColor} onChange={(e) => onChange({ backgroundColor: e.target.value })} className="w-6 h-6 rounded cursor-pointer border-none p-0 bg-transparent" />
                       <input type="range" min="0" max="1" step="0.1" value={values.backgroundOpacity} onChange={(e) => onChange({ backgroundOpacity: parseFloat(e.target.value) })} className="flex-1 h-1.5 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500" />
                  </div>
             </div>
        </div>
    );
};

export default function App() {
  const [tracks, setTracks] = useState<number[]>([0, 1, 2, 3]);

  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: INITIAL_CLIPS,
    future: []
  });
  
  const clips = history.present;
  const clipsRef = useRef(clips);
  
  // Keep ref in sync so AI assistant can verify immediately after state update
  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const clipboardRef = useRef<Clip[]>([]);
  
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isCustomSpeed, setIsCustomSpeed] = useState(false);
  const [showVolumeMenu, setShowVolumeMenu] = useState(false);
  const [showTextStyleMenu, setShowTextStyleMenu] = useState(false);

  const [captionStyle, setCaptionStyle] = useState(DEFAULT_TEXT_STYLE);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'model', text: 'Hello! I am your AI assistant. Upload a video and I can analyze its content, mood, and key events for you.' }
  ]);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const togglePlay = useCallback(() => setIsPlaying(p => !p), []);

  const [currentTime, setCurrentTime] = useState(0); 
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  const [mediaModalTrackId, setMediaModalTrackId] = useState<number | null>(null);
  const [modalMode, setModalMode] = useState<'initial' | 'generate'>('initial');
  const [genTab, setGenTab] = useState<'image' | 'video' | 'audio'>('image');
  
  const [captionModalOpen, setCaptionModalOpen] = useState(false);
  
  const [isSelectingScope, setIsSelectingScope] = useState(false);
  const [liveScopeRange, setLiveScopeRange] = useState<{start: number, end: number} | null>(null);
  const [rangeModalOpen, setRangeModalOpen] = useState(false);

  const [transitionModal, setTransitionModal] = useState<{
      active: boolean; clipA: Clip | null; clipB: Clip | null;
      startFrame: string | null; endFrame: string | null; prompt: string;
      model: string; resolution: '720p' | '1080p' | '4k'; duration: '4' | '8';
  }>({
      active: false, clipA: null, clipB: null, startFrame: null, endFrame: null,
      prompt: "Smooth cinematic transition between these two shots",
      model: 'veo-3.1-fast-generate-preview', resolution: '720p', duration: '8' 
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [imgModel, setImgModel] = useState<'gemini-2.5-flash-image' | 'gemini-3-pro-image-preview'>('gemini-2.5-flash-image');
  const [imgAspect, setImgAspect] = useState('16:9');
  
  const [vidModel, setVidModel] = useState<string>('veo-3.1-fast-generate-preview');
  const [vidResolution, setVidResolution] = useState<'720p' | '1080p' | '4k'>('720p');
  const [vidAspect, setVidAspect] = useState('16:9');
  const [vidDuration, setVidDuration] = useState<'4' | '8'>('4');
  const [veoStartImg, setVeoStartImg] = useState<string | null>(null);
  const [veoEndImg, setVeoEndImg] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<'start'|'end'>('start');

  const [audioVoice, setAudioVoice] = useState('Kore');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null); 
  const canvasRef = useRef<HTMLCanvasElement>(null); 
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceImageInputRef = useRef<HTMLInputElement>(null);
  const mediaRefs = useRef<{[key: string]: HTMLVideoElement | HTMLAudioElement | null}>({});
  const currentTimeRef = useRef(currentTime);

  const selectedClips = clips.filter(c => selectedClipIds.includes(c.id));
  const primarySelectedClip = selectedClips.length > 0 ? selectedClips[selectedClips.length - 1] : null;
  const isMultiSelection = selectedClipIds.length > 1;
  const allSelectedAreText = selectedClips.length > 0 && selectedClips.every(c => c.type === 'text');
  const allSelectedAreMedia = selectedClips.length > 0 && selectedClips.every(c => ['video', 'audio', 'image'].includes(c.type || ''));
  const isSelectedClipVisible = primarySelectedClip ? (currentTime >= primarySelectedClip.startTime && currentTime < primarySelectedClip.startTime + primarySelectedClip.duration) : false;
  const availableVideo = clips.find(c => c.type === 'video');

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  
  const veoModeLabel = veoStartImg && veoEndImg ? 'Morph Mode' : veoStartImg ? 'Image-to-Video' : 'Text-to-Video';
  const veoModeColor = veoStartImg && veoEndImg ? 'text-purple-300 bg-purple-900/50 border-purple-500/50' : veoStartImg ? 'text-blue-300 bg-blue-900/50 border-blue-500/50' : 'text-neutral-400 bg-neutral-800 border-neutral-700';

  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const isHighRes = vidResolution === '1080p' || vidResolution === '4k';
    const hasRefImages = !!veoStartImg || !!veoEndImg;
    if (isHighRes || hasRefImages) { if (vidDuration !== '8') setVidDuration('8'); }
  }, [vidResolution, veoStartImg, veoEndImg, vidDuration]);

  // --- PLAYBACK LOGIC ---
  useEffect(() => {
    let animationFrameId: number;
    let lastTimestamp = performance.now();

    const updateLoop = (timestamp: number) => {
      const dt = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;

      if (isPlaying) {
        setCurrentTime((prevTime) => {
           const newTime = prevTime + dt;
           // Auto-stop at end of timeline (with a buffer)
           const maxDuration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 0) + 1;
           if (newTime > maxDuration) {
               setIsPlaying(false);
               return 0; // Or keep at maxDuration
           }
           return newTime;
        });
      }
      
      animationFrameId = requestAnimationFrame(updateLoop);
    };

    if (isPlaying) {
        lastTimestamp = performance.now(); // Reset timestamp on start
        animationFrameId = requestAnimationFrame(updateLoop);
    } else {
        // Pause all media when stopped
        Object.values(mediaRefs.current).forEach((el) => {
             const mediaEl = el as HTMLMediaElement | null;
             mediaEl?.pause();
        });
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [isPlaying, clips]);

  // --- MEDIA SYNC LOGIC ---
  useEffect(() => {
      clips.forEach(clip => {
          if (clip.type !== 'video' && clip.type !== 'audio') return;
          const mediaEl = mediaRefs.current[clip.id];
          if (!mediaEl) return;

          // Check if clip is active at current time
          const isActive = currentTime >= clip.startTime && currentTime < (clip.startTime + clip.duration);

          if (isActive) {
              const relativeTime = currentTime - clip.startTime;
              const targetTime = clip.sourceStartTime + (relativeTime * (clip.speed || 1));
              
              // Drift correction: only seek if desynced by > 0.25s
              if (Math.abs(mediaEl.currentTime - targetTime) > 0.25) {
                  mediaEl.currentTime = targetTime;
              }

              if (isPlaying) {
                  if (mediaEl.paused)