
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

export interface AnalysisResult {
  summary: string;
  keyEvents: { timestamp: string; description: string }[];
  mood: string;
}

export interface Suggestion {
  label: string;
  description: string;
  reasoning: string;
  clips: Clip[];
}

export interface ChatMessage {
  role: 'user' | 'model' | 'system';
  text: string;
  suggestions?: Suggestion[];
}

// NEW: Editor Truth for a selection
export interface TimelineRange {
  start: number; // Global timeline start (seconds)
  end: number;   // Global timeline end (seconds)
  tracks: {
    id: number;
    clips: Clip[]; // Only clips intersecting this range
  }[];
}
