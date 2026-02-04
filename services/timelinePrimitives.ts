
import { Type, FunctionDeclaration } from "@google/genai";

export const TIMELINE_PRIMITIVES: FunctionDeclaration[] = [
  {
    name: 'update_clip_property',
    description: 'Modify standard properties: position, duration, volume, speed, trackId. Use apply_visual_transform for zoom/pan.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        clipId: { type: Type.STRING, description: 'Target clip ID (required)' },
        property: { 
          type: Type.STRING, 
          enum: ['startTime', 'duration', 'volume', 'speed', 'trackId'],
          description: 'Property to modify'
        },
        value: { type: Type.NUMBER, description: 'New value' }
      },
      required: ['clipId', 'property', 'value']
    }
  },
  {
    name: 'ripple_delete',
    description: 'Delete clip and shift subsequent clips on the same track left to fill the gap.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        clipId: { type: Type.STRING }
      },
      required: ['clipId']
    }
  },
  {
    name: 'generate_voiceover',
    description: 'Create NEW audio content (TTS).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: { type: Type.STRING, description: 'Script to speak' },
        insertTime: { type: Type.NUMBER, description: 'Timeline position (seconds)' },
        trackId: { type: Type.NUMBER, description: 'Audio track (default: 2)' }
      },
      required: ['text', 'insertTime']
    }
  },
  {
      name: 'smart_trim',
      description: 'Trim a clip to a specific duration to tighten pacing.',
      parameters: {
          type: Type.OBJECT,
          properties: {
              clipId: { type: Type.STRING },
              newDuration: { type: Type.NUMBER }
          },
          required: ['clipId', 'newDuration']
      }
  },
  {
      name: 'split_clip',
      description: 'Split a video/audio clip into two parts at a specific time.',
      parameters: {
          type: Type.OBJECT,
          properties: {
              clipId: { type: Type.STRING, description: 'The clip to split' },
              splitTime: { type: Type.NUMBER, description: 'The timestamp (in timeline seconds) where the split occurs' }
          },
          required: ['clipId', 'splitTime']
      }
  },
  {
      name: 'apply_visual_transform',
      description: 'Apply visual transformations like Zoom, Pan, or Scale. Use this for "Zoom in", "Crop", or "Picture in Picture".',
      parameters: {
          type: Type.OBJECT,
          properties: {
              clipId: { type: Type.STRING },
              scale: { type: Type.NUMBER, description: '1.0 is normal size. >1 zooms in. <1 shrinks.' },
              x: { type: Type.NUMBER, description: 'Horizontal position (-0.5 to 0.5)' },
              y: { type: Type.NUMBER, description: 'Vertical position (-0.5 to 0.5)' },
              rotation: { type: Type.NUMBER, description: 'Rotation in degrees' }
          },
          required: ['clipId', 'scale']
      }
  },
  {
      name: 'add_text_overlay',
      description: 'Add a text element (title, caption, subtitle) to the timeline.',
      parameters: {
          type: Type.OBJECT,
          properties: {
              text: { type: Type.STRING, description: 'The content of the text' },
              startTime: { type: Type.NUMBER, description: 'Start time in seconds' },
              duration: { type: Type.NUMBER, description: 'Duration in seconds' },
              style: { type: Type.STRING, enum: ['subtitle', 'title', 'label'], description: 'Visual style preset' }
          },
          required: ['text', 'startTime', 'duration']
      }
  }
];
