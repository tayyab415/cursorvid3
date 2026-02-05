export const AGENT_POLICY = {
  loop: {
    maxIterations: 4,
    replanDelayMs: 600,
    executionPulseMs: 350,
  },
  defaults: {
    tracks: {
      video: 1,
      audio: 2,
      text: 3,
    },
    models: {
      image: 'gemini-2.5-flash-image',
      video: 'veo-3.1-fast-generate-preview',
      voice: 'Kore',
      planner: 'gemini-3-flash-preview',
      verifier: 'gemini-3-flash-preview',
      eyes: 'gemini-3-flash-preview',
    },
  },
  approval: {
    alwaysRequireFor: ['generate_video_asset', 'generate_image_asset'] as const,
    voiceoverAutoApproveMaxChars: 240,
  },
} as const;

export const shouldRequireApproval = (operation: string, parameters: Record<string, any> = {}): boolean => {
  if (AGENT_POLICY.approval.alwaysRequireFor.includes(operation as any)) {
    return true;
  }

  if (operation === 'generate_voiceover') {
    const text = String(parameters.text || '');
    return text.length > AGENT_POLICY.approval.voiceoverAutoApproveMaxChars;
  }

  return false;
};

