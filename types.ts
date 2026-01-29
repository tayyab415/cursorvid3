
export interface Clip {
  id: string;
  title: string;
  duration: number; // in seconds (Timeline duration)
  startTime: number; // Where it sits on the timeline
  sourceStartTime: number; // Where it starts in the original video file
  type?: 'video' | 'image' | 'audio' | 'text';
  sourceUrl?: string;
  text?: string; // For caption clips
  textStyle?: {
    fontFamily: string;
    fontSize: number;
    isBold: boolean;
    isItalic: boolean;
    isUnderline: boolean;
    color: string;
    backgroundColor: string;
    backgroundOpacity: number;
    align: 'left' | 'center' | 'right';
  };
  totalDuration?: number; // The full length of the source media file (if applicable)
  trackId: number; // 0 is bottom, higher numbers are stacked on top
  transform?: {
    x: number; // percentage relative to container width (0 is center)
    y: number; // percentage relative to container height (0 is center)
    scale: number; // 1 is 100%
    rotation: number; // degrees
  };
  speed?: number; // Playback speed multiplier (default 1)
  volume?: number; // Audio volume 0-1 (default 1)
}

export interface PlanStep {
  id: string;
  intent: string;              // Free-form, human-readable
  category?: 'visual' | 'audio' | 'pacing' | 'style';
  reasoning: string;
  timestamp?: number;
  status: 'pending' | 'approved' | 'rejected';
}

export interface EditPlan {
  goal: string;
  analysis: string;
  steps: PlanStep[];
}

export interface VideoIntent {
  platform?: string; // e.g. TikTok, YouTube, Internal
  goal?: string;     // e.g. Viral, Educational, Storytelling
  tone?: string;     // e.g. Energetic, Cinematic, Calm
}

export interface TimelineOperation {
  type: 'move' | 'trim' | 'volume' | 'delete';
  clipId: string;
  // Parameters depending on type
  newStartTime?: number;
  newTrackId?: number;
  newDuration?: number;
  newVolume?: number;
}

// Contract for Gemini Tool Calls ("suggest_ai_action")
export interface ToolAction {
  tool_id: "GENERATE_TRANSITION" | "GENERATE_VOICEOVER" | "SMART_TRIM" | "EDIT_TIMELINE";
  button_label: string;
  reasoning: string;
  timestamp?: number;
  action_content?: string; 
  parameters?: {
     operations?: TimelineOperation[];
     [key: string]: any;
  };
}

export interface ChatMessage {
  role: 'user' | 'model' | 'system';
  text: string;
  suggestions?: Suggestion[];
  toolAction?: ToolAction; // For single-hit actions
  plan?: EditPlan;         // For the Orchestrator workflow
  intentUpdate?: VideoIntent; // When the model infers new intent
}

export interface Suggestion {
  label: string;
  description: string;
  reasoning: string;
  clips: Clip[];
}

export interface TimelineRange {
  start: number;
  end: number;
  tracks: {
    id: number;
    clips: Clip[];
  }[];
}

export interface PlacementDecision {
  strategy: 'ripple' | 'overlay' | 'replace';
  startTime: number;
  trackId: number;
  reasoning: string;
}
