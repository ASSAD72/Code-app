import { randomUUID } from 'crypto';
import { ErrorAnalysis, ExecutionPlan, LocalModelInfo, Patch, ToolCallRequest, ProjectType } from '@core/types';
import { LocalModelProvider } from '../LocalModelProvider';

/**
 * OllamaProvider — real implementation against Ollama's documented HTTP
 * API (default http://localhost:11434). No cloud AI API is used anywhere
 * in this file, per spec section 2's hard requirement.
 *
 * Honesty note: this makes genuine HTTP requests to Ollama's actual
 * `/api/generate` and `/api/tags` endpoints, in the exact shape Ollama
 * documents. It has not been exercised against a live Ollama daemon in
 * this authoring sandbox (no network egress here), so `getInfo()` will
 * correctly report unavailable in that environment. On a machine with
 * `ollama serve` running and a model pulled (e.g. `ollama pull
 * codellama`), these calls are real and will work as written.
 */
export class OllamaProvider implements LocalModelProvider {
  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly modelName: string = 'codellama'
  ) {}

  async getInfo(): Promise<LocalModelInfo> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) return { provider: 'ollama', available: false };
      const data = (await response.json()) as { models?: { name: string }[] };
      const hasModel = data.models?.some((m) => m.name.startsWith(this.modelName)) ?? false;
      return { provider: 'ollama', modelName: this.modelName, available: hasModel };
    } catch {
      return { provider: 'ollama', available: false };
    }
  }

  async generatePlan(
    goal: string,
    context: { projectType?: ProjectType; availableTools: string[] }
  ): Promise<ExecutionPlan | null> {
    const prompt = buildPlanPrompt(goal, context);
    const raw = await this.callOllama(prompt);
    if (!raw) return null;

    const parsed = tryParseJson<{ steps: { description: string; toolCalls: { toolName: string; input: Record<string, unknown> }[] }[] }>(
      raw
    );
    if (!parsed) return null;

    return {
      id: randomUUID(),
      goal,
      createdAt: new Date().toISOString(),
      steps: parsed.steps.map((s, i) => ({
        stepNumber: i + 1,
        description: s.description,
        toolCalls: s.toolCalls.map((tc) => ({
          toolName: tc.toolName,
          input: tc.input,
          requestId: randomUUID(),
        })),
      })),
    };
  }

  async generateToolCalls(stepDescription: string, availableTools: string[]): Promise<ToolCallRequest[]> {
    const prompt = `You are a tool-calling planner for a local development environment. Given the step description below, respond ONLY with a JSON array of tool calls, each with "toolName" (one of: ${availableTools.join(
      ', '
    )}) and "input" (an object). No prose, no markdown fences.\n\nStep: ${stepDescription}`;
    const raw = await this.callOllama(prompt);
    if (!raw) return [];

    const parsed = tryParseJson<{ toolName: string; input: Record<string, unknown> }[]>(raw);
    if (!parsed) return [];

    return parsed.map((tc) => ({ toolName: tc.toolName, input: tc.input, requestId: randomUUID() }));
  }

  async analyzeBuildError(rawOutput: string, context: { projectType?: ProjectType }): Promise<ErrorAnalysis | null> {
    const prompt = `You are a build error analyst for a ${
      context.projectType ?? 'software'
    } project. Analyze the following build/test output and respond ONLY with JSON of the shape {"errorSignature": string, "category": "syntax"|"dependency"|"type"|"runtime"|"test-failure"|"environment"|"unknown", "file": string|null, "line": number|null, "message": string, "suggestedFixSummary": string}. No prose, no markdown fences.\n\nOutput:\n${truncate(
      rawOutput,
      4000
    )}`;
    const raw = await this.callOllama(prompt);
    if (!raw) return null;

    const parsed = tryParseJson<Omit<ErrorAnalysis, 'rawOutput'>>(raw);
    if (!parsed) return null;

    return { ...parsed, rawOutput };
  }

  async generatePatch(analysis: ErrorAnalysis, context: { projectSourcePath: string }): Promise<Patch | null> {
    const prompt = `You are a code-repair assistant. An error was diagnosed as: ${analysis.message} (category: ${
      analysis.category
    }${analysis.file ? `, file: ${analysis.file}` : ''}${
      analysis.line ? `, line: ${analysis.line}` : ''
    }). Propose a fix. Respond ONLY with JSON of the shape {"description": string, "files": [{"path": string, "content": string}]}, where "path" is relative to ${
      context.projectSourcePath
    } and "content" is the COMPLETE new content of that file. No prose, no markdown fences.\n\nRaw error output:\n${truncate(
      analysis.rawOutput,
      3000
    )}`;
    const raw = await this.callOllama(prompt);
    if (!raw) return null;

    const parsed = tryParseJson<{ description: string; files: { path: string; content: string }[] }>(raw);
    if (!parsed) return null;

    return {
      id: randomUUID(),
      errorSignature: analysis.errorSignature,
      description: parsed.description,
      files: parsed.files.map((f) => ({
        path: f.path.startsWith(context.projectSourcePath) ? f.path : `${context.projectSourcePath}/${f.path}`,
        diff: f.content, // full-content replacement, see RepairEngine.applyPatchToFiles
      })),
      createdAt: new Date().toISOString(),
      appliedByJobId: '',
    };
  }

  private async callOllama(prompt: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.modelName, prompt, stream: false }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { response?: string };
      return data.response ?? null;
    } catch {
      return null;
    }
  }
}

function buildPlanPrompt(goal: string, context: { projectType?: ProjectType; availableTools: string[] }): string {
  return `You are a planning engine for a local software development tool. You NEVER execute anything yourself — you only propose a plan of tool calls for the host system to review and execute. Respond ONLY with JSON of the shape {"steps": [{"description": string, "toolCalls": [{"toolName": string, "input": object}]}]}. Available tools: ${context.availableTools.join(
    ', '
  )}. Project type: ${context.projectType ?? 'unspecified'}.\n\nGoal: ${goal}`;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '\n...[truncated]' : text;
}

function tryParseJson<T>(raw: string): T | null {
  try {
    // Models sometimes wrap JSON in markdown fences despite instructions;
    // strip those defensively before parsing.
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
