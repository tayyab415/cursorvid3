import React, { useState, useEffect, useRef } from 'react';
import { Wand2, Clapperboard, Send, X, AlertTriangle, Loader2 } from 'lucide-react';
import { Clip, ChatMessage, ToolAction, PlanStep, VideoIntent } from '../../types';
import { chatWithGemini, performDeepAnalysis } from '../../services/gemini';
import { rangeToGeminiParts } from '../../services/geminiAdapter';
import { ChatSuggestionCard } from './ChatSuggestionCard';
import { PlanReviewCard } from './PlanReviewCard';

interface AIAssistantProps {
  selectedClip: Clip | null;
  onRequestRangeSelect: () => void;
  isSelectingRange: boolean;
  timelineRange: { start: number, end: number } | null;
  allClips: Clip[];
  mediaRefs: React.MutableRefObject<{[key: string]: HTMLVideoElement | HTMLAudioElement | null}>;
  clipsRef: React.MutableRefObject<Clip[]>;
  onExecuteAction: (action: ToolAction) => Promise<void>;
  onExecutePlan: (steps: PlanStep[]) => Promise<void>;
}

export const AIAssistant: React.FC<AIAssistantProps> = ({ 
    selectedClip, 
    onRequestRangeSelect, 
    isSelectingRange,
    timelineRange,
    allClips,
    mediaRefs,
    clipsRef,
    onExecuteAction,
    onExecutePlan
}) => {
  const [mode, setMode] = useState<'assist' | 'director'>('assist');
  const [assistQuery, setAssistQuery] = useState('');
  const [activeScope, setActiveScope] = useState<any | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [videoIntent, setVideoIntent] = useState<VideoIntent | null>(null);

  // ... (Scope logic same as before) ...

  const handleApplyAction = async (action: ToolAction) => {
      setChatHistory(prev => [...prev, { role: 'system', text: `Applying ${action.button_label}...` }]);
      await onExecuteAction(action);
  };

  const handleExecutePlan = async (steps: PlanStep[]) => {
      // Delegate to Orchestrator via App prop
      await onExecutePlan(steps);
  };

  const processResponse = async (
      currentHistory: ChatMessage[], 
      messagePayload: any,
      retryCount: number = 0
  ) => {
      if (retryCount > 2) return;

      try {
          const response = await chatWithGemini(
              currentHistory.map(m => ({ role: m.role, text: m.text })), 
              messagePayload,
              videoIntent || undefined
          );

          if (response.intentUpdate) {
              setVideoIntent(prev => ({ ...prev, ...response.intentUpdate }));
          }

          if (response.shouldAnalyze) {
              // Analysis logic same as before, simplified for this snippet
              const report = await performDeepAnalysis(await rangeToGeminiParts({ start:0, end:10, tracks:[] }, allClips, mediaRefs.current));
              const systemReportMsg: ChatMessage = { role: 'system', text: `[ANALYSIS]:\n${report}` };
              setChatHistory(prev => [...prev, systemReportMsg]);
              await processResponse([...currentHistory, systemReportMsg], "Analysis done.", retryCount + 1);
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
          setChatHistory(prev => [...prev, { role: 'model', text: "Error connecting to Director agent." }]);
      }
  };

  const handleSendMessage = async () => {
      if (!assistQuery.trim()) return;
      const userMessage = assistQuery;
      setAssistQuery('');
      setIsProcessing(true);
      
      const newHistory = [...chatHistory, { role: 'user' as const, text: userMessage }];
      setChatHistory(newHistory);

      // Simple timeline summary for context
      const timelineContext = `Timeline has ${allClips.length} clips. Total duration: ${allClips.reduce((acc,c)=>Math.max(acc,c.startTime+c.duration),0).toFixed(1)}s`;
      const fullMessage = `${userMessage}\n\n[Context: ${timelineContext}]`;

      try {
          await processResponse(newHistory, fullMessage);
      } finally {
          setIsProcessing(false);
      }
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border-l border-neutral-800 text-neutral-200 font-sans relative z-50">
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          <div className="space-y-6">
            {chatHistory.map((msg, i) => (
                <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                    {msg.text && (
                        <div className={`max-w-[85%] p-3 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap ${msg.role === 'user' ? 'bg-blue-600/20 text-blue-100' : 'bg-neutral-800'}`}>
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
            {isProcessing && <Loader2 size={16} className="animate-spin text-purple-400" />}
          </div>
      </div>
      <div className="p-3 border-t border-neutral-800 bg-neutral-900">
          <div className="relative flex items-center bg-neutral-950 border border-neutral-800 rounded-2xl px-2 py-1">
            <input
              ref={inputRef}
              type="text"
              value={assistQuery}
              onChange={(e) => setAssistQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              disabled={isProcessing}
              placeholder="Ask the Director..."
              className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder:text-neutral-600 py-2 min-w-[50px]"
            />
            <button onClick={handleSendMessage} disabled={isProcessing} className="p-2 hover:bg-neutral-800 rounded-xl text-purple-400 transition-colors shrink-0 disabled:opacity-50">
              <Send size={14} />
            </button>
          </div>
      </div>
    </div>
  );
};
