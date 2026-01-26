
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Timeline } from './components/Timeline';
import { CanvasControls } from './components/CanvasControls';
import { AIAssistant } from './components/sidebar/AIAssistant';
import { Clip, ChatMessage, Suggestion } from './types';
import { analyzeVideoFrames, suggestEdits, generateImage, generateVideo, generateSpeech, generateSubtitles, chatWithGemini } from './services/gemini';
import { extractFramesFromVideo, captureFrameFromVideoUrl, extractAudioFromVideo } from './utils/videoUtils';
import { Video, Wand2, Play, Pause, Loader2, Upload, MessageSquare, RotateCcw, RotateCw, Sparkles, ArrowRight, Scissors, Maximize2, Gauge, ChevronUp, ChevronRight, ChevronLeft, Download, Volume2, VolumeX, X, Image as ImageIcon, Music, Film, Mic, Camera, Trash2, Info, ArrowLeftRight, FileAudio, Captions, Type, Bold, Italic, Underline, Palette, AlignCenter, AlignLeft, AlignRight, Check, Clock, RefreshCcw, GripVertical } from 'lucide-react';
import * as Mp4Muxer from 'mp4-muxer';

// Initialize with defaults
const INITIAL_CLIPS: Clip[] = [
  { id: 'c1', title: 'Intro Scene', duration: 5, startTime: 0, sourceStartTime: 0, type: 'video', totalDuration: 60, trackId: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 },
  { id: 'c2', title: 'Main Action', duration: 8, startTime: 5, sourceStartTime: 5, type: 'video', totalDuration: 60, trackId: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 },
];

