import { TimelineStore } from './store';
import { Clip } from '../types';

export const TimelineOps = {
  updateClipProperty: (store: TimelineStore, clipId: string, property: keyof Clip, value: any) => {
    store.updateClip(clipId, { [property]: value });
  },

  rippleDelete: (store: TimelineStore, clipId: string) => {
    const clips = store.getClips();
    const clip = clips.find(c => c.id === clipId);
    if (!clip) return;

    // Use a batch-like manual update to ensure one history step (conceptually)
    // Here we just accept multiple history steps for simplicity or rely on store implementation
    store.removeClip(clipId);
    
    // Shift clips on the same track
    const clipsToShift = store.getClips().filter(c => c.trackId === clip.trackId && c.startTime > clip.startTime);
    clipsToShift.forEach(c => {
        store.updateClip(c.id, { startTime: Math.max(0, c.startTime - clip.duration) });
    });
  },

  trimClip: (store: TimelineStore, clipId: string, newDuration: number) => {
    store.updateClip(clipId, { duration: newDuration });
  },

  moveClip: (store: TimelineStore, clipId: string, startTime: number, trackId?: number) => {
    const clip = store.getClips().find(c => c.id === clipId);
    if (clip) {
        store.moveClip(clipId, startTime, trackId ?? clip.trackId);
    }
  },

  addClip: (store: TimelineStore, clip: Clip) => {
    store.addClip(clip);
  }
};
