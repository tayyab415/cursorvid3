import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Timeline } from './components/Timeline';
import { CanvasControls } from './components/CanvasControls';
import { AIAssistant } from './components/sidebar/AIAssistant';
import { Clip, ChatMessage, Suggestion, ToolAction, PlanStep } from './types';
import { generateImage, generateVideo, generateSpeech, determinePlacement, generateRefinement } from './services/gemini';
import { extractAudioFromVideo, captureFrameFromVideoUrl } from './utils/videoUtils';
import { Video, Wand2, Play, Pause, Loader2, Upload, RotateCcw, RotateCw, Sparkles, Scissors, Gauge, Download, Volume2, VolumeX, X, Image as ImageIcon, Film, Mic, Camera, Trash2, Info, Captions, Type, Bold, Italic, Underline, AlignCenter, AlignLeft, AlignRight, Check, ChevronLeft } from 'lucide-react';
import { timelineStore } from './timeline/store';
import { OrchestratorAgent } from './services/agents/orchestrator';
import { ExecutorAgent } from './services/agents/executor';

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

// --- GLOBAL HELPERS ---
const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms}`;
};

// Canvas drawing helpers
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
    const duration = clips.reduce((max, c) => Math.max(max, c.startTime + c.duration), 10);
    const [dragging, setDragging] = useState<'start' | 'end' | null>(null);
    const playbackTimeRef = useRef(initialRange.start);

    useEffect(() => {
        setRange(initialRange);
        playbackTimeRef.current = initialRange.start;
    }, [initialRange, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        let animationFrameId: number;
        let lastTime = performance.now();

        const loop = (time: number) => {
            const dt = (time - lastTime) / 1000;
            lastTime = time;

            if (isPlaying) {
                playbackTimeRef.current += dt;
                if (playbackTimeRef.current >= range.end) {
                    playbackTimeRef.current = range.start;
                }
            }

            const currentT = playbackTimeRef.current;
            const visibleClipIds = new Set<string>();

            clips.forEach(clip => {
                 const isVisible = currentT >= clip.startTime && currentT < clip.startTime + clip.duration;
                 if (isVisible) visibleClipIds.add(clip.id);

                 if (clip.type === 'video' || clip.type === 'audio') {
                     const el = mediaRefs.current[clip.id];
                     if (el) {
                         if (isVisible) {
                             const offset = currentT - clip.startTime;
                             const mediaTime = clip.sourceStartTime + offset * (clip.speed || 1);
                             if (Math.abs(el.currentTime - mediaTime) > 0.15) el.currentTime = mediaTime;
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
    const startPct = (range.start / duration) * 100;
    const endPct = (range.end / duration) * 100;
    const widthPct = endPct - startPct;

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
                </div>
                <div className="p-4 border-t border-neutral-800 bg-neutral-950 flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-xs font-bold text-neutral-400 hover:text-white transition-colors">Cancel</button>
                    <button onClick={() => onConfirm(range)} className="px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black text-xs font-bold rounded-lg shadow-lg flex items-center gap-2 transition-transform active:scale-95"><Check size={14} strokeWidth={3} /> Confirm Selection</button>
                </div>
            </div>
        </div>
    );
};

const TextControls = ({ values, onChange }: { values: any, onChange: (updates: any) => void }) => (
    <div className="space-y-3">
         <div className="grid grid-cols-2 gap-2">
             <div>
                 <label className="text-[10px] text-neutral-500 mb-1 block">Font</label>
                 <select value={values.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })} className="w-full bg-neutral-900 border border-neutral-700 rounded p-1 text-xs focus:border-blue-500 outline-none text-white">
                     <option value="Plus Jakarta Sans">Sans Serif</option>
                     <option value="serif">Serif</option>
                     <option value="monospace">Monospace</option>
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
const GeminiLogo = ({ className = "w-6 h-6" }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
        <path d="M16 3C16 3 16.0375 8.525 21.0625 10.9375C16.0375 13.35 16 19 16 19C16 19 15.9625 13.35 11 11C15.9625 8.525 16 3 16 3Z" fill="#4E75F6" />
        <path d="M4 11C4 11 4.5 13.5 7 14.5C4.5 15.5 4 18 4 18C4 18 3.5 15.5 1 14.5C3.5 13.5 4 11 4 11Z" fill="#E93F33" />
    </svg>
);


export default function App() {
  const [tracks, setTracks] = useState<number[]>([0, 1, 2, 3]);

  // Use Store for Clips (Single Source of Truth)
  const [clips, setClips] = useState<Clip[]>(timelineStore.getClips());
  
  useEffect(() => {
    return timelineStore.subscribe(setClips);
  }, []);

  const clipsRef = useRef(clips);
  useEffect(() => { clipsRef.current = clips; }, [clips]);

  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const clipboardRef = useRef<Clip[]>([]);
  
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isCustomSpeed, setIsCustomSpeed] = useState(false);
  const [showVolumeMenu, setShowVolumeMenu] = useState(false);
  const [showTextStyleMenu, setShowTextStyleMenu] = useState(false);
  const [captionStyle, setCaptionStyle] = useState(DEFAULT_TEXT_STYLE);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  
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
  const [executionStatus, setExecutionStatus] = useState<string | null>(null);

  const [transitionModal, setTransitionModal] = useState<any>({ active: false });
  const [isGenerating, setIsGenerating] = useState(false);
  const [genPrompt, setGenPrompt] = useState('');
  const [imgModel, setImgModel] = useState('gemini-2.5-flash-image');
  const [imgAspect, setImgAspect] = useState('16:9');
  
  const [vidModel, setVidModel] = useState('veo-3.1-fast-generate-preview');
  const [vidResolution, setVidResolution] = useState('720p');
  const [vidAspect, setVidAspect] = useState('16:9');
  const [vidDuration, setVidDuration] = useState('4');
  const [veoStartImg, setVeoStartImg] = useState<string | null>(null);
  const [veoEndImg, setVeoEndImg] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<'start'|'end'>('start');
  const [audioVoice, setAudioVoice] = useState('Kore');

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

  const canUndo = timelineStore.canUndo();
  const canRedo = timelineStore.canRedo();
  
  const veoModeLabel = veoStartImg && veoEndImg ? 'Morph Mode' : veoStartImg ? 'Image-to-Video' : 'Text-to-Video';
  const veoModeColor = veoStartImg && veoEndImg ? 'text-purple-300 bg-purple-900/50 border-purple-500/50' : veoStartImg ? 'text-blue-300 bg-blue-900/50 border-blue-500/50' : 'text-neutral-400 bg-neutral-800 border-neutral-700';

  // --- AGENTS ---
  const orchestrator = new OrchestratorAgent();
  const executor = new ExecutorAgent(); // For single actions

  const handleExecutePlan = async (steps: PlanStep[]) => {
      setExecutionStatus("Starting Execution...");
      try {
        const report = await orchestrator.executePlanWithVerification(
            steps,
            (status) => setExecutionStatus(status)
        );
        console.log("Execution Report", report);
        const successCount = report.results.filter(r => r.status.includes('success')).length;
        setExecutionStatus(`Done. Applied ${successCount}/${steps.length} changes.`);
        setTimeout(() => setExecutionStatus(null), 3000);
      } catch (e) {
          console.error("Plan Execution Error", e);
          setExecutionStatus("Execution Failed. Check Console.");
          setTimeout(() => setExecutionStatus(null), 3000);
      }
  };

  const handleExecuteAIAction = async (action: ToolAction) => {
      setIsGenerating(true);
      // Map ToolAction back to primitive execution
      await executor.execute({
          name: action.tool_id.toLowerCase(), // Mapped back to function name if possible, or handle specifically
          args: action.parameters
      });
      setIsGenerating(false);
  };
  
  // ... (Playback Logic Same as before) ...
  useEffect(() => {
    let animationFrameId: number;
    let lastTimestamp = performance.now();
    const updateLoop = (timestamp: number) => {
      const dt = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;
      if (isPlaying) {
        setCurrentTime((prevTime) => prevTime + dt);
      }
      animationFrameId = requestAnimationFrame(updateLoop);
    };
    if (isPlaying) {
        lastTimestamp = performance.now();
        animationFrameId = requestAnimationFrame(updateLoop);
    } else {
        Object.values(mediaRefs.current).forEach((el) => { (el as any)?.pause(); });
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying]);

  // Sync Logic
  useEffect(() => {
      clips.forEach(clip => {
          if (clip.type !== 'video' && clip.type !== 'audio') return;
          const mediaEl = mediaRefs.current[clip.id];
          if (!mediaEl) return;
          const isActive = currentTime >= clip.startTime && currentTime < (clip.startTime + clip.duration);
          if (isActive) {
              const relativeTime = currentTime - clip.startTime;
              const targetTime = clip.sourceStartTime + (relativeTime * (clip.speed || 1));
              if (Math.abs(mediaEl.currentTime - targetTime) > 0.25) mediaEl.currentTime = targetTime;
              if (isPlaying) { if (mediaEl.paused) mediaEl.play().catch(() => {}); } 
              else { if (!mediaEl.paused) mediaEl.pause(); }
              mediaEl.muted = false; mediaEl.volume = clip.volume ?? 1; mediaEl.playbackRate = clip.speed ?? 1;
          } else {
              if (!mediaEl.paused) mediaEl.pause(); mediaEl.muted = true;
          }
      });
  }, [currentTime, isPlaying, clips]);

  const handleUndo = () => timelineStore.undo();
  const handleRedo = () => timelineStore.redo();
  const handleDelete = (ids: string[]) => ids.forEach(id => timelineStore.removeClip(id));
  
  // Shortcuts
  useEffect(() => {
      const handleGlobalKeyDown = (e: KeyboardEvent) => {
          if (e.target instanceof HTMLInputElement) return;
          const isMod = e.ctrlKey || e.metaKey;
          if (e.code === 'Space') { e.preventDefault(); togglePlay(); } 
          else if (e.key === 'Backspace' || e.key === 'Delete') { handleDelete(selectedClipIds); } 
          else if (isMod && e.key === 'z') { e.preventDefault(); if (e.shiftKey) handleRedo(); else handleUndo(); } 
      };
      window.addEventListener('keydown', handleGlobalKeyDown);
      return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [selectedClipIds, togglePlay]);

  // Canvas
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

  // Handlers
  const handleSeek = (time: number) => { setCurrentTime(Math.max(0, time)); setIsPlaying(false); };
  const handleSelectClip = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey) setSelectedClipIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    else setSelectedClipIds([id]);
  };
  const handleCanvasClick = () => setSelectedClipIds([]);

  // Replace update functions with Store calls
  const updateClip = (id: string, updates: Partial<Clip>) => timelineStore.updateClip(id, updates);
  const handleUpdateClipTransform = (id: string, newTransform: NonNullable<Clip['transform']>) => updateClip(id, { transform: newTransform });
  const handleUpdateTextContent = (id: string, text: string) => updateClip(id, { text });
  const handleUpdateTextStyle = (updates: any) => primarySelectedClip && updateClip(primarySelectedClip.id, { textStyle: { ...primarySelectedClip.textStyle, ...updates } });
  const handleClipSpeed = (id: string, speed: number) => updateClip(id, { speed });
  const handleClipVolume = (id: string, volume: number) => updateClip(id, { volume });
  
  const handleClipResize = (id: string, newDuration: number, mode: 'start' | 'end', commit: boolean) => {
      if (commit) {
        timelineStore.updateClip(id, { duration: newDuration });
      }
  };
  const handleClipReorder = (id: string, newStartTime: number, targetTrackId: number, commit: boolean) => {
      if (commit) timelineStore.moveClip(id, newStartTime, targetTrackId);
  };
  
  const handleAddTrack = (position: 'top' | 'bottom') => {
      setTracks(prev => {
          const newId = Math.max(...prev) + 1;
          return position === 'top' ? [...prev, newId] : [newId, ...prev];
      });
  };

  const handleRangeSelected = () => {
      setRangeModalOpen(true);
  };
  
  const handleSplitClip = () => {
      // Placeholder for split implementation in store context
      // For now no-op or simple
  };

  // Add media handlers (same logic, just using store.addClip)
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      setIsGenerating(true);
      try {
          const trackId = mediaModalTrackId ?? 0;
          // Calculate start time based on existing clips in track
          const trackClips = timelineStore.getClips().filter(c => c.trackId === trackId);
          let startTime = trackClips.length > 0 ? Math.max(...trackClips.map(c => c.startTime + c.duration)) : 0;
          
          const fileArray: File[] = Array.from(files);
          for (let i = 0; i < fileArray.length; i++) {
              const file = fileArray[i];
              const url = URL.createObjectURL(file);
              const type = file.type.startsWith('video') ? 'video' : file.type.startsWith('image') ? 'image' : 'audio';
              let duration = 5;
              
              if (type === 'video' || type === 'audio') {
                   const el = document.createElement(type);
                   el.src = url;
                   await new Promise<void>(r => { 
                       el.onloadedmetadata = () => { 
                           if (Number.isFinite(el.duration)) duration = el.duration; 
                           r(); 
                       }; 
                       el.onerror = () => r(); 
                   });
              }
              
              if (type === 'video') { setVideoFile(file); setVideoUrl(url); }

              timelineStore.addClip({
                  id: `upload-${Date.now()}-${i}`,
                  title: file.name,
                  type: type as any,
                  startTime, 
                  duration, 
                  sourceStartTime: 0, 
                  trackId, 
                  sourceUrl: url, 
                  totalDuration: duration
              });
              startTime += duration;
          }
          setMediaModalTrackId(null);
          setModalMode('initial');
      } catch (e) { console.error(e); } finally { 
          setIsGenerating(false); 
          if (fileInputRef.current) fileInputRef.current.value = '';
      }
  };
  
  const handleAddMedia = handleFileUpload;

  const triggerLocalUpload = () => {
      fileInputRef.current?.click();
  };

  const handleCloseMediaModal = () => {
      setMediaModalTrackId(null);
      setVeoStartImg(null);
      setVeoEndImg(null);
      setGenPrompt('');
  };

  const handleRangeConfirm = (range: { start: number, end: number }) => {
      setLiveScopeRange(range);
      setRangeModalOpen(false);
  };

  const handleCaptureFrame = async (target: 'start' | 'end') => {
      const frame = await captureCurrentFrame();
      if (frame) {
          if (target === 'start') setVeoStartImg(frame);
          else setVeoEndImg(frame);
      }
  };

  const handleVeoReferenceUpload = (target: 'start' | 'end') => {
      setUploadTarget(target);
      referenceImageInputRef.current?.click();
  };

  const handleReferenceImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = () => {
               const b64 = reader.result as string;
               if (uploadTarget === 'start') setVeoStartImg(b64);
               else setVeoEndImg(b64);
          };
          reader.readAsDataURL(file);
      }
      e.target.value = '';
  };

  const handleGenerate = async () => {
      if (mediaModalTrackId === null) return;
      setIsGenerating(true);
      try {
          let resultUrl = '';
          let duration = 5;
          let type: Clip['type'] = 'image';

          if (genTab === 'image') {
              const b64 = await generateImage(genPrompt, imgModel, imgAspect);
              resultUrl = `data:image/png;base64,${b64}`;
              type = 'image';
              duration = 5;
          } else if (genTab === 'video') {
              resultUrl = await generateVideo(
                  genPrompt, 
                  vidModel, 
                  vidAspect, 
                  vidResolution, 
                  parseInt(vidDuration), 
                  veoStartImg, 
                  veoEndImg
              );
              type = 'video';
              duration = parseInt(vidDuration);
          } else if (genTab === 'audio') {
              resultUrl = await generateSpeech(genPrompt, audioVoice);
              type = 'audio';
              const temp = new Audio(resultUrl);
              await new Promise(r => { temp.onloadedmetadata = r; temp.onerror = r; });
              duration = temp.duration || 5;
          }

          const trackId = mediaModalTrackId;
          const trackClips = timelineStore.getClips().filter(c => c.trackId === trackId);
          const startTime = trackClips.length > 0 ? Math.max(...trackClips.map(c => c.startTime + c.duration)) : 0;

          timelineStore.addClip({
              id: `gen-${Date.now()}`,
              title: genTab === 'audio' ? `TTS: ${genPrompt.slice(0,10)}...` : `Gen ${genTab}: ${genPrompt.slice(0,10)}...`,
              type,
              startTime,
              duration,
              sourceStartTime: 0,
              trackId,
              sourceUrl: resultUrl,
              totalDuration: duration
          });
          
          handleCloseMediaModal();

      } catch (e) {
          console.error("Generation failed", e);
      } finally {
          setIsGenerating(false);
      }
  };

  const handleGenerateCaptions = async () => {
      if (!availableVideo || isGenerating) return;
      setIsGenerating(true);
      try {
          let audioBase64 = '';
          if (videoFile) {
              audioBase64 = await extractAudioFromVideo(videoFile);
          } else if (availableVideo.sourceUrl) {
               const response = await fetch(availableVideo.sourceUrl);
               const blob = await response.blob();
               audioBase64 = await extractAudioFromVideo(blob);
          }

          if (!audioBase64) throw new Error("Could not extract audio");

          timelineStore.addClip({
                   id: `sub-${Date.now()}`,
                   title: 'Generated Subtitles',
                   type: 'text',
                   text: "Generated captions would appear here aligned to speech.",
                   startTime: 0,
                   duration: 5,
                   sourceStartTime: 0,
                   trackId: 3, 
                   textStyle: captionStyle
          });
          
          setCaptionModalOpen(false);
      } catch (e) {
          console.error(e);
      } finally {
          setIsGenerating(false);
      }
  };

  const handleExport = async () => {
      setIsExporting(true);
      setExportProgress(0);
      try {
          const canvas = document.createElement('canvas');
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error("No context");
          for(let i=0; i<=100; i+=10) {
              setExportProgress(i);
              await new Promise(r => setTimeout(r, 100));
          }
          alert("Export simulation complete. (Real export requires WebCodecs implementation)");
      } catch (e) {
          console.error(e);
          alert("Export failed");
      } finally {
          setIsExporting(false);
      }
  };
  
  // Render
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
      
      {mediaModalTrackId !== null && ( <div className="fixed inset-0 z-[500] flex items-center justify-center p-4"><div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleCloseMediaModal} /><div className="relative w-full max-w-2xl bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl p-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]"><div className="p-4 border-b border-neutral-800 flex items-center justify-between"><h3 className="text-lg font-semibold text-white">Add Media to Track {mediaModalTrackId + 1}</h3><button onClick={handleCloseMediaModal} className="p-2 hover:bg-neutral-800 rounded-full text-neutral-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button></div>{modalMode === 'initial' ? (<div className="p-8 grid grid-cols-2 gap-6"><button onClick={triggerLocalUpload} className="flex flex-col items-center justify-center gap-4 p-12 rounded-xl bg-neutral-800/50 border border-neutral-700 hover:border-blue-500/50 hover:bg-neutral-800 transition-all group"><div className="w-16 h-16 rounded-full bg-neutral-700 group-hover:bg-blue-600 flex items-center justify-center transition-colors shadow-lg"><Upload className="w-8 h-8 text-neutral-300 group-hover:text-white" /></div><div className="text-center"><p className="text-lg font-medium text-white mb-1">Upload Files</p><p className="text-sm text-neutral-400">Select multiple items</p></div></button><button onClick={() => setModalMode('generate')} className="flex flex-col items-center justify-center gap-4 p-12 rounded-xl bg-neutral-800/50 border border-neutral-700 hover:border-purple-500/50 hover:bg-neutral-800 transition-all group relative overflow-hidden"><div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-blue-500/10 opacity-0 group-hover:opacity-100 transition-opacity" /><div className="w-16 h-16 rounded-full bg-neutral-700 group-hover:bg-purple-600 flex items-center justify-center transition-colors shadow-lg relative z-10"><GeminiLogo className="w-8 h-8" /></div><div className="text-center relative z-10"><p className="text-lg font-medium text-white mb-1">Generate with Gemini</p><p className="text-sm text-neutral-400">Image, Video, or Speech</p></div></button></div>) : (<div className="flex flex-1 min-h-0"><div className="w-48 border-r border-neutral-800 bg-neutral-900 p-2 space-y-1"><button onClick={() => setModalMode('initial')} className="flex items-center gap-2 w-full p-2 text-neutral-400 hover:text-white mb-4 transition-colors"><ChevronLeft className="w-4 h-4" /> Back</button>{[{ id: 'image', icon: ImageIcon, label: 'Image' },{ id: 'video', icon: Film, label: 'Video (Veo)' },{ id: 'audio', icon: Mic, label: 'Speech (TTS)' }].map(tab => (<button key={tab.id} onClick={() => setGenTab(tab.id as any)} className={`flex items-center gap-3 w-full p-3 rounded-lg text-sm font-medium transition-all ${genTab === tab.id ? 'bg-purple-600/20 text-purple-300' : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'}`}><tab.icon className="w-4 h-4" /> {tab.label}</button>))}</div><div className="flex-1 p-6 overflow-y-auto bg-neutral-950/50"><div className="max-w-xl mx-auto space-y-6"><div><label className="block text-sm font-medium text-neutral-400 mb-2">{genTab === 'audio' ? 'Text to Speak' : 'Prompt'}</label><textarea value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} placeholder={genTab === 'audio' ? "Enter text..." : "Describe what you want to generate..."} className="w-full h-24 bg-neutral-900 border border-neutral-700 rounded-xl p-3 text-sm focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 resize-none transition-all" autoFocus /></div>{genTab === 'video' && (<div className="space-y-4 pt-2 border-t border-neutral-800"><div className="flex items-center justify-between mb-2"><span className="text-sm font-medium text-neutral-300">Reference Images</span><span className={`text-xs font-medium px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700 ${veoModeColor}`}>{veoModeLabel}</span></div><div className="grid grid-cols-2 gap-4"><div className="space-y-2"><div className="flex items-center justify-between"><label className="text-xs font-medium text-neutral-500">Start Frame (Optional)</label>{veoStartImg && <button onClick={() => setVeoStartImg(null)} className="text-xs text-red-400 hover:text-red-300"><Trash2 className="w-3 h-3" /></button>}</div><div className="relative aspect-video bg-neutral-900 border border-neutral-700 rounded-lg overflow-hidden group hover:border-blue-500/50 transition-colors">{veoStartImg ? (<img src={veoStartImg} className="w-full h-full object-cover" alt="Start Frame" />) : (<div className="absolute inset-0 flex flex-col items-center justify-center gap-2"><button onClick={() => handleCaptureFrame('start')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Camera className="w-3 h-3" /> Timeline</button><button onClick={() => handleVeoReferenceUpload('start')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Upload className="w-3 h-3" /> Upload</button></div>)}</div><p className="text-[10px] text-neutral-600">Tip: Position playhead to capture specific timeline frame.</p></div><div className="space-y-2"><div className="flex items-center justify-between"><label className={`text-xs font-medium ${!veoStartImg ? 'text-neutral-700' : 'text-neutral-500'}`}>End Frame (Requires Start Frame)</label>{veoEndImg && <button onClick={() => setVeoEndImg(null)} className="text-xs text-red-400 hover:text-red-300"><Trash2 className="w-3 h-3" /></button>}</div><div className={`relative aspect-video bg-neutral-900 border rounded-lg overflow-hidden group transition-colors ${!veoStartImg ? 'border-neutral-800 opacity-50 pointer-events-none' : 'border-neutral-700 hover:border-purple-500/50'}`}>{veoEndImg ? (<img src={veoEndImg} className="w-full h-full object-cover" alt="End Frame" />) : (<div className="absolute inset-0 flex flex-col items-center justify-center gap-2"><button onClick={() => handleCaptureFrame('end')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Camera className="w-3 h-3" /> Timeline</button><button onClick={() => handleVeoReferenceUpload('end')} className="flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-xs text-neutral-300 transition-colors"><Upload className="w-3 h-3" /> Upload</button></div>)}</div></div></div></div>)}{genTab === 'image' && (<div className="grid grid-cols-2 gap-4"><div><label className="block text-xs font-medium text-neutral-500 mb-1">Model</label><select value={imgModel} onChange={(e) => setImgModel(e.target.value as any)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="gemini-2.5-flash-image">Fast (Flash)</option><option value="gemini-3-pro-image-preview">High Quality (Pro)</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Aspect Ratio</label><select value={imgAspect} onChange={(e) => setImgAspect(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="16:9">16:9 (Landscape)</option><option value="9:16">9:16 (Portrait)</option><option value="1:1">1:1 (Square)</option></select></div></div>)}{genTab === 'video' && (<div className="grid grid-cols-2 gap-4"><div className="col-span-2 grid grid-cols-2 gap-4"><div><label className="block text-xs font-medium text-neutral-500 mb-1">Model</label><select value={vidModel} onChange={(e) => setVidModel(e.target.value as any)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="veo-3.1-fast-generate-preview">Veo 3.1 Fast</option><option value="veo-3.1-generate-preview">Veo 3.1 Quality</option><option value="veo-3.0-fast-generate-preview">Veo 3 Fast</option><option value="veo-3.0-generate-preview">Veo 3 Quality</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Resolution</label><select value={vidResolution} onChange={(e) => setVidResolution(e.target.value as any)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="720p">720p</option><option value="1080p">1080p (8s only)</option><option value="4k">4k (8s only)</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Duration</label><select value={vidDuration} onChange={(e) => setVidDuration(e.target.value as any)} disabled={vidResolution === '1080p' || vidResolution === '4k' || !!veoStartImg || !!veoEndImg} className={`w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500 ${vidResolution === '1080p' || vidResolution === '4k' || !!veoStartImg || !!veoEndImg ? 'opacity-50 cursor-not-allowed bg-neutral-800' : ''}`}><option value="4">4s</option><option value="8">8s</option></select></div><div><label className="block text-xs font-medium text-neutral-500 mb-1">Aspect Ratio</label><select value={vidAspect} onChange={(e) => setVidAspect(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-sm focus:outline-none focus:border-purple-500"><option value="16:9">16:9 (Landscape)</option><option value="9:16">9:16 (Portrait)</option></select></div></div><div className="col-span-2 p-3 bg-blue-900/20 border border-blue-500/20 rounded-lg flex items-start gap-2"><Info className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" /><span className="text-xs text-blue-300 leading-relaxed">Video generation takes 1-2 minutes. A paid billing project is required.<br/><strong>Note:</strong> 1080p, 4K, and Image-to-Video operations are locked to 8s duration.</span></div></div>)}{genTab === 'audio' && (<div><label className="block text-xs font-medium text-neutral-500 mb-1">Voice</label><div className="grid grid-cols-5 gap-2">{['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'].map(voice => (<button key={voice} onClick={() => setAudioVoice(voice)} className={`p-2 rounded border text-xs font-medium transition-all ${audioVoice === voice ? 'bg-purple-600 border-purple-500 text-white' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:border-neutral-600'}`}>{voice}</button>))}</div></div>)}<div className="flex justify-end pt-4"><button onClick={handleGenerate} disabled={isGenerating || (genTab !== 'video' && !genPrompt.trim()) || (genTab === 'video' && !genPrompt.trim() && !veoStartImg)} className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white px-8 py-3 rounded-lg font-medium text-sm transition-all disabled:opacity-50 shadow-lg shadow-purple-900/20 w-full justify-center">{isGenerating ? (<><Loader2 className="w-5 h-5 animate-spin" />{genTab === 'video' ? 'Generating Video...' : 'Generating...'}</>) : (<><Sparkles className="w-5 h-5" />Generate {genTab.charAt(0).toUpperCase() + genTab.slice(1)}</>)}</button></div></div></div></div>)}</div></div>)}

      <header className="h-14 border-b border-neutral-800 flex items-center px-4 justify-between bg-neutral-900/50 backdrop-blur-sm z-10 relative z-[100]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center"><Video className="w-5 h-5 text-white" /></div>
          <h1 className="font-semibold text-lg tracking-tight">Cursor for Video <span className="text-xs font-normal text-neutral-400 bg-neutral-800 px-1.5 py-0.5 rounded ml-2">Agentic</span></h1>
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
                    {/* Render clips */}
                    {clips.map(clip => {
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
                    {!isPlaying && isSelectedClipVisible && primarySelectedClip && primarySelectedClip.type !== 'audio' && !isMultiSelection && ( 
                        <CanvasControls clip={primarySelectedClip} containerRef={containerRef} onUpdate={handleUpdateClipTransform} /> 
                    )}
                </div>
              </div>
              {/* Toolbar & Timeline */}
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
            <Timeline clips={clips} tracks={tracks} currentTime={currentTime} onSeek={handleSeek} onDelete={handleDelete} onSelect={handleSelectClip} onAddMediaRequest={(tid) => { setMediaModalTrackId(tid); setModalMode('initial'); }} onResize={handleClipResize} onReorder={handleClipReorder} onAddTrack={handleAddTrack} selectedClipIds={selectedClipIds} onTransitionRequest={() => {}} onCaptionRequest={() => setCaptionModalOpen(true)} isSelectionMode={isSelectingScope} onRangeChange={(range) => setLiveScopeRange(range)} onRangeSelected={handleRangeSelected} />
          </div>
        </div>
        <aside className="w-80 border-l border-neutral-800 bg-neutral-900 flex flex-col z-[150] relative">
          {/* executionStatus Overlay */}
          {executionStatus && (
              <div className="absolute top-0 left-0 right-0 bg-purple-600 text-white text-xs py-1 px-2 z-[200] font-mono text-center shadow-lg animate-in slide-in-from-top-2 duration-200">
                  {executionStatus}
              </div>
          )}
          <AIAssistant 
            selectedClip={primarySelectedClip} 
            onRequestRangeSelect={() => {}}
            isSelectingRange={isSelectingScope} 
            timelineRange={liveScopeRange}
            allClips={clips}
            mediaRefs={mediaRefs}
            clipsRef={clipsRef}
            onExecuteAction={handleExecuteAIAction}
            onExecutePlan={handleExecutePlan}
          />
        </aside>
      </div>
    </div>
  );
}
