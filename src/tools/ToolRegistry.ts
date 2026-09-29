import { ToolDefinition, ToolCallRequest, ToolCallResult, ToolExecutionContext } from '@core/types';

/**
 * ToolRegistry — spec section 18. Every capability the AI (or CLI/GUI)
 * can invoke is registered here as a structured ToolDefinition with an
 * explicit input schema, a `requiresSandbox`/`requiresNetwork`/
 * `destructive` flag set, and a real handler function. The AI calls
 * tools by NAME and structured INPUT — it never gets a raw shell handle
 * (spec section 18: "AI must call these tools in a structured way, not
 * execute shell commands directly on the Host").
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput> | ToolDefinition<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async execute(request: ToolCallRequest, context: ToolExecutionContext): Promise<ToolCallResult> {
    const startTime = Date.now();
    const tool = this.tools.get(request.toolName);

    if (!tool) {
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        success: false,
        error: `Unknown tool "${request.toolName}"`,
        durationMs: Date.now() - startTime,
      };
    }

    const validationError = this.validateInput(request.input, tool);
    if (validationError) {
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        success: false,
        error: `Invalid input: ${validationError}`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const output = await tool.handler(request.input, context);
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        success: true,
        output,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        requestId: request.requestId,
        toolName: request.toolName,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  private validateInput(input: Record<string, unknown>, tool: ToolDefinition): string | null {
    const required = tool.inputSchema.required ?? [];
    for (const key of required) {
      if (!(key in input)) return `missing required field "${key}"`;
    }
    for (const [key, value] of Object.entries(input)) {
      const propSchema = tool.inputSchema.properties[key];
      if (!propSchema) continue;
      if (propSchema.enum && typeof value === 'string' && !propSchema.enum.includes(value)) return `field "${key}" must be one of ${propSchema.enum.join(', ')}`;
      if (propSchema.type === 'string' && typeof value !== 'string') return `field "${key}" must be a string`;
      if (propSchema.type === 'boolean' && typeof value !== 'boolean') return `field "${key}" must be a boolean`;
      if (propSchema.type === 'array' && !Array.isArray(value)) return `field "${key}" must be an array`;
      if (propSchema.type === 'array' && propSchema.items && Array.isArray(value) && value.some((v) => typeof v !== propSchema.items!.type)) return `field "${key}" contains an invalid item type`;
    }
    return null;
  }
}
