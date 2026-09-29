import { randomUUID } from 'crypto';
import { ErrorAnalysis, ExecutionPlan, LocalModelInfo, Patch, ToolCallRequest, ProjectType } from '@core/types';
import { LocalModelProvider } from '../LocalModelProvider';

/**
 * LlamaCppProvider — real implementation against llama.cpp's built-in
 * server mode (`llama-server`), which exposes an OpenAI-compatible
 * `/v1/chat/completions` endpoint (default http://localhost:8080). This
 * is a fully local model runtime with zero cloud dependency, satisfying
 * spec section 20's requirement to support llama.cpp as an alternative
 * to Ollama.
 *
 * Honesty note: same caveat as OllamaProvider — this issues real HTTP
 * requests in the documented llama.cpp server request/response shape,
 * but has not been exercised against a live llama-server instance in
 * this authoring sandbox (no network egress, no server running here).
 */
export class LlamaCppProvider implements LocalModelProvider {
  constructor(private readonly baseUrl: string = 'http://localhost:8080') {}

  async getInfo(): Promise<LocalModelInfo> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return { provider: 'llamacpp', available: response.ok };
    } catch {
      return { provider: 'llamacpp', available: false };
    }
  }

  async generatePlan(
    goal: string,
    context: { projectType?: ProjectType; availableTools: string[] }
  ): Promise<ExecutionPlan | null> {
    const systemPrompt =
      'You are a planning engine for a local development tool. You never execute anything; you only propose tool calls for review. Respond ONLY with JSON: {"steps": [{"description": string, "toolCalls": [{"toolName": string, "input": object}]}]}.';
    const userPrompt = `Available tools: ${context.availableTools.join(', ')}. Project type: ${
      context.projectType ?? 'unspecified'
    }.\n\nGoal: ${goal}`;

    const raw = await this.chat(systemPrompt, userPrompt);
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
        toolCalls: s.toolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input, requestId: randomUUID() })),
      })),
    };
  }

  async generateToolCalls(stepDescription: string, availableTools: string[]): Promise<ToolCallRequest[]> {
    const systemPrompt = `Respond ONLY with a JSON array of tool calls (toolName from [${availableTools.join(
      ', '
    )}], input object). No prose.`;
    const raw = await this.chat(systemPrompt, stepDescription);
    if (!raw) return [];
    const parsed = tryParseJson<{ toolName: string; input: Record<string, unknown> }[]>(raw);
    if (!parsed) return [];
    return parsed.map((tc) => ({ toolName: tc.toolName, input: tc.input, requestId: randomUUID() }));
  }

  async analyzeBuildError(rawOutput: string, context: { projectType?: ProjectType }): Promise<ErrorAnalysis | null> {
    const systemPrompt = `You are a build error analyst for a ${
      context.projectType ?? 'software'
    } project. Respond ONLY with JSON: {"errorSignature": string, "category": string, "file": string|null, "line": number|null, "message": string, "suggestedFixSummary": string}.`;
    const raw = await this.chat(systemPrompt, truncate(rawOutput, 4000));
    if (!raw) return null;
    const parsed = tryParseJson<Omit<ErrorAnalysis, 'rawOutput'>>(raw);
    if (!parsed) return null;
    return { ...parsed, rawOutput };
  }

  async generatePatch(analysis: ErrorAnalysis, context: { projectSourcePath: string }): Promise<Patch | null> {
    const systemPrompt = `You are a code-repair assistant. Respond ONLY with JSON: {"description": string, "files": [{"path": string, "content": string}]}, where content is the COMPLETE new file content.`;
    const userPrompt = `Error: ${analysis.message} (category: ${analysis.category})\nFile: ${analysis.file ?? 'unknown'}\nLine: ${
      analysis.line ?? 'unknown'
    }\nProject root: ${context.projectSourcePath}\n\nRaw output:\n${truncate(analysis.rawOutput, 3000)}`;
    const raw = await this.chat(systemPrompt, userPrompt);
    if (!raw) return null;
    const parsed = tryParseJson<{ description: string; files: { path: string; content: string }[] }>(raw);
    if (!parsed) return null;

    return {
      id: randomUUID(),
      errorSignature: analysis.errorSignature,
      description: parsed.description,
      files: parsed.files.map((f) => ({
        path: f.path.startsWith(context.projectSourcePath) ? f.path : `${context.projectSourcePath}/${f.path}`,
        diff: f.content,
      })),
      createdAt: new Date().toISOString(),
      appliedByJobId: '',
    };
  }

  private async chat(systemPrompt: string, userPrompt: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? null;
    } catch {
      return null;
    }
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) + '\n...[truncated]' : text;
}

function tryParseJson<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
