
import React, { useState, useEffect, useRef } from 'react';
import { Wand2, Clapperboard, Sparkles, Mic, Video, Type, Zap, Loader2, Send, Clock, X } from 'lucide-react';
import { Clip, TimelineRange, ChatMessage, ToolAction } from '../../types';
import { chatWithGemini } from '../../services/gemini';
import { rangeToGeminiParts } from '../../services/geminiAdapter';
import { ChatSuggestionCard } from './ChatSuggestionCard';

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
  // NEW PROPS FOR ADAPTER ACCESS
  allClips: Clip[];
  mediaRefs: React.MutableRefObject<{[key: string]: HTMLVideoElement | HTMLAudioElement | null}>;
  // NEW: Handler for executed actions
  onExecuteAction: (action: ToolAction) => void;
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
  const [directorGoal, setDirectorGoal] = useState('');
  
  // Scope State
  const [activeScope, setActiveScope] = useState<Scope | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Chat State
  const [isProcessing, setIsProcessing] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  // Auto-update scope when dragging range or when range updates from parent (e.g. Modal Confirm)
  useEffect(() => {
      if (timelineRange) {
          const start = timelineRange.start.toFixed(1);
          const end = timelineRange.end.toFixed(1);
          setActiveScope({
              type: 'range',
              label: `${start}s - ${end}s`,
              data: timelineRange
          });
      }
  }, [timelineRange]);

  // Clean up selection state when done
  useEffect(() => {
      if (!isSelectingRange && timelineRange && activeScope?.type === 'range') {
          // Finalize selection - focus input
          inputRef.current?.focus();
      }
  }, [isSelectingRange, timelineRange]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setAssistQuery(val);

      // Trigger Logic: Immediately start timeline selection on '#'
      if (val.endsWith('#') && !activeScope) {
          setAssistQuery(prev => prev.slice(0, -1)); // Remove the trigger character
          onRequestRangeSelect();
      }
  };

  const clearScope = () => {
      setActiveScope(null);
      setAssistQuery(''); 
      inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Backspace' && !assistQuery && activeScope) {
          // Remove scope if backspacing empty input
          clearScope();
      } else if (e.key === 'Enter') {
          handleSendMessage();
      }
  };

  const handleApplyAction = (action: ToolAction) => {
      // Add a system confirmation message
      setChatHistory(prev => [...prev, { 
          role: 'system', 
          text: `Applying ${action.button_label}...` 
      }]);
      
      // Execute Logic in Parent
      onExecuteAction(action);
  };

  const handleSendMessage = async () => {
      if (!assistQuery.trim() && !activeScope) return;
      
      const userMessage = assistQuery;
      setAssistQuery(''); // Clear input immediately
      setIsProcessing(true);

      // Determine display text for history (handle empty input with range)
      const displayMessage = userMessage || (activeScope ? `Analyze selection: ${activeScope.label}` : "Analyze this");

      // Optimistic UI update
      const newHistory = [...chatHistory, { role: 'user' as const, text: displayMessage }];
      setChatHistory(newHistory);

      try {
          let apiMessage: any = userMessage;

          // If we have a range scope, use the Adapter to build a Multimodal payload
          if (activeScope?.type === 'range' && activeScope.data) {
              const range = activeScope.data as { start: number, end: number };
              
              // Construct full TimelineRange object for the adapter
              const timelineRangeObj: TimelineRange = {
                  start: range.start,
                  end: range.end,
                  tracks: [] // Adapter handles filtering, we pass full list
              };
              
              // ADAPTER MAGIC: Convert range to real media parts
              const parts = await rangeToGeminiParts(timelineRangeObj, allClips, mediaRefs.current);
              
              // Add user text prompt to the parts
              parts.push({ text: userMessage || "Analyze this selection." });
              
              apiMessage = parts;
          }

          const response = await chatWithGemini(
              // IMPORTANT: Pass chatHistory (previous turns) only.
              // The SDK will append the new `apiMessage` as the current turn.
              chatHistory.map(m => ({ role: m.role, text: m.text })), 
              apiMessage
          );

          setChatHistory(prev => [...prev, { 
              role: 'model', 
              text: response.text, 
              toolAction: response.toolAction 
          }]);
      } catch (e) {
          console.error(e);
          setChatHistory(prev => [...prev, { role: 'model', text: "Sorry, I had trouble analyzing that." }]);
      } finally {
          setIsProcessing(false);
      }
  };

  // Mock Actions based on clip type
  const getQuickActions = () => {
    if (!selectedClip) return [];
    
    switch (selectedClip.type) {
      case 'video':
        return [
          { label: 'Stabilize', icon: Video },
          { label: 'Smart Crop', icon: Zap },
          { label: 'Color Grade', icon: Sparkles },
        ];
      case 'audio':
        return [
          { label: 'Remove Noise', icon: Mic },
          { label: 'Enhance Voice', icon: Sparkles },
        ];
      case 'text':
        return [
          { label: 'Fix Grammar', icon: Type },
          { label: 'Translate', icon: Wand2 },
        ];
      default:
        return [
            { label: 'Magic Fix', icon: Sparkles }
        ];
    }
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border-l border-neutral-800 text-neutral-200 font-sans relative z-50">
      
      {/* 1. Header (Mode Switch) */}
      <div className="p-3 border-b border-neutral-800 bg-neutral-900 sticky top-0 z-10">
        <div className="flex bg-neutral-950 p-1 rounded-lg border border-neutral-800">
          <button
            onClick={() => setMode('assist')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${
              mode === 'assist' 
                ? 'bg-neutral-800 text-white shadow-sm' 
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            <Wand2 size={14} />
            Assist
          </button>
          <button
            onClick={() => setMode('director')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all ${
              mode === 'director' 
                ? 'bg-neutral-800 text-white shadow-sm' 
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            <Clapperboard size={14} />
            Director
          </button>
        </div>
      </div>

      {/* 2. Content Area */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        
        {/* MODE A: ASSIST */}
        {mode === 'assist' && (
          <div className="space-y-6">
            
            {/* Chat History */}
            {chatHistory.length > 0 ? (
                <div className="space-y-4 mb-4">
                    {chatHistory.map((msg, i) => (
                        <div key={i} className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                            <div className={`max-w-[85%] p-3 rounded-lg text-xs leading-relaxed ${msg.role === 'user' ? 'bg-blue-600/20 text-blue-100 border border-blue-500/30' : 'bg-neutral-800 border border-neutral-700'}`}>
                                {msg.text}
                            </div>
                            
                            {/* Render Structured Tool Action Widget if present */}
                            {msg.toolAction && (
                                <div className="w-[85%]">
                                    <ChatSuggestionCard 
                                        action={msg.toolAction} 
                                        onApply={handleApplyAction} 
                                    />
                                </div>
                            )}
                        </div>
                    ))}
                    {isProcessing && (
                         <div className="flex justify-start">
                             <div className="bg-neutral-800/50 p-3 rounded-lg border border-neutral-800 flex items-center gap-2">
                                <Loader2 size={12} className="animate-spin text-purple-400" />
                                <span className="text-xs text-neutral-400">Analyzing media...</span>
                             </div>
                         </div>
                    )}
                </div>
            ) : (
                /* Default State */
                selectedClip ? (
                  <div className="bg-neutral-800/50 rounded-lg p-3 border border-neutral-800">
                    <div className="flex items-start justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-neutral-500">Selected Clip</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 capitalize">
                        {selectedClip.type || 'Media'}
                      </span>
                    </div>
                    <h3 className="font-medium text-sm text-white truncate mb-1" title={selectedClip.title}>
                      {selectedClip.title}
                    </h3>
                    <p className="text-xs text-neutral-400 font-mono">
                      Duration: {selectedClip.duration.toFixed(2)}s
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-32 text-center space-y-3 opacity-60">
                    <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center">
                      <Wand2 size={18} className="text-neutral-500" />
                    </div>
                    <p className="text-sm text-neutral-400">Select a clip or type # to analyze range.</p>
                  </div>
                )
            )}

            {/* Quick Actions (Only show if no history to reduce clutter) */}
            {selectedClip && chatHistory.length === 0 && (
              <div>
                <h4 className="text-xs font-semibold text-neutral-500 uppercase mb-3">Quick Actions</h4>
                <div className="grid grid-cols-2 gap-2">
                  {getQuickActions().map((action, idx) => (
                    <button 
                      key={idx}
                      className="flex flex-col items-center justify-center gap-2 p-3 bg-neutral-800 hover:bg-neutral-750 border border-neutral-700 hover:border-neutral-600 rounded-lg transition-all group"
                    >
                      <action.icon size={16} className="text-purple-400 group-hover:text-purple-300" />
                      <span className="text-[10px] font-medium">{action.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* MODE B: DIRECTOR */}
        {mode === 'director' && (
          <div className="space-y-6">
            {/* Goal Input */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-neutral-500 uppercase">Project Goal</label>
              <textarea
                value={directorGoal}
                onChange={(e) => setDirectorGoal(e.target.value)}
                placeholder="E.g., Create a 30s viral teaser emphasizing the fast-paced action..."
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg p-3 text-sm focus:outline-none focus:border-purple-500/50 min-h-[100px] resize-none placeholder:text-neutral-600"
              />
              <button className="w-full py-2 bg-gradient-to-r from-purple-600 to-blue-600 rounded-md text-xs font-bold text-white shadow-lg hover:shadow-purple-500/20 transition-all">
                Generate Plan
              </button>
            </div>

            {/* Suggested Drafts */}
            <div>
              <h4 className="text-xs font-semibold text-neutral-500 uppercase mb-3">Suggested Drafts</h4>
              <div className="space-y-3">
                {/* Mock Plan Card 1 */}
                <div className="p-3 bg-neutral-800 border border-neutral-700 rounded-lg hover:border-purple-500/50 cursor-pointer transition-all">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-white">Option A: High Energy</span>
                    <span className="text-[10px] bg-neutral-700 px-1.5 py-0.5 rounded text-neutral-300">30s</span>
                  </div>
                  <p className="text-[10px] text-neutral-400 leading-relaxed">
                    Focuses on quick cuts and motion. Rearranges intro to start with action.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4. Footer Input (Assist Mode Only) */}
      {mode === 'assist' && (
        <div className="p-3 border-t border-neutral-800 bg-neutral-900 relative z-[60]">
          <div className="relative flex items-center bg-neutral-950 border border-neutral-800 rounded-full px-2 py-1 focus-within:border-purple-500 focus-within:ring-1 focus-within:ring-purple-500/50 transition-all">
            
            {/* CHIP VISUALIZATION */}
            {activeScope && (
                <div className="flex items-center gap-1 bg-blue-600/20 border border-blue-500/30 text-blue-200 rounded-full pl-2 pr-1 py-0.5 mr-1 shrink-0 animate-in fade-in zoom-in-95 duration-200">
                    <span className="text-[10px] font-medium leading-none whitespace-nowrap">{activeScope.label}</span>
                    <button onClick={clearScope} className="p-0.5 hover:bg-blue-500/20 rounded-full text-blue-300 transition-colors"><X size={10} /></button>
                </div>
            )}

            <input
              ref={inputRef}
              type="text"
              value={assistQuery}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={isSelectingRange || isProcessing}
              placeholder={activeScope ? "Ask about this selection..." : "Type # to select range..."}
              className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder:text-neutral-500 py-1.5 min-w-[50px]"
            />
            <button onClick={handleSendMessage} disabled={isProcessing} className="p-1.5 hover:bg-neutral-800 rounded-full text-purple-400 transition-colors shrink-0 disabled:opacity-50">
              <Send size={14} />
            </button>
          </div>
          {isSelectingRange && (
              <div className="absolute top-0 left-0 right-0 -mt-10 flex justify-center animate-in fade-in slide-in-from-bottom-2 pointer-events-none">
                  <div className="bg-yellow-500/90 text-black text-xs font-bold px-3 py-1 rounded-full shadow-lg backdrop-blur flex items-center gap-2">
                      <Clock size={12} />
                      Drag on timeline to select range
                  </div>
              </div>
          )}
        </div>
      )}
    </div>
  );
};