const DEFAULT_TEXT_STYLE = {
    fontFamily: 'Plus Jakarta Sans',
    fontSize: 10,
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

// --- DRAWING HELPER (Moved outside for shared use) ---
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

// --- RANGE EDITOR MODAL COMPONENT ---
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
                     const el = mediaRefs.current[clip.id];
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
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [hasAnalyzed, setHasAnalyzed] = useState(false);
  const clipboardRef = useRef<Clip[]>([]);
  
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isCustomSpeed, setIsCustomSpeed] = useState(false);
  const [customSpeedText, setCustomSpeedText] = useState('');
  const [showVolumeMenu, setShowVolumeMenu] = useState(false);
  const [showTextStyleMenu, setShowTextStyleMenu] = useState(false);

  const [captionStyle, setCaptionStyle] = useState(DEFAULT_TEXT_STYLE);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'model', text: 'Hello! I am your AI assistant. Upload a video and I can analyze its content, mood, and key events for you.' }
  ]);
  const [inputText, setInputText] = useState('');
  
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

  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const isHighRes = vidResolution === '1080p' || vidResolution === '4k';
    const hasRefImages = !!veoStartImg || !!veoEndImg;
    if (isHighRes || hasRefImages) { if (vidDuration !== '8') setVidDuration('8'); }
  }, [vidResolution, veoStartImg, veoEndImg, vidDuration]);

  // --- KEYBOARD SHORTCUTS ---
  const handleUndo = useCallback(() => { setHistory(curr => { if (curr.past.length === 0) return curr; const previous = curr.past[curr.past.length - 1]; const newPast = curr.past.slice(0, -1); return { past: newPast, present: previous, future: [curr.present, ...curr.future] }; }); }, []);
  const handleRedo = useCallback(() => { setHistory(curr => { if (curr.future.length === 0) return curr; const next = curr.future[0]; const newFuture = curr.future.slice(1); return { past: [...curr.past, curr.present], present: next, future: newFuture }; }); }, []);
  
  const handleDelete = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setHistory(curr => {
        const remainingClips = curr.present.filter(c => !ids.includes(c.id));
        return { past: [...curr.past, curr.present], present: remainingClips, future: [] };
    });
    setSelectedClipIds(prev => prev.filter(i => !ids.includes(i)));
  }, []);

  useEffect(() => {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
          // Ignore shortcuts if user is typing in an input
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) return;
          
          const isMod = e.ctrlKey || e.metaKey;

          if (e.code === 'Space') {
              e.preventDefault();
              togglePlay();
          } else if (e.key === 'Backspace' || e.key === 'Delete') {
              handleDelete(selectedClipIds);
          } else if (isMod && e.key === 'a') {
              e.preventDefault();
              setSelectedClipIds(history.present.map(c => c.id));
          } else if (isMod && e.key === 'c') {
              const toCopy = history.present.filter(c => selectedClipIds.includes(c.id));
              if (toCopy.length > 0) {
                  clipboardRef.current = JSON.parse(JSON.stringify(toCopy));
              }
          } else if (isMod && e.key === 'v') {
              if (clipboardRef.current.length > 0) {
                  const minStart = Math.min(...clipboardRef.current.map(c => c.startTime));
                  const newClipsToAdd = clipboardRef.current.map(c => ({
                      ...c,
                      id: `copy-${Math.random().toString(36).substr(2, 6)}`,
                      startTime: currentTimeRef.current + (c.startTime - minStart)
                  }));
                  setHistory(curr => ({
                      past: [...curr.past, curr.present],
                      present: [...curr.present, ...newClipsToAdd],
                      future: []
                  }));
                  setSelectedClipIds(newClipsToAdd.map(c => c.id));
              }
          } else if (isMod && e.key === 'z') {
              e.preventDefault();
              if (e.shiftKey) handleRedo();
              else handleUndo();
          } else if (isMod && e.key === 'y') {
              e.preventDefault();
              handleRedo();
          }
      };

      window.addEventListener('keydown', handleGlobalKeyDown);
      return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [selectedClipIds, history.present, togglePlay, handleDelete, handleUndo, handleRedo]);

  const captureCurrentFrame = async (): Promise<string | null> => {
      if (!containerRef.current) return null;
      const width = 1280; const height = 720;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'); if (!ctx) return null;
      ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, width, height);
      const visible = clips.filter(c => currentTime >= c.startTime && currentTime < c.startTime + c.duration).sort((a, b) => a.trackId - b.trackId);
      for (const clip of visible) {
           if (clip.type === 'audio') continue;
           if (clip.type === 'text') { drawClipToCanvas(ctx, clip, null, width, height); } 
           else {
               const el = mediaRefs.current[clip.id] as HTMLVideoElement | null;
               if (clip.type === 'video' && el) { drawClipToCanvas(ctx, clip, el, width, height); } 
               else if (clip.type === 'image') {
                   const img = new Image(); img.crossOrigin = "anonymous"; img.src = clip.sourceUrl || '';
                   await new Promise((resolve) => { if (img.complete) resolve(true); img.onload = () => resolve(true); img.onerror = () => resolve(false); });
                   drawClipToCanvas(ctx, clip, img, width, height);
               }
           }
      }
      return canvas.toDataURL('image/jpeg', 0.8);
  };

  useEffect(() => {
    if (!isPlaying) return;
    let animationFrameId: number;
    let lastTimestamp: number;
    const loop = (timestamp: number) => {
        if (!lastTimestamp) lastTimestamp = timestamp;
        const delta = (timestamp - lastTimestamp) / 1000;
        lastTimestamp = timestamp;
        let masterTimeDelta = delta;
        let syncedToMaster = false;
        let masterClipId: string | null = null;
        const currentT = currentTimeRef.current;
        const activeMediaClip = clips.filter(c => (c.type === 'video' || c.type === 'audio') && currentT >= c.startTime && currentT < c.startTime + currentT + c.duration).sort((a, b) => b.trackId - a.trackId)[0];
        if (activeMediaClip) {
             const el = mediaRefs.current[activeMediaClip.id];
             const speed = activeMediaClip.speed || 1;
             if (el && !el.paused && !el.seeking && el.readyState > 2) {
                 const timeInClip = el.currentTime - activeMediaClip.sourceStartTime;
                 const calculatedTimelineTime = activeMediaClip.startTime + (timeInClip / speed);
                 const syncTolerance = Math.max(0.5, 0.2 * speed);
                 if (Math.abs(calculatedTimelineTime - currentT) < syncTolerance) { masterTimeDelta = calculatedTimelineTime - currentT; if (masterTimeDelta > 0 && masterTimeDelta < 1.0) { syncedToMaster = true; masterClipId = activeMediaClip.id; } }
             }
        }
        let nextTime = syncedToMaster ? currentT + masterTimeDelta : currentT + delta;
        const maxDuration = clips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0);
        if (nextTime >= maxDuration) { nextTime = maxDuration; setIsPlaying(false); setCurrentTime(0); return; }
        setCurrentTime(nextTime);
        if (canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            const width = canvasRef.current.width;
            const height = canvasRef.current.height;
            if (ctx) {
                ctx.clearRect(0, 0, width, height); 
                const visible = clips.filter(c => nextTime >= c.startTime && nextTime < c.startTime + c.duration).sort((a, b) => a.trackId - b.trackId);
                visible.forEach(clip => {
                    if (clip.type === 'audio') return; 
                    if (clip.type === 'text') { drawClipToCanvas(ctx, clip, null, width, height); } 
                    else {
                        const el = mediaRefs.current[clip.id] as HTMLVideoElement | null;
                        if (clip.type === 'video' && el) { drawClipToCanvas(ctx, clip, el, width, height); } 
                        else if (clip.type === 'image') { const img = new Image(); img.src = clip.sourceUrl || ''; if (img.complete) drawClipToCanvas(ctx, clip, img, width, height); }
                    }
                });
            }
        }
        const visibleClips = clips.filter(c => nextTime >= c.startTime && nextTime < c.startTime + c.duration);
        visibleClips.forEach(clip => {
            if ((clip.type === 'video' || clip.type === 'audio') && mediaRefs.current[clip.id]) {
                const el = mediaRefs.current[clip.id];
                if (el) {
                        if (el.muted) el.muted = false;
                        const speed = clip.speed || 1;
                        if (Math.abs(el.playbackRate - speed) > 0.05) el.playbackRate = speed;
                        const targetVolume = clip.volume ?? 1;
                        if (Math.abs(el.volume - targetVolume) > 0.01) el.volume = targetVolume;
                        if (el.paused) el.play().catch(() => {});
                        const isMaster = syncedToMaster && masterClipId === clip.id;
                        if (!isMaster) {
                            const offsetInClip = nextTime - clip.startTime;
                            const targetSourceTime = clip.sourceStartTime + (offsetInClip * speed);
                            const safeTargetTime = Math.max(0, Math.min(el.duration || Infinity, targetSourceTime));
                            const drift = el.currentTime - safeTargetTime;
                            let tolerance = 0.25; if (speed > 2) tolerance = 0.5;
                            if (Math.abs(drift) > tolerance) { if (el.readyState >= 1) { el.currentTime = safeTargetTime; } }
                        }
                }
            }
        });
        clips.forEach(clip => { if (clip.type === 'video' || clip.type === 'audio') { const isVisible = nextTime >= clip.startTime && nextTime < clip.startTime + clip.duration; const el = mediaRefs.current[clip.id]; if (!isVisible && el && !el.paused) { el.pause(); } } });
        animationFrameId = requestAnimationFrame(loop);
    };
    animationFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, clips]);

  useEffect(() => {
      if (isPlaying || isExporting) return;
      const visibleClips = clips.filter(c => currentTime >= c.startTime && currentTime < c.startTime + c.duration);
      visibleClips.forEach(clip => {
           if ((clip.type === 'video' || clip.type === 'audio') && mediaRefs.current[clip.id]) {
              const el = mediaRefs.current[clip.id];
              if (el) {
                  el.pause(); if (el.muted) el.muted = false;
                  const speed = clip.speed || 1;
                  const offsetInClip = currentTime - clip.startTime;
                  const targetTime = clip.sourceStartTime + (offsetInClip * speed);
                  const safeTargetTime = Math.max(0, Math.min(el.duration || Infinity, targetTime));
                  const targetVolume = clip.volume ?? 1;
                  if (Math.abs(el.volume - targetVolume) > 0.01) el.volume = targetVolume;
                  if (Math.abs(el.currentTime - safeTargetTime) > 0.1) { if (el.readyState >= 1) { el.currentTime = safeTargetTime; } }
              }
           }
      });
  }, [isPlaying, isExporting, currentTime, clips]);

  const handleExport = async () => { alert("Full audio mixing export not supported in demo. Visual export only."); };
  const setClipsWithHistory = (newClips: Clip[]) => { setHistory(curr => ({ past: [...curr.past, curr.present], present: newClips, future: [] })); };
  
  const handleUpdateClipTransform = (id: string, newTransform: NonNullable<Clip['transform']>) => {
      setHistory(curr => {
          const index = curr.present.findIndex(c => c.id === id);
          if (index === -1) return curr;
          const newClips = [...curr.present];
          newClips[index] = { ...newClips[index], transform: newTransform };
          return { ...curr, present: newClips };
      });
  };

  const handleClipSpeed = (id: string, newSpeed: number) => {
      setHistory(curr => {
        const clipIndex = curr.present.findIndex(c => c.id === id);
        if (clipIndex === -1) return curr;
        const clip = curr.present[clipIndex];
        const oldSpeed = clip.speed || 1;
        const currentSourceDuration = clip.duration * oldSpeed;
        const newDuration = currentSourceDuration / newSpeed;
        const updatedClip = { ...clip, speed: newSpeed, duration: newDuration };
        const newClips = [...curr.present];
        newClips[clipIndex] = updatedClip;
        const trackClips = newClips.filter(c => c.trackId === clip.trackId);
        trackClips.sort((a, b) => a.startTime - b.startTime);
        let accumulated = 0;
        const normalizedTrack = trackClips.map(c => {
            const n = { ...c, startTime: accumulated };
            accumulated += c.duration;
            return n;
        });
        const otherClips = newClips.filter(c => c.trackId !== clip.trackId);
        return { past: [...curr.past, curr.present], present: [...otherClips, ...normalizedTrack], future: [] };
      });
      setShowSpeedMenu(false); setIsCustomSpeed(false);
  };

  const handleClipVolume = (id: string, newVolume: number) => {
      setHistory(curr => {
          const index = curr.present.findIndex(c => c.id === id);
          if (index === -1) return curr;
          const newClips = [...curr.present];
          newClips[index] = { ...newClips[index], volume: newVolume };
          return { ...curr, present: newClips };
      });
  };

  const handleUpdateTextStyle = (updates: Partial<NonNullable<Clip['textStyle']>>) => {
      setHistory(curr => {
          const newClips = curr.present.map(clip => {
              if (selectedClipIds.includes(clip.id) && clip.type === 'text') {
                  const currentStyle = clip.textStyle || DEFAULT_TEXT_STYLE;
                  return { ...clip, textStyle: { ...currentStyle, ...updates } };
              }
              return clip;
          });
          return { ...curr, present: newClips };
      });
  };

  const handleUpdateTextContent = (id: string, newText: string) => {
      setHistory(curr => {
          const index = curr.present.findIndex(c => c.id === id);
          if (index === -1) return curr;
          const newClips = [...curr.present];
          newClips[index] = { ...newClips[index], text: newText };
          return { ...curr, present: newClips };
      });
  };

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const handleAddTrack = (position: 'top' | 'bottom') => {
      let nextId = 0;
      if (position === 'top') { nextId = tracks.length > 0 ? Math.max(...tracks) + 1 : 0; } 
      else { nextId = tracks.length > 0 ? Math.min(...tracks) - 1 : 0; }
      const newTracks = [...tracks, nextId].sort((a, b) => a - b);
      setTracks(newTracks);
  };

  const handleSelectClip = (id: string, e?: React.MouseEvent) => {
      if (e?.shiftKey) {
          setSelectedClipIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
      } else {
          setSelectedClipIds([id]);
      }
      setShowSpeedMenu(false); setIsCustomSpeed(false); setShowVolumeMenu(false); setShowTextStyleMenu(false);
  };

  const handleClipReorder = (sourceId: string, newStartTime: number, targetTrackId: number, commit: boolean = true) => {
      setHistory(curr => {
          const sourceClip = curr.present.find(c => c.id === sourceId); 
          if (!sourceClip) return curr;
          const updatedSource = { ...sourceClip, trackId: targetTrackId, startTime: newStartTime };
          const remaining = curr.present.filter(c => c.id !== sourceId);
          const finalClips = [...remaining, updatedSource];
          if (!commit) return { ...curr, present: finalClips };
          return { past: [...curr.past, curr.present], present: finalClips, future: [] };
      });
  };

  const handleSplitClip = () => {
    if (selectedClipIds.length === 0) return;
    let generatedIds: string[] = [];
    setHistory(curr => {
      const newClips = [...curr.present];
      const clipsToAdd: Clip[] = [];
      const clipsToRemove: string[] = [];
      selectedClipIds.forEach(id => {
        const clip = newClips.find(c => c.id === id);
        if (!clip) return;
        if (currentTime > clip.startTime && currentTime < clip.startTime + clip.duration) {
          const offset = currentTime - clip.startTime;
          const id1 = `${clip.id}-p1-${Math.random().toString(36).substr(2, 4)}`;
          const id2 = `${clip.id}-p2-${Math.random().toString(36).substr(2, 4)}`;
          const part1: Clip = { ...clip, id: id1, duration: offset };
          const part2: Clip = { ...clip, id: id2, startTime: currentTime, duration: clip.duration - offset, sourceStartTime: clip.sourceStartTime + (offset * (clip.speed || 1)) };
          clipsToRemove.push(id); clipsToAdd.push(part1, part2); generatedIds.push(id2);
        }
      });
      if (clipsToRemove.length === 0) return curr;
      const filtered = newClips.filter(c => !clipsToRemove.includes(c.id));
      const nextPresent = [...filtered, ...clipsToAdd];
      return { past: [...curr.past, curr.present], present: nextPresent, future: [] };
    });
    if (generatedIds.length > 0) setSelectedClipIds(generatedIds);
  };

  const handleClipResize = (id: string, newDuration: number, mode: 'start' | 'end', commit: boolean) => {
      setHistory(curr => {
          const index = curr.present.findIndex(c => c.id === id);
          if (index === -1) return curr;
          const clip = curr.present[index];
          const nextPresent = [...curr.present];
          if (mode === 'end') {
              nextPresent[index] = { ...clip, duration: Math.max(0.1, newDuration) };
          } else {
              const delta = clip.duration - newDuration;
              nextPresent[index] = {
                  ...clip,
                  startTime: clip.startTime + delta,
                  duration: Math.max(0.1, newDuration),
                  sourceStartTime: clip.sourceStartTime + (delta * (clip.speed || 1))
              };
          }
          if (!commit) return { ...curr, present: nextPresent };
          return { past: [...curr.past, curr.present], present: nextPresent, future: [] };
      });
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
      if (e.target === containerRef.current || e.target === e.currentTarget) {
          setSelectedClipIds([]); setShowSpeedMenu(false); setIsCustomSpeed(false); setShowVolumeMenu(false); setShowTextStyleMenu(false);
      }
  };

  const handleOpenMediaModal = (trackId: number) => { setMediaModalTrackId(trackId); setModalMode('initial'); setGenTab('image'); setGenPrompt(''); setVeoStartImg(null); setVeoEndImg(null); };
  const handleCloseMediaModal = () => { setMediaModalTrackId(null); setIsGenerating(false); };
  const triggerLocalUpload = () => { if (fileInputRef.current) fileInputRef.current.click(); };
  const handleVeoReferenceUpload = (target: 'start' | 'end') => { if (referenceImageInputRef.current) { referenceImageInputRef.current.setAttribute('data-target', target); referenceImageInputRef.current.click(); } };
  const handleReferenceImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; const target = e.target.getAttribute('data-target'); if (file && target) { const reader = new FileReader(); reader.onload = (ev) => { if (ev.target?.result) { if (target === 'start') setVeoStartImg(ev.target.result as string); else if (target === 'end') setVeoEndImg(ev.target.result as string); } }; reader.readAsDataURL(file); } e.target.value = ''; };
  const handleCaptureFrame = async (target: 'start' | 'end') => { const base64 = await captureCurrentFrame(); if (base64) { if (target === 'start') setVeoStartImg(base64); else setVeoEndImg(base64); } else { alert("Could not capture frame. Ensure content is visible."); } };

  const getMediaDuration = (file: File): Promise<number> => {
    return new Promise((resolve) => {
      if (file.type.startsWith('image/')) { resolve(3); return; }
      const element = file.type.startsWith('audio/') ? document.createElement('audio') : document.createElement('video');
      element.preload = 'metadata'; element.onloadedmetadata = () => resolve(element.duration || 5);
      element.onerror = () => resolve(5); element.src = URL.createObjectURL(file);
    });
  };

  const handleSeek = (time: number) => setCurrentTime(time);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    setVideoFile(file); const url = URL.createObjectURL(file); setVideoUrl(url);
    const duration = await getMediaDuration(file);
    const newClip: Clip = { id: 'main-video', title: file.name, duration: duration, startTime: 0, sourceStartTime: 0, type: 'video', totalDuration: duration, trackId: 1, sourceUrl: url, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 };
    setHistory(curr => ({ past: [...curr.past, curr.present], present: [newClip], future: [] }));
    setCurrentTime(0); setHasAnalyzed(false); setIsAnalyzing(true);
    try {
        const frames = await extractFramesFromVideo(file, 5);
        const analysis = await analyzeVideoFrames(frames, "Analyze this video and describe the key events, mood, and content.");
        setMessages(prev => [...prev, { role: 'model', text: `I've analyzed your video: ${analysis}` }]);
        setHasAnalyzed(true);
    } catch (e) { console.error(e); } finally { setIsAnalyzing(false); }
  };

  const handleAddMedia = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files; if (!files || files.length === 0 || mediaModalTrackId === null) return;
    setIsGenerating(true); const newClips: Clip[] = [];
    const trackClips = clips.filter(c => c.trackId === mediaModalTrackId);
    let insertTime = 0;
    if (trackClips.length > 0) { const lastClip = trackClips.reduce((prev, current) => (prev.startTime + prev.duration > current.startTime + current.duration) ? prev : current); insertTime = lastClip.startTime + lastClip.duration; }
    for (let i = 0; i < files.length; i++) {
        const file = files[i]; const duration = await getMediaDuration(file);
        const type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : 'video';
        const url = URL.createObjectURL(file);
        newClips.push({ id: Math.random().toString(36).substring(7), title: file.name, duration: duration, startTime: insertTime, sourceStartTime: 0, type: type as any, totalDuration: duration, trackId: mediaModalTrackId, sourceUrl: url, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 });
        insertTime += duration;
    }
    setHistory(curr => ({ past: [...curr.past, curr.present], present: [...curr.present, ...newClips], future: [] }));
    handleCloseMediaModal(); setIsGenerating(false);
  };

  const handleGenerate = async () => {
      if (!genPrompt.trim() && !veoStartImg && genTab === 'video') return; if (!genPrompt.trim() && genTab !== 'video') return; if (mediaModalTrackId === null) return;
      setIsGenerating(true);
      try {
          let url = ''; let duration = 5; let type: 'image' | 'video' | 'audio' = 'image';
          if (genTab === 'image') { type = 'image'; url = await generateImage(genPrompt, imgModel, imgAspect); duration = 5; } 
          else if (genTab === 'video') { type = 'video'; duration = parseInt(vidDuration); url = await generateVideo(genPrompt, vidModel, vidAspect, vidResolution, duration, veoStartImg, veoEndImg); } 
          else if (genTab === 'audio') { type = 'audio'; url = await generateSpeech(genPrompt, audioVoice); const audio = new Audio(url); await new Promise(r => { audio.onloadedmetadata = r; }); duration = audio.duration || 5; }
          const trackClips = clips.filter(c => c.trackId === mediaModalTrackId);
          let insertTime = 0;
          if (trackClips.length > 0) { const lastClip = trackClips.reduce((prev, current) => (prev.startTime + prev.duration > current.startTime + current.duration) ? prev : current); insertTime = lastClip.startTime + lastClip.duration; }
          const newClip: Clip = { id: Math.random().toString(36).substring(7), title: genTab === 'audio' ? `TTS: ${genPrompt.substring(0, 10)}...` : `AI Generated ${type}`, duration: duration, startTime: insertTime, sourceStartTime: 0, type: type, totalDuration: duration, trackId: mediaModalTrackId, sourceUrl: url, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 };
          setHistory(curr => ({ past: [...curr.past, curr.present], present: [...curr.present, newClip], future: [] }));
          handleCloseMediaModal();
      } catch (error: any) { console.error("Generation failed:", error); alert(`Generation failed: ${error.message}`); } finally { setIsGenerating(false); }
  };

  const handleGenerateCaptions = async () => {
      let sourceUrl = videoUrl; if (!sourceUrl && availableVideo) sourceUrl = availableVideo.sourceUrl;
      if (!sourceUrl) { alert("No video source found for captioning."); return; }
      setIsGenerating(true);
      try {
          if (videoFile && sourceUrl === URL.createObjectURL(videoFile)) { const audioBase64 = await extractAudioFromVideo(videoFile); const subtitles = await generateSubtitles(audioBase64); processSubtitles(subtitles); } 
          else { const response = await fetch(sourceUrl); const blob = await response.blob(); const audioBase64 = await extractAudioFromVideo(blob); const subtitles = await generateSubtitles(audioBase64); processSubtitles(subtitles); }
      } catch (error: any) { console.error("Captioning error:", error); alert("Failed to generate captions."); } finally { setIsGenerating(false); setCaptionModalOpen(false); }
  };

  const processSubtitles = (subtitles: {start: number, end: number, text: string}[]) => {
      const newTrackId = Math.max(...tracks, 0) + 1; setTracks(prev => [...prev, newTrackId]);
      const newClips = subtitles.map((sub, idx) => ({ id: `cap-${idx}-${Math.random()}`, title: sub.text, duration: sub.end - sub.start, startTime: sub.start, sourceStartTime: 0, type: 'text' as const, text: sub.text, textStyle: captionStyle, totalDuration: 0, trackId: newTrackId, transform: { x: 0, y: 0.8, scale: 1, rotation: 0 }, speed: 1, volume: 0 }));
      setHistory(curr => ({ past: [...curr.past, curr.present], present: [...curr.present, ...newClips], future: [] }));
  };
  
  const handleTransitionRequest = async (clipA: Clip, clipB: Clip) => {
      if (!containerRef.current) return;
      const frameA = clipA.type === 'video' || clipA.type === 'image' ? await captureFrameFromVideoUrl(clipA.sourceUrl || videoUrl || '', clipA.sourceStartTime + clipA.duration) : null;
      const frameB = clipB.type === 'video' || clipB.type === 'image' ? await captureFrameFromVideoUrl(clipB.sourceUrl || videoUrl || '', clipB.sourceStartTime) : null;
      setTransitionModal({ active: true, clipA, clipB, startFrame: frameA, endFrame: frameB, prompt: "Smooth cinematic transition", model: 'veo-3.1-fast-generate-preview', resolution: '720p', duration: '8' });
  };

  const handleGenerateTransition = async () => {
      const { clipA, clipB, prompt, model, resolution, duration, startFrame, endFrame } = transitionModal;
      if (!clipA || !clipB) return;
      setIsGenerating(true);
      try {
          const transitionUrl = await generateVideo(prompt, model, '16:9', resolution, parseInt(duration), startFrame, endFrame);
          const transDuration = parseInt(duration); const insertTime = clipA.startTime + clipA.duration;
          const newClip: Clip = { id: `trans-${Math.random()}`, title: 'AI Transition', duration: transDuration, startTime: insertTime, sourceStartTime: 0, type: 'video', totalDuration: transDuration, trackId: clipA.trackId, sourceUrl: transitionUrl, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 };
          const shiftAmount = transDuration;
          setHistory(curr => {
             const updatedClips = curr.present.map(c => { if (c.trackId === clipA.trackId && c.startTime >= insertTime) return { ...c, startTime: c.startTime + shiftAmount }; return c; });
             return { past: [...curr.past, curr.present], present: [...updatedClips, newClip], future: [] };
          });
          setTransitionModal(prev => ({ ...prev, active: false }));
      } catch (error: any) { console.error("Transition generation failed:", error); alert(error.message); } finally { setIsGenerating(false); }
  };

  const formatTime = (seconds: number) => { const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); const ms = Math.floor((seconds % 1) * 100); return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`; };
  const getVeoMode = () => { if (veoStartImg && veoEndImg) return { label: 'Interpolation', color: 'border-purple-500/50 text-purple-300 bg-purple-500/10' }; if (veoStartImg) return { label: 'Image-to-Video', color: 'border-blue-500/50 text-blue-300 bg-blue-500/10' }; return { label: 'Text-to-Video', color: 'border-neutral-700 text-neutral-400 bg-neutral-800' }; };
  const { label: veoModeLabel, color: veoModeColor } = getVeoMode();

  const handleRangeSelected = () => setRangeModalOpen(true);
  const handleRangeConfirm = (range: {start: number, end: number}) => { setLiveScopeRange(range); setRangeModalOpen(false); setIsSelectingScope(false); };

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100 font-sans overflow-hidden">
      <RangeEditorModal isOpen={rangeModalOpen} onClose={() => { setRangeModalOpen(false); setIsSelectingScope(false); }} onConfirm={handleRangeConfirm} initialRange={liveScopeRange || { start: 0, end: 5 }} clips={clips} mediaRefs={mediaRefs} />
      <input type="file" multiple accept="video/*,image/*,audio/*" className="hidden" ref={fileInputRef} onChange={handleAddMedia} />
      <input type="file" accept="image/*" className="hidden" ref={referenceImageInputRef} onChange={handleReferenceImageFileChange} />
      
      {captionModalOpen && (
          <div className="fixed inset-0 z-[600] flex items-center justify-center p-4">
              <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setCaptionModalOpen(false)} />
              <div className="relative w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
                  <div className="p-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-900">
                      <div className="flex items-center gap-2"><Captions className="w-5 h-5 text-purple-400" /><h3 className="text-lg font-semibold text-white">Generate Subtitles</h3></div>
                      <button onClick={() => setCaptionModalOpen(false)} className="p-1.5 hover:bg-neutral-800 rounded-full text-neutral-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="p-6 space-y-6">
                      <div className="bg-neutral-800/50 rounded-lg p-4 border border-neutral-700/50"><div className="flex items-start gap-3"><Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" /><div className="space-y-1"><p className="text-sm font-medium text-white">Source Selection</p><p className="text-xs text-neutral-400 leading-relaxed">Subtitles will be generated from the <strong>Main Video</strong> uploaded to the project. {videoFile ? ` (Main Video: ${videoFile.name})` : (availableVideo ? " (Using first timeline video)" : " (No video detected)")}</p></div></div></div>
                      <div className="p-4 rounded-xl border border-neutral-800 bg-neutral-950/50"><label className="text-xs font-semibold text-neutral-400 uppercase mb-3 block tracking-wider">Default Style</label><TextControls values={captionStyle} onChange={(updates) => setCaptionStyle(prev => ({...prev, ...updates}))} /></div>
                      <div className="flex justify-end pt-2"><button onClick={handleGenerateCaptions} disabled={isGenerating || !availableVideo} className="flex items-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white px-6 py-2.5 rounded-lg font-medium text-sm transition-all disabled:opacity-50 shadow-lg w-full justify-center">{isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate with Gemini 2.5 Flash</button></div>
                  </div>
              </div>
          </div>
      )}
      
      {transitionModal.active && ( <div className="fixed inset-0 z-[600] flex items-center justify-center p-4"><div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setTransitionModal(prev => ({ ...prev, active: false }))} /><div className="relative w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200"><div className="p-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-900"><div className="flex items-center gap-2"><Wand2 className="w-5 h-5 text-purple-400" /><h3 className="text-lg font-semibold text-white">Generate Transition</h3></div><button onClick={() => setTransitionModal(prev => ({ ...prev, active: false }))} className="p-1.5 hover:bg-neutral-800 rounded-full text-neutral-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button></div><div className="p-6 space-y-6"><div className="flex items-center gap-2 justify-center"><div className="relative w-32 aspect-video bg-neutral-800 rounded-lg overflow-hidden border border-neutral-700"><img src={transitionModal.startFrame || ''} className="w-full h-full object-cover" alt="Out Point" /><div className="absolute bottom-1 left-1 bg-black/50 px-1.5 py-0.5 rounded text-[9px] text-white backdrop-blur">Clip A End</div></div><ArrowRight className="w-5 h-5 text-neutral-500" /><div className="relative w-32 aspect-video bg-neutral-800 rounded-lg overflow-hidden border border-neutral-700"><img src={transitionModal.endFrame || ''} className="w-full h-full object-cover" alt="In Point" /><div className="absolute bottom-1 right-1 bg-black/50 px-1.5 py-0.5 rounded text-[9px] text-white backdrop-blur">Clip B Start</div></div></div><div className="space-y-4"><div><label className="block text-xs font-medium text-neutral-400 mb-1.5">Transition Description</label><textarea value={transitionModal.prompt} onChange={(e) => setTransitionModal(prev => ({ ...prev, prompt: e.target.value }))} placeholder="Describe the transition..." className="w-full h-20 bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-sm focus:outline-none focus:border-purple-500 resize-none transition-all" /></div><div className="grid grid-cols-2 gap-4"><div className="col-span-2"><label className="block text-xs font-medium text-neutral-400 mb-1.5">Model</label><select value={transitionModal.model} onChange={(e) => setTransitionModal(prev => ({ ...prev, model: e.target.value }))} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-2.5 text-sm focus:outline-none focus:border-purple-500"><option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option><option value="veo-3.1-generate-preview">Veo 3.1 Quality</option><option value="veo-3.0-fast-generate-preview">Veo 3 Fast</option><option value="veo-3.0-generate-preview">Veo 3 Quality</option></select></div><div><label className="block text-xs font-medium text-neutral-400 mb-1.5">Resolution</label><select value={transitionModal.resolution} onChange={(e) => setTransitionModal(prev => ({ ...prev, resolution: e.target.value as any }))} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-2.5 text-sm focus:outline-none focus:border-purple-500"><option value="720p">720p</option><option value="1080p">1080p (8s only)</option><option value="4k">4k (8s only)</option></select></div><div><label className="block text-xs font-medium text-neutral-400 mb-1.5">Duration</label><select value={transitionModal.duration} disabled={true} className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-2.5 text-sm text-neutral-500 cursor-not-allowed" title="Transitions with reference images require 8s duration"><option value="8">8s (Forced)</option></select></div></div></div><div className="flex justify-end pt-2"><button onClick={handleGenerateTransition} disabled={isGenerating} className="flex items-center gap-2 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white px-6 py-2.5 rounded-lg font-medium text-sm transition-all disabled:opacity-50 shadow-lg">{isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate & Insert</button></div></div></div></div> )}
      {mediaModalTrackId !== null && ( <div className="fixed inset-0 z-[500] flex items-center justify-center p-4"><div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleCloseMediaModal} /><div className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl p-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"><div className="p-4 border-b border-neutral-800 flex items-center justify-between"><h3 className="text-lg font-semibold text-white">Add Media to Track {mediaModalTrackId + 1}</h3><button onClick={handleCloseMediaModal} className="p-2 hover:bg-neutral-800 rounded-full text-neutral-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button></div>{modalMode === 'initial' ? (<div className="p-8 grid grid-cols-2 gap-6"><button onClick={triggerLocalUpload} className="flex flex-col items-center justify-center gap-4 p-12 rounded-xl bg-neutral-800/50 border border-neutral-700 hover:border-blue-500/50 hover:bg-neutral-800 transition-all group"><div className="w-16 h-16 rounded-full bg-neutral-700 group-hover:bg-blue-600 flex items-center justify-center transition-colors shadow-lg"><Upload className="w-8 h-8 text-neutral-300 group-hover:text-white" /></div><div className="text-center"><p className="text-lg font-medium text-white mb-1">Upload Files</p><p className="text-sm text-neutral-400">Select multiple items</p></div></button><button onClick={() => setModalMode('generate')} className="flex flex-col items-center justify-center gap-4 p-12 rounded-xl bg-neutral-800/50 border border-neutral-700 hover:border-purple-500/50 hover:bg-neutral-800 transition-all group relative overflow-hidden"><div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-blue-500/10 opacity-0 group-hover:opacity-100 transition-opacity" /><div className="w-16 h-16 rounded-full bg-neutral-700 group-hover:bg-purple-600 flex items-center justify-center transition-colors shadow-lg relative z-10"><GeminiLogo className="w-8 h-8" /></div><div className="text-center relative z-10"><p className="text-lg font-medium text-white mb-1">Generate with Gemini</p><p className="text-sm text-neutral-400">Image, Video, or Speech</p></div></button></div>) : (<div className="flex flex-1 min-h-0"><div className="w-48 border-r border-neutral-800 bg-neutral-900 p-2 space-y-1"><button onClick={() => setModalMode('initial')} className="flex items-center gap-2 w-full p-2 text-neutral-400 hover:text-white mb-4 transition-colors"><ChevronLeft className="w-4 h-4" /> Back</button>{[{ id: 'image', icon: ImageIcon, label: 'Image' },{ id: 'video', icon: Film, label: 'Video (Veo)' },{ id: 'audio', icon: Mic, label: 'Speech (TTS)' }].map(tab => (<button key={tab.id} onClick={() => setGenTab(tab.id as any)} className={`flex items-center gap-3 w-full p-3 rounded-lg text-sm font-medium transition-all ${genTab === tab.id ? 'bg-purple-600/20 text-purple-300' : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'}`}><tab.icon className="w-4 h-4" /> {tab.label}</button>))}</div><div className="flex-1 p-6 overflow-y-auto bg-neutral-950/50"><div className="max-w-xl mx-auto space-y-6"><div><label className="block text-sm font-medium text-neutral-400 mb-2">{genTab === 'audio' ? 'Text to Speak' : 'Prompt'}</label><textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} placeholder={genTab === 'audio' ? "Enter text..." : "Describe what you want to generate..."} className="w-full h-24 bg-neutral-900 border border-neutral-700 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 resize-none transition-all" autoFocus /></div>{genTab === 'video' && (<div className="space-y-4 pt-2 border-t border-neutral-800"><div className="flex items-center justify-between mb-2"><span className="text-sm font-medium text-neutral-300">Reference Images</span><span className={`text-xs font-medium px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700 ${veoModeColor}`}>{veoModeLabel}</span></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><div className="flex items-center justify-between"><label className="text-xs font-medium text-neutral-500">Start Frame (Optional)</label>{veoStartImg && <button onClick={() => setVeoStartImg(null)} className="text-xs text-red-400 hover:text-red-300"><Trash2 className="w-3 h-3" /></button>}</div><div className="relative aspect-video bg-neutral-900 border border-neutral-700 rounded-lg overflow-hidden group hover:border-blue-500/50 transition-colors">{veoStartImg ? (<img src={veoStartImg} className="w-full h-full object-cover" alt="Start Frame" />) : (<div className="absolute inset-0 flex flex-col items-center justify-center gap-2"><button onClick={() => handleCaptureFrame('start')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Camera className="w-3 h-3" /> Timeline</button><button onClick={() => handleVeoReferenceUpload('start')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Upload className="w-3 h-3" /> Upload</button></div>)}</div><p className="text-[10px] text-neutral-600">Tip: Position playhead to capture specific timeline frame.</p></div><div className="space-y-2"><div className="flex items-center justify-between"><label className={`text-xs font-medium ${!veoStartImg ? 'text-neutral-700' : 'text-neutral-500'}`}>End Frame (Requires Start Frame)</label>{veoEndImg && <button onClick={() => setVeoEndImg(null)} className="text-xs text-red-400 hover:text-red-300"><Trash2 className="w-3 h-3" /></button>}</div><div className={`relative aspect-video bg-neutral-900 border rounded-lg overflow-hidden group transition-colors ${!veoStartImg ? 'border-neutral-800 opacity-50 pointer-events-none' : 'border-neutral-700 hover:border-purple-500/50'}`}>{veoEndImg ? (<img src={veoEndImg} className="w-full h-full object-cover" alt="End Frame" />) : (<div className="absolute inset-0 flex flex-col items-center justify-center gap-2"><button onClick={() => handleCaptureFrame('end')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Camera className="w-3 h-3" /> Timeline</button><button onClick={() => handleVeoReferenceUpload('end')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Upload className="w-3 h-3" /> Upload</button></div>)}</div></div></div></div>)}{genTab === 'image' && (<div className="grid grid-cols-2 gap-4"><div><label className="block text-xs font-medium text-neutral-500 mb-1">Model</label><select value={imgModel} onChange={(e) => setImgModel(e.target.value as any)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="gemini-2.5-flash-image">Fast (Flash)</option><option value="gemini-3-pro-image-preview">High Quality (Pro)</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Aspect Ratio</label><select value={imgAspect} onChange={(e) => setImgAspect(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="16:9">16:9 (Landscape)</option><option value="9:16">9:16 (Portrait)</option><option value="1:1">1:1 (Square)</option></select></div></div>)}{genTab === 'video' && (<div className="grid grid-cols-2 gap-4"><div className="col-span-2 grid grid-cols-2 gap-4"><div><label className="block text-xs font-medium text-neutral-500 mb-1">Model</label><select value={vidModel} onChange={(e) => setVidModel(e.target.value as any)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option><option value="veo-3.1-generate-preview">Veo 3.1 Quality</option><option value="veo-3.0-fast-generate-preview">Veo 3 Fast</option><option value="veo-3.0-generate-preview">Veo 3 Quality</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Resolution</label><select value={vidResolution} onChange={(e) => setVidResolution(e.target.value as any)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="720p">720p</option><option value="1080p">1080p (8s only)</option><option value="4k">4k (8s only)</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Duration</label><select value={vidDuration} onChange={(e) => setVidDuration(e.target.value as any)} disabled={vidResolution === '1080p' || vidResolution === '4k' || !!veoStartImg || !!veoEndImg} className={`w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500 ${vidResolution === '1080p' || vidResolution === '4k' || !!veoStartImg || !!veoEndImg ? 'opacity-50 cursor-not-allowed bg-neutral-800' : ''}`}><option value="4">4s</option><option value="8">8s</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Aspect Ratio</label><select value={vidAspect} onChange={(e) => setVidAspect(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="16:9">16:9 (Landscape)</option><option value="9:16">9:16 (Portrait)</option></select></div></div><div className="col-span-2 p-3 bg-blue-900/20 border border-blue-500/20 rounded-lg flex items-start gap-2"><Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" /><span className="text-xs text-blue-300 leading-relaxed">Video generation takes 1-2 minutes. A paid billing project is required.<br/><strong>Note:</strong> 1080p, 4K, and Image-to-Video operations are locked to 8s duration.</span></div></div>)}{genTab === 'audio' && (<div><label className="block text-xs font-medium text-neutral-500 mb-1">Voice</label><div className="grid grid-cols-5 gap-2">{['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'].map(voice => (<button key={voice} onClick={() => setAudioVoice(voice)} className={`p-2 rounded border text-xs font-medium transition-all ${audioVoice === voice ? 'bg-purple-600 border-purple-500 text-white' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>{voice}</button>))}</div></div>)}<div className="flex justify-end pt-4"><button onClick={handleGenerate} disabled={isGenerating || (genTab !== 'video' && !genPrompt.trim()) || (genTab === 'video' && !genPrompt.trim() && !veoStartImg)} className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white px-8 py-3 rounded-lg font-medium text-sm transition-all disabled:opacity-50 shadow-lg shadow-purple-900/20 w-full justify-center">{isGenerating ? (<><Loader2 className="w-5 h-5 animate-spin" />{genTab === 'video' ? 'Generating Video...' : 'Generating...'}</>) : (<><Sparkles className="w-5 h-5" />Generate {genTab.charAt(0).toUpperCase() + genTab.slice(1)}</>)}</button></div></div></div></div>)}</div></div>)}

      {/* Header */}
      <header className="h-14 border-b border-neutral-800 flex items-center px-4 justify-between bg-neutral-900/50 backdrop-blur-sm z-10 relative z-[100]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center"><Video className="w-5 h-5 text-white" /></div>
          <h1 className="font-semibold text-lg tracking-tight">Cursor for Video <span className="text-xs font-normal text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded ml-2">Demo</span></h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center bg-neutral-800 rounded-lg p-0.5 border border-neutral-700 mr-2">
            <button onClick={handleUndo} disabled={!canUndo} className="p-1.5 hover:bg-neutral-700 rounded-md text-neutral-400 hover:text-white disabled:opacity-30 transition-colors"><RotateCcw className="w-4 h-4" /></button>
            <div className="w-px h-4 bg-neutral-700 mx-0.5" />
            <button onClick={handleRedo} disabled={!canRedo} className="p-1.5 hover:bg-neutral-700 rounded-md text-neutral-400 hover:text-white disabled:opacity-30 transition-colors"><RotateCw className="w-4 h-4" /></button>
          </div>
           <button onClick={handleExport} disabled={isExporting} className="flex items-center gap-2 text-sm text-white bg-green-600 hover:bg-green-700 px-4 py-1.5 rounded-full shadow-lg transition-all disabled:opacity-50">{isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}<span>{isExporting ? `${exportProgress}%` : 'Export MP4'}</span></button>
           <label className="flex items-center gap-2 text-sm text-white cursor-pointer transition-all bg-blue-600 hover:bg-blue-700 px-4 py-1.5 rounded-full shadow-lg hover:shadow-blue-500/20 active:scale-95 font-medium"><Upload className="w-4 h-4" /><span>Import Video</span><input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} /></label>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 relative">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 bg-neutral-950 flex flex-col">
              <div className="flex-1 relative flex items-center justify-center p-8 overflow-hidden" onClick={handleCanvasClick}>
                <div ref={containerRef} className="relative w-full max-w-4xl aspect-video bg-neutral-900 rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 group">
                {clips.map((clip) => {
                    const isVisible = currentTime >= clip.startTime && currentTime < clip.startTime + clip.duration;
                    const transform = clip.transform || { x: 0, y: 0, scale: 1, rotation: 0 };
                    const style: React.CSSProperties = { position: 'absolute', left: '50%', top: '50%', width: '100%', height: '100%', transform: `translate(-50%, -50%) translate(${transform.x * 100}%, ${transform.y * 100}%) scale(${transform.scale}) rotate(${transform.rotation}deg)`, objectFit: 'contain', cursor: isPlaying ? 'default' : 'pointer', zIndex: clip.trackId * 10, opacity: isVisible ? 1 : 0, pointerEvents: isVisible ? (isPlaying ? 'none' : 'auto') : 'none' };
                    const handleClipClick = (e: React.MouseEvent) => { e.stopPropagation(); if (!isPlaying && isVisible) { handleSelectClip(clip.id, e); } };
                    if (clip.type === 'text' && clip.text) {
                        const ts = clip.textStyle || DEFAULT_TEXT_STYLE;
                        return ( <div key={clip.id} style={style} onClick={handleClipClick} className="flex items-center justify-center"><span className="px-4 py-2 text-center whitespace-pre-wrap" style={{ fontFamily: ts.fontFamily || 'Plus Jakarta Sans', fontSize: `${ts.fontSize}px`, fontWeight: ts.isBold ? 'bold' : 'normal', fontStyle: ts.isItalic ? 'italic' : 'normal', textDecoration: ts.isUnderline ? 'underline' : 'none', color: ts.color, backgroundColor: ts.backgroundColor ? `${ts.backgroundColor}${Math.round((ts.backgroundOpacity ?? 0) * 255).toString(16).padStart(2,'0')}` : 'transparent', lineHeight: 1.2, textShadow: (ts.backgroundOpacity ?? 0) < 0.3 ? '1px 1px 2px rgba(0,0,0,0.8)' : 'none' }}>{clip.text}</span></div> );
                    }
                    if (clip.type === 'video' || clip.type === 'audio') {
                        const isAudio = clip.type === 'audio';
                        return ( <div key={clip.id} style={{...style, display: isAudio ? 'none' : 'block'}} onClick={handleClipClick}>{isAudio ? ( <audio ref={(el) => { mediaRefs.current[clip.id] = el; }} src={clip.sourceUrl || ''} muted={false} /> ) : ( <video ref={(el) => { mediaRefs.current[clip.id] = el; }} src={clip.sourceUrl || videoUrl || ''} className="w-full h-full object-contain pointer-events-none" muted={false} playsInline crossOrigin={(!clip.sourceUrl && !videoUrl) ? undefined : "anonymous"} /> )}</div> );
                    } else { return ( <div key={clip.id} style={style} onClick={handleClipClick}><img src={clip.sourceUrl || ''} alt={clip.title} className="w-full h-full object-contain pointer-events-none" /></div> ); }
                })}
                {!videoUrl && clips.length === 0 && ( <label className="absolute inset-0 flex flex-col items-center justify-center text-neutral-500 hover:text-neutral-300 cursor-pointer transition-colors z-20"><Video className="w-16 h-16 mb-4 opacity-20" /><p className="font-medium text-lg mb-2">Click to upload video</p><p className="text-sm opacity-50">or drag and drop here</p><input type="file" accept="video/*" className="hidden" onChange={handleFileUpload} /></label> )}
                {!isPlaying && isSelectedClipVisible && primarySelectedClip && primarySelectedClip.type !== 'audio' && !isMultiSelection && ( <CanvasControls clip={primarySelectedClip} containerRef={containerRef} onUpdate={handleUpdateClipTransform} /> )}
                {isExporting && ( <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-50"><Loader2 className="w-12 h-12 text-green-500 animate-spin mb-4" /><h3 className="text-xl font-bold text-white mb-2">Rendering Video...</h3><p className="text-neutral-400 mb-4">Frame by frame analysis</p><div className="w-64 h-2 bg-neutral-800 rounded-full overflow-hidden"><div className="h-full bg-green-500 transition-all duration-75" style={{ width: `${exportProgress}%` }} /></div></div> )}
                <canvas ref={canvasRef} width={1280} height={720} className="absolute inset-0 w-full h-full pointer-events-none opacity-0" />
                <div className="absolute top-4 left-4 bg-black/60 backdrop-blur px-2 py-1 rounded text-xs font-mono text-neutral-400 border border-white/5 z-40 pointer-events-none">VIRTUAL PLAYER ENGINE</div>
                </div>
              </div>
              <div className="h-12 bg-neutral-900 border-t border-neutral-800 flex items-center justify-between px-6 z-[200] relative">
                  <div className="flex items-center gap-4">
                      <button onClick={togglePlay} className="w-8 h-8 flex items-center justify-center rounded-full bg-white text-black hover:bg-neutral-200 transition-colors">{isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}</button>
                      <span className="font-mono text-sm text-neutral-400"><span className="text-white">{formatTime(currentTime)}</span></span>
                  </div>
                  <div className="flex items-center gap-2">
                       {allSelectedAreText && (
                           <>
                            {!isMultiSelection && primarySelectedClip && ( <input type="text" value={primarySelectedClip.text || ''} onChange={(e) => handleUpdateTextContent(primarySelectedClip.id, e.target.value)} className="w-48 bg-neutral-800 border border-neutral-700 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 mr-2" placeholder="Enter text..." /> )}
                            <div className="relative">
                                <button onClick={() => { setShowTextStyleMenu(!showTextStyleMenu); setShowVolumeMenu(false); setShowSpeedMenu(false); }} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${showTextStyleMenu ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-700'}`}>
                                    <Type className="w-3.5 h-3.5" /> Style {isMultiSelection ? `(${selectedClips.length})` : ''}
                                </button>
                                {showTextStyleMenu && ( <div className="absolute bottom-full mb-2 right-0 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-4 z-50 min-w-[280px] animate-in fade-in zoom-in-95 duration-100"><TextControls values={primarySelectedClip?.textStyle || DEFAULT_TEXT_STYLE} onChange={handleUpdateTextStyle} /></div> )}
                            </div>
                           </>
                       )}
                       {allSelectedAreMedia && (
                           <>
                           <div className="relative">
                                <button onClick={() => { setShowSpeedMenu(!showSpeedMenu); setShowVolumeMenu(false); setIsCustomSpeed(false); setShowTextStyleMenu(false); }} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${showSpeedMenu ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-700'}`}><Gauge className="w-3.5 h-3.5" />{primarySelectedClip?.speed}x</button>
                               {showSpeedMenu && (<div className="absolute bottom-full mb-2 right-0 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl overflow-hidden min-w-[140px] flex flex-col p-1 z-50">{[0.5, 1, 1.5, 2].map(s => (<button key={s} onClick={() => primarySelectedClip && handleClipSpeed(primarySelectedClip.id, s)} className="text-left px-3 py-1.5 text-xs rounded hover:bg-neutral-700 transition-colors w-full text-neutral-300">{s}x</button>))}</div>)}
                           </div>
                           <div className="relative">
                                <button onClick={() => { setShowVolumeMenu(!showVolumeMenu); setShowSpeedMenu(false); setShowTextStyleMenu(false); }} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${showVolumeMenu ? 'bg-blue-600 text-white' : 'bg-neutral-800 text-neutral-300 hover:text-white hover:bg-neutral-700'}`}>{primarySelectedClip?.volume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}{Math.round((primarySelectedClip?.volume ?? 1) * 100)}%</button>
                                {showVolumeMenu && (<div className="absolute bottom-full mb-2 right-0 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl p-3 z-50 min-w-[120px]"><input type="range" min="0" max="1" step="0.05" value={primarySelectedClip?.volume ?? 1} onChange={(e) => primarySelectedClip && handleClipVolume(primarySelectedClip.id, parseFloat(e.target.value))} className="w-full h-1.5 bg-neutral-600 rounded-lg appearance-none cursor-pointer accent-blue-500" /></div>)}
                            </div>
                           </>
                       )}
                       <button onClick={handleSplitClip} className="p-2 hover:bg-neutral-800 rounded-md text-neutral-400 hover:text-white transition-colors" title="Split Clip at Playhead"><Scissors className="w-4 h-4" /></button>
                  </div>
              </div>
          </div>
          <div className="h-64 border-t border-neutral-800 bg-neutral-900/50 backdrop-blur-sm z-10 flex flex-col relative z-[90]">
            <Timeline clips={clips} tracks={tracks} currentTime={currentTime} onSeek={handleSeek} onDelete={handleDelete} onSelect={handleSelectClip} onAddMediaRequest={handleOpenMediaModal} onResize={handleClipResize} onReorder={handleClipReorder} onAddTrack={handleAddTrack} selectedClipIds={selectedClipIds} onTransitionRequest={handleTransitionRequest} onCaptionRequest={() => setCaptionModalOpen(true)} isSelectionMode={isSelectingScope} onRangeChange={(range) => setLiveScopeRange(range)} onRangeSelected={handleRangeSelected} />
          </div>
        </div>
        <aside className="w-80 border-l border-neutral-800 bg-neutral-900 flex flex-col z-[150] relative">
          <AIAssistant selectedClip={primarySelectedClip} onRequestRangeSelect={() => { const defaultStart = currentTime; const maxDur = availableVideo ? availableVideo.duration : 10; const defaultEnd = Math.min(defaultStart + 5, maxDur); setLiveScopeRange({ start: defaultStart, end: defaultEnd }); setRangeModalOpen(true); }} isSelectingRange={isSelectingScope} timelineRange={liveScopeRange} />
        </aside>
      </div>
    </div>
  );
}
