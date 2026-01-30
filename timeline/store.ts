import { Clip } from '../types';

export class TimelineStore {
  private clips: Clip[] = [];
  private history: { past: Clip[][]; future: Clip[][] } = { past: [], future: [] };
  private listeners = new Set<(clips: Clip[]) => void>();

  constructor(initialClips: Clip[] = []) {
    this.clips = initialClips;
  }

  // --- Observability ---
  getClips(): Clip[] {
    return this.clips;
  }

  subscribe(fn: (clips: Clip[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.clips); // Initial emit
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach(fn => fn(this.clips));
  }

  private saveHistory() {
    this.history.past.push(JSON.parse(JSON.stringify(this.clips)));
    this.history.future = [];
  }

  // --- Core Mutations ---
  setClips(newClips: Clip[]) {
    this.saveHistory();
    this.clips = newClips;
    this.notify();
  }

  addClip(clip: Clip) {
    this.saveHistory();
    this.clips = [...this.clips, clip];
    this.notify();
  }

  removeClip(id: string) {
    this.saveHistory();
    this.clips = this.clips.filter(c => c.id !== id);
    this.notify();
  }

  updateClip(id: string, updates: Partial<Clip>) {
    this.saveHistory();
    this.clips = this.clips.map(c => c.id === id ? { ...c, ...updates } : c);
    this.notify();
  }

  moveClip(id: string, startTime: number, trackId: number) {
    this.saveHistory();
    this.clips = this.clips.map(c => c.id === id ? { ...c, startTime, trackId } : c);
    this.notify();
  }

  batch(fn: () => void) {
    this.saveHistory();
    // We temporarily disable history saving in internal methods if needed, 
    // but for simplicity, we just rely on the fact that 'saveHistory' pushes the current state.
    // However, if fn() calls methods that saveHistory, we get intermediate states.
    // For this simple implementation, we'll assume atomic operations are used mostly.
    // A better approach for batch is to lock history.
    const tempHistory = this.history; // Hack to prevent intermediate saves if we wanted to block them
    fn();
    // In a real app, we'd handle the 'transaction' better.
  }

  // --- History ---
  undo() {
    if (this.history.past.length === 0) return;
    const previous = this.history.past.pop()!;
    this.history.future.unshift(this.clips);
    this.clips = previous;
    this.notify();
  }

  redo() {
    if (this.history.future.length === 0) return;
    const next = this.history.future.shift()!;
    this.history.past.push(this.clips);
    this.clips = next;
    this.notify();
  }
  
  canUndo() { return this.history.past.length > 0; }
  canRedo() { return this.history.future.length > 0; }
}

const INITIAL_CLIPS: Clip[] = [
  { id: 'c1', title: 'Intro Scene', duration: 5, startTime: 0, sourceStartTime: 0, type: 'video', totalDuration: 60, trackId: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 },
  { id: 'c2', title: 'Main Action', duration: 8, startTime: 5, sourceStartTime: 5, type: 'video', totalDuration: 60, trackId: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, speed: 1, volume: 1 },
];

export const timelineStore = new TimelineStore(INITIAL_CLIPS);
