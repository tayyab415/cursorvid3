
import React, { useState, useRef, useEffect } from 'react';
import { Send, Loader2, Play, Eye, Brain, Hand, ShieldCheck, Terminal } from 'lucide-react';
import { Clip, ChatMessage, ToolAction } from '../../types';
import { ChatSuggestionCard } from './ChatSuggestionCard';

interface AIAssistantProps {
  selectedClip: Clip | null;
  onRequestRangeSelect: () => void;
  isSelectingRange: boolean;
  timelineRange: { start: number, end: number } | null;
  allClips: Clip[];
  mediaRefs: React.MutableRefObject<{[key: string]: HTMLVideoElement | HTMLAudioElement | null}>;
  onExecuteAction: (action: ToolAction) => Promise<void>;
  // Loop runner triggers
  onRunAgentLoop: (message: string) => Promise<void>;
  chatHistory: ChatMessage[];
  isProcessing: boolean;
}

export const AIAssistant: React.FC<AIAssistantProps> = ({ 
    selectedClip, 
    allClips,
    onExecuteAction,
    onRunAgentLoop,
    chatHistory,
    isProcessing
}) => {
  const [assistQuery, setAssistQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatHistory]);

  const handleSendMessage = async () => {
      if (!assistQuery.trim() || isProcessing) return;
      const msg = assistQuery;
      setAssistQuery('');
      await onRunAgentLoop(msg);
  };

  const getAgentIcon = (type?: string) => {
      switch(type) {
          case 'eyes': return <Eye size={14} className="text-blue-400" />;
          case 'brain': return <Brain size={14} className="text-purple-400" />;
          case 'hands': return <Hand size={14} className="text-emerald-400" />;
          case 'verifier': return <ShieldCheck size={14} className="text-yellow-400" />;
          case 'system': return <Terminal size={14} className="text-neutral-500" />;
          default: return <Terminal size={14} className="text-neutral-500" />;
      }
  };

  const getAgentLabel = (type?: string) => {
      switch(type) {
          case 'eyes': return 'Perception';
          case 'brain': return 'Planner';
          case 'hands': return 'Execution';
          case 'verifier': return 'Verifier';
          case 'system': return 'System';
          default: return 'System';
      }
  };

  const getAgentColor = (type?: string) => {
      switch(type) {
          case 'eyes': return 'border-blue-500/30 bg-blue-950/20 text-blue-100';
          case 'brain': return 'border-purple-500/30 bg-purple-950/20 text-purple-100';
          case 'hands': return 'border-emerald-500/30 bg-emerald-950/20 text-emerald-100';
          case 'verifier': return 'border-yellow-500/30 bg-yellow-950/20 text-yellow-100';
          case 'system': return 'border-neutral-700/50 bg-neutral-900 text-neutral-400 font-mono text-[10px]';
          default: return 'bg-neutral-800 text-neutral-200';
      }
  };

  return (
    <div className="flex flex-col h-full bg-neutral-900 border-l border-neutral-800 text-neutral-200 font-sans relative z-50">
      <div className="p-3 border-b border-neutral-800 bg-neutral-900 shadow-sm">
          <h2 className="text-xs font-bold uppercase tracking-widest text-neutral-500 flex items-center gap-2">
              <Brain size={12} /> Agent Loop
          </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4" ref={scrollRef}>
          {chatHistory.length === 0 && (
              <div className="text-center mt-10 opacity-50 space-y-2">
                  <Brain size={32} className="mx-auto text-neutral-600" />
                  <p className="text-xs text-neutral-400">Ready to edit.</p>
              </div>
          )}
          
          {chatHistory.map((msg, i) => {
             const isAgent = msg.role === 'agent' || msg.role === 'system';
             const isUser = msg.role === 'user';
             
             if (isUser) {
                 return (
                     <div key={i} className="flex justify-end">
                         <div className="bg-blue-600/20 text-blue-100 border border-blue-500/20 rounded-2xl rounded-tr-sm px-4 py-2 text-sm max-w-[90%]">
                             {msg.text}
                         </div>
                     </div>
                 );
             }

             // Agent Message
             return (
                 <div key={i} className={`flex gap-3 animate-in fade-in slide-in-from-left-2 duration-300`}>
                     <div className={`mt-0.5 shrink-0 w-6 h-6 rounded-full flex items-center justify-center border bg-neutral-800 border-neutral-700`}>
                         {getAgentIcon(msg.agentType)}
                     </div>
                     <div className="flex-1 space-y-1">
                         <div className="flex items-center gap-2">
                             <span className={`text-[10px] font-bold uppercase tracking-wider ${msg.agentType === 'system' ? 'text-neutral-500' : 'text-neutral-300'}`}>
                                 {getAgentLabel(msg.agentType)}
                             </span>
                             {msg.agentType === 'verifier' && <span className="text-[10px] text-yellow-500/50">Checking safety...</span>}
                         </div>
                         <div className={`rounded-xl px-3 py-2 text-xs border ${getAgentColor(msg.agentType)}`}>
                             {msg.text}
                         </div>
                         {msg.toolAction && (
                            <div className="mt-2">
                                <ChatSuggestionCard action={msg.toolAction} onApply={onExecuteAction} />
                            </div>
                         )}
                     </div>
                 </div>
             );
          })}
          
          {isProcessing && (
              <div className="flex items-center gap-2 text-xs text-neutral-500 animate-pulse pl-9">
                  <Loader2 size={10} className="animate-spin" /> Thinking...
              </div>
          )}
      </div>

      <div className="p-3 border-t border-neutral-800 bg-neutral-900">
          <div className="relative flex items-center bg-neutral-950 border border-neutral-800 rounded-2xl px-2 py-1 focus-within:border-purple-500/50 transition-colors">
            <input
              ref={inputRef}
              type="text"
              value={assistQuery}
              onChange={(e) => setAssistQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              disabled={isProcessing}
              placeholder="Trim silence, add subtitles..."
              className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder:text-neutral-600 py-2 min-w-[50px] px-2"
            />
            <button onClick={handleSendMessage} disabled={isProcessing || !assistQuery.trim()} className="p-2 hover:bg-neutral-800 rounded-xl text-purple-400 transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed">
              <Send size={14} />
            </button>
          </div>
      </div>
    </div>
  );
};
