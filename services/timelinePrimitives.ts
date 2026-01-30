import { Type, FunctionDeclaration } from "@google/genai";

export const TIMELINE_PRIMITIVES: FunctionDeclaration[] = [
  {
    name: 'update_clip_property',
    description: 'Modify any clip property: position, duration, volume, speed, trackId. Use this for moving clips or changing settings.',
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
    description: 'Create NEW audio content (TTS). Use update_clip_property for existing audio.',
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
  }
];
