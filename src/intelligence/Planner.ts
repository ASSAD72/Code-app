import { ExecutionPlan, ProjectType, ToolCallResult, ToolExecutionContext } from '@core/types';
import { LocalModelProvider } from './LocalModelProvider';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolExecutor } from '../tools/ToolExecutor';

export class Planner {
  constructor(private readonly localModelProvider: LocalModelProvider, private readonly toolRegistry: ToolRegistry, private readonly toolExecutor: ToolExecutor) {}

  async plan(goal: string, projectType?: ProjectType): Promise<ExecutionPlan | null> {
    return this.localModelProvider.generatePlan(goal, { projectType, availableTools: this.toolRegistry.list().map((t) => t.name) });
  }

  async executePlan(plan: ExecutionPlan, context: ToolExecutionContext, projectNetworkPermission: boolean): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = [];
    for (const step of plan.steps) {
      for (const request of step.toolCalls) {
        const result = await this.toolExecutor.dispatch(request, context, projectNetworkPermission);
        results.push(result);
        if (!result.success) return results;
      }
    }
    return results;
  }

  async isAiAvailable(): Promise<boolean> { return (await this.localModelProvider.getInfo()).available; }
}
