
import React, { useState, useEffect, useRef } from 'react';
import { Wand2, Clapperboard, Sparkles, Mic, Video, Type, Zap, Loader2, Send, Clock, X, Check, Target, AlertTriangle } from 'lucide-react';
import { Clip, TimelineRange, ChatMessage, ToolAction, PlanStep, VideoIntent } from '../../types';
import { chatWithGemini, resolvePlanStep, performDeepAnalysis } from '../../services/gemini';
import { rangeToGeminiParts } from '../../services/geminiAdapter';
import { ChatSuggestionCard } from './ChatSuggestionCard';
import { PlanReviewCard } from './PlanReviewCard';

interface Scope {
  type: 'clip' | 'semantic' | 'range';
  label: string;
  data?: any;
}

interface AIAssistantProps {
  selectedClip: Clip | null;
  onRequestRangeSelect: () => void;
  isSelectingRange: boolean;
  timelineRange: { start: number, end: number } | null;
  allClips: Clip[];
  mediaRefs: React.MutableRefObject<{[key: string]: HTMLVideoElement | HTMLAudioElement | null}>;
  onExecuteAction: (action: ToolAction) => Promise<void>;
}

export const AIAssistant: React.FC<AIAssistantProps> = ({ 
    selectedClip, 
    onRequestRangeSelect, 
    isSelectingRange,
    timelineRange,
    allClips,
    mediaRefs,
    onExecuteAction
}) => {
  const [mode, setMode] = useState<'assist' | 'director'>('assist');
  const [assistQuery, setAssistQuery] = useState('');
  const [activeScope, setActiveScope] = useState<Scope | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [executionStatus, setExecutionStatus] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [videoIntent, setVideoIntent] = useState<VideoIntent | null>(null);

  useEffect(() => {
      if (timelineRange) {
          const start = timelineRange.start.toFixed(1);
          const end = timelineRange.end.toFixed(1);
          setActiveScope({ type: 'range', label: `${start}s - ${end}s`, data: timelineRange });
      }
  }, [timelineRange]);

  useEffect(() => {
      if (!isSelectingRange && timelineRange && activeScope?.type === 'range') {
          inputRef.current?.focus();
      }
  }, [isSelectingRange, timelineRange]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setAssistQuery(val);
      if (val.endsWith('#') && !activeScope) {
          setAssistQuery(prev => prev.slice(0, -1));
          onRequestRangeSelect();
      }
  };

  const handleApplyAction = async (action: ToolAction) => {
      setChatHistory(prev => [...prev, { role: 'system', text: `Applying ${action.button_label}...` }]);
      await onExecuteAction(action);
  };

  const handleExecutePlan = async (steps: PlanStep[]) => {
      setIsProcessing(true);
      const timelineContext = JSON.stringify(allClips.map(c => ({
          title: c.title,
          type: c.type,
          startTime: c.startTime,
          duration: c.duration
      })));

      setChatHistory(prev => [...prev, { 
        role: 'system', 
        text: `Orchestrating ${steps.length} approved steps autonomously...` 
      }]);

      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          setExecutionStatus(`Executing Step ${i + 1}/${steps.length}: ${step.intent}`);
          
          try {
              // 1. Convert Plan Step to Concrete Tool Action using Gemini
              const toolAction = await resolvePlanStep(step, timelineContext);
              
              if (toolAction) {
                  // 2. Execute Action (Generate content + Mutate timeline)
                  await onExecuteAction(toolAction);
                  successCount++;
              } else {
                  throw new Error("Could not determine technical action for this step.");
              }
          } catch (e: any) {
              console.error(`Failed to execute step: ${step.intent}`, e);
              failCount++;
              setChatHistory(prev => [...prev, { 
                  role: 'system', 
                  text: `⚠️ Failed Step ${i+1}: "${step.intent}". \nReason: ${e.message || "Unknown error"}. Skipping.` 
              }]);
          }
      }

      setExecutionStatus(null);
      setIsProcessing(false);
      setChatHistory(prev => [...prev, { 
        role: 'system', 
        text: `Execution Complete: ${successCount} successful, ${failCount} failed.` 
      }]);
  };

  // Helper to process responses and handle recursion for analysis
  const processResponse = async (
      currentHistory: ChatMessage[], 
      messagePayload: any,
      retryCount: number = 0
  ) => {
      if (retryCount > 2) return; // Safety break

      try {
          const response = await chatWithGemini(
              currentHistory.map(m => ({ role: m.role, text: m.text })), 
              messagePayload,
              videoIntent || undefined
          );

          if (response.intentUpdate) {
              setVideoIntent(prev => ({ ...prev, ...response.intentUpdate }));
          }

          // If the Director requested an analysis, we must execute the Analysis Layer
          if (response.shouldAnalyze) {
              setExecutionStatus("Running Analysis Layer...");
              
              // 1. Determine Scope for Analysis
              let parts: any[] = [];
              if (activeScope?.type === 'range' && activeScope.data) {
                  parts = await rangeToGeminiParts(activeScope.data, allClips, mediaRefs.current);
              } else {
                  const maxDuration = allClips.reduce((acc, c) => Math.max(acc, c.startTime + c.duration), 0) || 10;
                  parts = await rangeToGeminiParts({ start: 0, end: maxDuration, tracks: [] }, allClips, mediaRefs.current);
              }
              
              // 2. Call the Deep Analysis Service with MULTIMODAL payload
              const analysisReport = await performDeepAnalysis(parts);
              
              // 3. Inject the report as a SYSTEM EVENT for the Director to see
              const systemReportMsg: ChatMessage = { 
                  role: 'system', 
                  text: `[ANALYSIS LAYER REPORT]\n${analysisReport}\n\n(Present this to the user neutrally, then ask for their goal.)` 
              };
              
              setChatHistory(prev => [...prev, systemReportMsg]);
              
              // 4. RECURSE: Call chat again with the new history + report
              await processResponse([...currentHistory, systemReportMsg], "Analysis Completed. Please present findings.", retryCount + 1);
              return; 
          }

          setChatHistory(prev => [...prev, { 
              role: 'model', 
              text: response.text, 
              toolAction: response.toolAction,
              plan: response.plan
          }]);

      } catch (e) {
          console.error(e);
          setChatHistory(prev => [...prev, { role: 'model', text: "Sorry, I encountered an error." }]);
      }
  };

  const handleSendMessage = async () => {
      if (!assistQuery.trim() && !activeScope) return;
      const userMessage = assistQuery;
      setAssistQuery('');
      setIsProcessing(true);
      const displayMessage = userMessage || (activeScope ? `Analyze selection: ${activeScope.label}` : "Analyze this");
      
      const newHistory = [...chatHistory, { role: 'user' as const, text: displayMessage }];
      setChatHistory(newHistory);

      try {
          let apiMessage: any = userMessage;
          
          if (activeScope?.type === 'range' && activeScope.data) {
              const range = activeScope.data as { start: number, end: number };
              const timelineRangeObj: TimelineRange = { start: range.start, end: range.end, tracks: [] };
              const parts = await rangeToGeminiParts(timelineRangeObj, allClips, mediaRefs.current);
              parts.push({ text: userMessage || "Analyze this selection." });
              apiMessage = parts;
          } else {
              // Standard Global Context
              // We do NOT send full frames yet. We send metadata and let the Agent DECIDE to call 'perform_deep_analysis'
              const clipsSummary = allClips.map(c => 
                  `[${c.startTime.toFixed(1)}s - ${(c.startTime + c.duration).toFixed(1)}s] ${c.type ? c.type.toUpperCase() : 'CLIP'}: "${c.title}"`
              ).join('\n');
              
              apiMessage = `
                USER REQUEST:
                ${userMessage}

                TIMELINE SUMMARY:
                ${clipsSummary || "Timeline is empty."}
              `;
          }

          await processResponse(newHistory, apiMessage);

      } finally {
          setIsProcessing(false);
          setExecutionStatus(null);
      }
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border-l border-neutral-800 text-neutral-200 font-sans relative z-50">
      <div className="p-3 border-b border-neutral-800 bg-neutral-900 sticky top-0 z-10 flex flex-col gap-2">
        <div className="flex bg-neutral-950 p-1 rounded-lg border border-neutral-800">
          <button onClick={() => setMode('assist')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${mode === 'assist' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}>
            <Wand2 size={14} /> Assist
          </button>
          <button onClick={() => setMode('director')} className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${mode === 'director' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-500 hover:text-neutral-300'}`}>
            <Clapperboard size={14} /> Director
          </button>
        </div>
        {/* Intent Display */}
        {videoIntent && (
            <div className="flex items-start gap-2 bg-purple-900/20 border border-purple-500/20 rounded-md p-2">
                <Target size={14} className="text-purple-400 mt-0.5 shrink-0" />
                <div className="text-[10px] space-y-0.5">
                    <p className="text-purple-200 font-bold uppercase tracking-wider">Target Intent</p>
                    <div className="flex flex-wrap gap-1 text-purple-300/80">
                        {videoIntent.platform && <span>• {videoIntent.platform}</span>}
                        {videoIntent.goal && <span>• {videoIntent.goal}</span>}
                        {videoIntent.tone && <span>• {videoIntent.tone}</span>}
                    </div>
                </div>
            </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {mode === 'assist' && (
          <div className="space-y-6">
            {chatHistory.length > 0 ? (
                <div className="space-y-4 mb-4">
                    {chatHistory.map((msg, i) => (
                        <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                            {msg.text && (
                              <div className={`max-w-[85%] p-3 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap ${
                                  msg.role === 'user' ? 'bg-blue-600/20 text-blue-100 border border-blue-500/30' : 
                                  msg.role === 'system' ? 'bg-neutral-900/50 text-neutral-500 border border-neutral-800/50 font-mono text-[10px]' : 
                                  'bg-neutral-800 border border-neutral-700'
                              }`}>
                                  {msg.role === 'system' && <AlertTriangle size={10} className="inline mr-1 -mt-0.5" />}
                                  {msg.text}
                              </div>
                            )}
                            
                            {msg.toolAction && (
                                <div className="w-[85%]">
                                    <ChatSuggestionCard action={msg.toolAction} onApply={handleApplyAction} />
                                </div>
                            )}

                            {msg.plan && (
                                <div className="w-full">
                                    <PlanReviewCard plan={msg.plan} onExecute={handleExecutePlan} />
                                </div>
                            )}
                        </div>
                    ))}
                    {isProcessing && (
                         <div className="flex justify-start">
                             <div className="bg-neutral-800/50 p-3 rounded-lg border border-neutral-800 flex items-center gap-2">
                                <Loader2 size={12} className="animate-spin text-purple-400" />
                                <span className="text-xs text-neutral-400">
                                    {executionStatus || "Thinking..."}
                                </span>
                             </div>
                         </div>
                    )}
                </div>
            ) : (
                selectedClip ? (
                  <div className="bg-neutral-800/50 rounded-lg p-3 border border-neutral-800">
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-neutral-500">Selected Clip</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 capitalize">{selectedClip.type || 'Media'}</span>
                    </div>
                    <h3 className="font-medium text-sm text-white truncate mb-1">{selectedClip.title}</h3>
                    <p className="text-xs text-neutral-400 font-mono">Duration: {selectedClip.duration.toFixed(2)}s</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-48 text-center space-y-4 opacity-60">
                    <div className="w-12 h-12 rounded-2xl bg-neutral-800 flex items-center justify-center border border-neutral-700 shadow-inner">
                      <Wand2 size={24} className="text-neutral-500" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-bold text-neutral-300">The Orchestrator</p>
                      <p className="text-xs text-neutral-500 max-w-[180px]">I can help plan edits, generate content, or fix pacing. Just ask!</p>
                    </div>
                  </div>
                )
            )}
          </div>
        )}
      </div>

      {mode === 'assist' && (
        <div className="p-3 border-t border-neutral-800 bg-neutral-900 relative z-[60]">
          <div className="relative flex items-center bg-neutral-950 border border-neutral-800 rounded-2xl px-2 py-1 focus-within:border-purple-500 focus-within:ring-1 focus-within:ring-purple-500/50 transition-all">
            {activeScope && (
                <div className="flex items-center gap-1 bg-blue-600/20 border border-blue-500/30 text-blue-200 rounded-full pl-2 pr-1 py-0.5 mr-1 shrink-0 animate-in fade-in zoom-in-95 duration-200">
                    <span className="text-[10px] font-medium leading-none whitespace-nowrap">{activeScope.label}</span>
                    <button onClick={() => setActiveScope(null)} className="p-0.5 hover:bg-blue-500/20 rounded-full text-blue-300 transition-colors"><X size={10} /></button>
                </div>
            )}
            <input
              ref={inputRef}
              type="text"
              value={assistQuery}
              onChange={handleInputChange}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              disabled={isSelectingRange || isProcessing}
              placeholder={activeScope ? "Ask about selection..." : "Director's input... (# for range)"}
              className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder:text-neutral-600 py-2 min-w-[50px]"
            />
            <button onClick={handleSendMessage} disabled={isProcessing} className="p-2 hover:bg-neutral-800 rounded-xl text-purple-400 transition-colors shrink-0 disabled:opacity-50">
              <Send size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
