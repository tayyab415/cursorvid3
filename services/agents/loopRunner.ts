
import { EyesAgent } from './eyes';
import { BrainAgent } from './brain';
import { HandsAgent } from './hands';
import { VerifierAgent } from './verifier';
import { Clip, ToolAction } from '../../types';
import { timelineStore } from '../../timeline/store';
import { AGENT_POLICY } from './agentPolicy';

export class AgenticLoop {
  constructor(
    private eyes: EyesAgent,
    private brain: BrainAgent,
    private hands: HandsAgent,
    private verifier: VerifierAgent,
    private onThought: (agent: 'eyes' | 'brain' | 'hands' | 'verifier' | 'system', thought: string, action?: ToolAction) => void,
    private onApprovalRequest?: (request: { tool: string, params: any }) => void
  ) {}

  async run(userIntent: string, clips: Clip[], mediaRefs: any): Promise<void> {
    let iteration = 0;
    const MAX_ITERATIONS = AGENT_POLICY.loop.maxIterations;
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
            
            // Check for Generation Approval Request
            if (result.approvalRequired) {
                this.onThought('system', `🔔 Pausing for User Approval: ${result.approvalRequired.tool}`);
                if (this.onApprovalRequest) {
                    this.onApprovalRequest(result.approvalRequired);
                }
                return; // Stop the loop to wait for user
            }

            // Check if Hands requested User Action (e.g. Upload)
            if (result.actionRequired) {
                const toolAction: ToolAction = {
                    tool_id: 'USER_ACTION_REQUEST' as any,
                    button_label: result.actionRequired.type === 'upload' ? 'Upload Media' : 'Confirm',
                    reasoning: result.actionRequired.message,
                    parameters: {}
                };
                this.onThought('system', `🔔 User Action Required: ${result.actionRequired.message}`, toolAction);
                return; // Stop the loop to wait for user
            }

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
            
            await new Promise(r => setTimeout(r, AGENT_POLICY.loop.replanDelayMs));
        }
        }
    } catch (e: any) {
        console.error("Loop Error", e);
        this.onThought('system', `💥 Critical Agent Error: ${e.message}`);
    }
  }
}
