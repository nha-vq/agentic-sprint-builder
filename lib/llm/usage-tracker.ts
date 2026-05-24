import { AsyncLocalStorage } from 'async_hooks';
import type { LlmCostBreakdown, LlmUsageRecord, RunCostSummary } from '@/lib/types';

const usageStorage = new AsyncLocalStorage<LlmUsageRecord[]>();

export function runWithLlmUsageTracking<T>(records: LlmUsageRecord[], callback: () => Promise<T>) {
  return usageStorage.run(records, callback);
}

export function recordLlmUsage(record: LlmUsageRecord) {
  usageStorage.getStore()?.push(record);
}

function emptyBreakdown(id: string): LlmCostBreakdown {
  return {
    id,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };
}

function addToBreakdown(map: Map<string, LlmCostBreakdown>, id: string, record: LlmUsageRecord) {
  const item = map.get(id) ?? emptyBreakdown(id);
  item.calls += 1;
  item.promptTokens += record.promptTokens;
  item.completionTokens += record.completionTokens;
  item.totalTokens += record.totalTokens;
  item.costUsd += record.costUsd;
  map.set(id, item);
}

export function summarizeLlmUsage(records: LlmUsageRecord[]): RunCostSummary {
  const byAgent = new Map<string, LlmCostBreakdown>();
  const byModel = new Map<string, LlmCostBreakdown>();

  const summary: RunCostSummary = {
    totalUsd: 0,
    totalCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    byAgent: [],
    byModel: []
  };

  for (const record of records) {
    summary.totalCalls += 1;
    summary.promptTokens += record.promptTokens;
    summary.completionTokens += record.completionTokens;
    summary.totalTokens += record.totalTokens;
    summary.totalUsd += record.costUsd;
    addToBreakdown(byAgent, record.agentId, record);
    addToBreakdown(byModel, record.model, record);
  }

  const agentBreakdowns: LlmCostBreakdown[] = [];
  byAgent.forEach((value) => agentBreakdowns.push(value));
  const modelBreakdowns: LlmCostBreakdown[] = [];
  byModel.forEach((value) => modelBreakdowns.push(value));

  summary.byAgent = agentBreakdowns.sort((left, right) => right.costUsd - left.costUsd);
  summary.byModel = modelBreakdowns.sort((left, right) => right.costUsd - left.costUsd);
  return summary;
}
