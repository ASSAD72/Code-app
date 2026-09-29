import { ErrorAnalysis, ExecutionPlan, LocalModelInfo, Patch, ToolCallRequest, ProjectType } from '@core/types';

/**
 * LocalModelProvider — spec section 20. This interface is CodeX's entire
 * surface area for AI. It is intentionally narrow: a model behind this
 * interface can propose plans, tool calls, error diagnoses, and patches,
 * but it never executes anything itself — RepairEngine, BuildEngine, and
 * ToolExecutor decide what to do with what it proposes (spec section 19's
 * security boundary).
 *
 * Concrete implementations: OllamaProvider (real, talks to a running
 * Ollama daemon's HTTP API), LlamaCppProviderInterface (real HTTP client
 * shape for llama.cpp's server mode), and NoOpLocalModelProvider (used
 * when no local model is configured — spec section 2/20: "CodeX must
 * also work without AI").
 */
export interface LocalModelProvider {
  getInfo(): Promise<LocalModelInfo>;

  /** Turn a natural-language goal into a structured, human-reviewable execution plan. */
  generatePlan(goal: string, context: { projectType?: ProjectType; availableTools: string[] }): Promise<ExecutionPlan | null>;

  /** Given an already-approved plan step, propose the structured tool calls to fulfill it. */
  generateToolCalls(stepDescription: string, availableTools: string[]): Promise<ToolCallRequest[]>;

  /** Diagnose a build/test failure from raw output. Returns null if no model is available. */
  analyzeBuildError(rawOutput: string, context: { projectType?: ProjectType }): Promise<ErrorAnalysis | null>;

  /** Propose a patch (full file contents per changed file) for a diagnosed error. Returns null if no model is available. */
  generatePatch(analysis: ErrorAnalysis, context: { projectSourcePath: string }): Promise<Patch | null>;
}

/**
 * NoOpLocalModelProvider — the "CodeX works without AI" implementation
 * (spec section 2: "CodeX Desktop must also work without AI" / section
 * 20: "If no Local Model exists, CodeX must work without AI using manual
 * commands"). Every method returns null/empty rather than throwing, so
 * callers (RepairEngine especially) degrade gracefully to
 * manual-intervention mode instead of crashing.
 */
export class NoOpLocalModelProvider implements LocalModelProvider {
  async getInfo(): Promise<LocalModelInfo> {
    return { provider: 'none', available: false };
  }

  async generatePlan(): Promise<ExecutionPlan | null> {
    return null;
  }

  async generateToolCalls(): Promise<ToolCallRequest[]> {
    return [];
  }

  async analyzeBuildError(): Promise<ErrorAnalysis | null> {
    return null;
  }

  async generatePatch(): Promise<Patch | null> {
    return null;
  }
}
