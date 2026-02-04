
import { EyesAgent } from './eyes';
import { BrainAgent } from './brain';
import { HandsAgent } from './hands';
import { VerifierAgent } from './verifier';
import { Clip } from '../../types';
import { timelineStore } from '../../timeline/store';

export class AgenticLoop {
  constructor(
    private eyes: EyesAgent,
    private brain: BrainAgent,
    private hands: HandsAgent,
    private verifier: VerifierAgent,
    private onThought: (agent: 'eyes' | 'brain' | 'hands' | 'verifier' | 'system', thought: string) => void
  ) {}

  async run(userIntent: string, clips: Clip[], mediaRefs: any): Promise<void> {
    let iteration = 0;
    const MAX_ITERATIONS = 3;
    let currentIntent = userIntent;

    try {
        while (iteration < MAX_ITERATIONS) {
        iteration++;
        this.onThought('system', `🔄 Starting Agent Loop (Iteration ${iteration}/${MAX_ITERATIONS})...`);

        // Capture state before loop actions
        const preState = [...timelineStore.getClips()];

        // STEP 1: EYES
        // Only run eyes on first iteration or if significant changes happened
        this.onThought('system', "👀 Activating Perception...");
        const analysis = await this.eyes.analyze(timelineStore.getClips(), mediaRefs);
        this.onThought('eyes', analysis.thought);

        // STEP 2: BRAIN
        this.onThought('system', "🧠 Activating Planning...");
        const brainOutput = await this.brain.plan(currentIntent, analysis, timelineStore.getClips());
        this.onThought('brain', brainOutput.thought);

        if (!brainOutput.plan.steps || brainOutput.plan.steps.length === 0) {
            this.onThought('system', "🛑 Brain could not formulate a plan. Stopping.");
            return;
        }

        // STEP 3: HANDS
        this.onThought('system', "✋ Activating Execution...");
        for (const step of brainOutput.plan.steps) {
            const result = await this.hands.execute(step);
            this.onThought('hands', result.thought);
            
            if (!result.success) {
            this.onThought('system', `❌ Execution failed: ${result.error}`);
            return; 
            }
        }

        // STEP 4: VERIFIER
        this.onThought('system', "✅ Activating Verification...");
        const postState = [...timelineStore.getClips()];
        const verification = await this.verifier.verify(currentIntent, "Agentic Loop Execution", preState, postState);
        this.onThought('verifier', verification.thought);

        if (verification.passed) {
            this.onThought('system', `✨ Goal Achieved! All checks passed.`);
            return; 
        } else {
            const issues = verification.checks.structural.issues?.join(', ') || verification.checks.intentAlignment.reasoning;
            this.onThought('system', `⚠️ Issues detected: ${issues}`);
            
            if (iteration >= MAX_ITERATIONS) {
            this.onThought('system', `🛑 Max iterations reached. Stopping to prevent infinite loop.`);
            return;
            }
            
            // Adjust intent for next loop to fix issues
            currentIntent = `Fix these issues: ${issues}. Previous goal: ${userIntent}`;
            this.onThought('brain', `🔄 Re-planning to fix detected issues...`);
            
            // Wait a bit for UI readability
            await new Promise(r => setTimeout(r, 1000));
        }
        }
    } catch (e: any) {
        console.error("Loop Error", e);
        this.onThought('system', `💥 Critical Agent Error: ${e.message}`);
    }
  }
}
