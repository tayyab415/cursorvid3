
import { Type, FunctionDeclaration } from "@google/genai";

export const TIMELINE_PRIMITIVES: FunctionDeclaration[] = [
  {
      name: 'move_clip',
      description: 'Move a clip to a specific time and track. Use this for arranging or reordering the timeline.',
      parameters: {
          type: Type.OBJECT,
          properties: {
              clipId: { type: Type.STRING },
              startTime: { type: Type.NUMBER, description: 'New start time in seconds' },
              trackId: { type: Type.NUMBER, description: 'Target track (0-bottom, 3-top)' }
          },
          required: ['clipId', 'startTime', 'trackId']
      }
  },
  {
      name: 'request_user_assistance',
      description: 'Ask the human user to do something you cannot do (e.g. upload a file, record voice).',
      parameters: {
          type: Type.OBJECT,
          properties: {
              message: { type: Type.STRING, description: 'The prompt to show the user (e.g. "Please upload a logo image")' },
              actionType: { type: Type.STRING, enum: ['upload', 'record', 'confirm'], description: 'The type of button to show' }
          },
          required: ['message', 'actionType']
      }
  },
  {
    name: 'update_clip_property',
    description: 'Modify standard properties: duration, volume, speed. Use move_clip for position.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        clipId: { type: Type.STRING, description: 'Target clip ID (required)' },
        property: { 
          type: Type.STRING, 
          enum: ['duration', 'volume', 'speed'],
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
        voice: { type: Type.STRING, enum: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'], description: 'Voice personality' },
        insertTime: { type: Type.NUMBER, description: 'Timeline position (seconds)' },
        trackId: { type: Type.NUMBER, description: 'Audio track (default: 2)' }
      },
      required: ['text', 'insertTime']
    }
  },
  {
    name: 'generate_video_asset',
    description: 'Generate a NEW video using Veo. Use when the user requests content that does not exist or to replace a placeholder.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'Detailed visual description for Veo.' },
        model: { type: Type.STRING, enum: ['veo-3.1-fast-generate-preview', 'veo-3.1-generate-preview'], description: 'Use "fast" for drafts, "generate" for high quality.' },
        duration: { type: Type.NUMBER, description: 'Duration in seconds (4 or 8).' },
        insertTime: { type: Type.NUMBER, description: 'Timeline position.' },
        trackId: { type: Type.NUMBER, description: 'Target track.' }
      },
      required: ['prompt', 'insertTime']
    }
  },
  {
    name: 'generate_image_asset',
    description: 'Generate a NEW image using Gemini. Use for static backgrounds, title cards, or B-roll.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'Detailed visual description.' },
        model: { type: Type.STRING, enum: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'], description: 'Use "flash" for speed, "pro" for high fidelity.' },
        insertTime: { type: Type.NUMBER, description: 'Timeline position.' },
        duration: { type: Type.NUMBER, description: 'How long to show the image.' },
        trackId: { type: Type.NUMBER, description: 'Target track.' }
      },
      required: ['prompt', 'insertTime', 'duration']
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
      description: 'Apply visual transformations like Zoom, Pan, or Scale.',
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
