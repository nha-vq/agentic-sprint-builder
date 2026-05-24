import type { AgentEvent, AgentId, DashboardEventType } from '@/lib/types';

export type DashboardAgentDefinition = {
  agent_id: AgentId;
  name: string;
  role: string;
  description: string;
};

type DashboardAgentIdMap = Partial<Record<AgentId, string>>;

export interface DashboardIdentity {
  company_id: string;
  name: string;
  created_at?: string;
  agents: DashboardAgentIdMap;
  mocked?: boolean;
  dashboardDisabled?: boolean;
  reused?: boolean;
}

export interface DashboardAgentSnapshot extends DashboardAgentDefinition {
  dashboard_agent_id?: string | null;
  created?: boolean;
}

export interface DashboardIdentitySnapshot {
  dashboardEnabled: boolean;
  company_id?: string | null;
  name?: string;
  created_at?: string;
  agents: DashboardAgentSnapshot[];
  agentIds: DashboardAgentIdMap;
  dashboardDisabled?: boolean;
  mocked?: boolean;
  reused?: boolean;
}

const AGENTS: DashboardAgentDefinition[] = [
  {
    agent_id: 'ba',
    name: 'BA Agent',
    role: 'business_analyst',
    description: 'Analyzes requirements and creates user stories, acceptance criteria, and QA-ready artifacts.'
  },
  {
    agent_id: 'tech-stack',
    name: 'TA Agent',
    role: 'technical_architect',
    description: 'Analyzes the tech stack, prepares architecture decisions, and upgrades the DEV skill before implementation and repairs.'
  },
  {
    agent_id: 'dev',
    name: 'DEV Lead',
    role: 'developer_lead',
    description: 'Plans implementation, assigns file ownership, and integrates specialized DEV outputs.'
  },
  {
    agent_id: 'frontend-dev',
    name: 'Frontend DEV',
    role: 'frontend_developer',
    description: 'Builds UI pages, components, styling, visual fidelity, and browser-safe frontend behavior.'
  },
  {
    agent_id: 'backend-dev',
    name: 'Backend DEV',
    role: 'backend_developer',
    description: 'Builds API routes, data models, persistence, seed data, and backend runtime behavior.'
  },
  {
    agent_id: 'integration-dev',
    name: 'Integration DEV',
    role: 'integration_developer',
    description: 'Builds Dockerfiles, Compose wiring, env contracts, README startup steps, and app integration.'
  },
  {
    agent_id: 'code-review',
    name: 'Code Review Agent',
    role: 'reviewer',
    description: 'Reviews generated code for quality, architecture, requirement coverage, and fix requests.'
  },
  {
    agent_id: 'deploy',
    name: 'DevOps Agent',
    role: 'devops',
    description: 'Creates and validates container deployment, Docker Compose, and Rancher Desktop readiness.'
  },
  {
    agent_id: 'qa',
    name: 'QA Agent',
    role: 'qa',
    description: 'Runs post-deploy requirement and end-to-end validation, then requests DEV fixes when needed.'
  }
];

const AGENT_IDS = new Set<AgentId>(AGENTS.map((agent) => agent.agent_id));
const DEFAULT_DASHBOARD_COMPANY_NAME = 'Thermo Mini';

export interface DashboardClient {
  emit(event: {
    agent: string;
    type: string;
    to?: string;
    payload?: any;
  }): Promise<void>;
}

function isDashboardEnabled() {
  return process.env.ENABLE_DASHBOARD === 'true';
}

function dashboardBaseUrl() {
  return process.env.DASHBOARD_BASE_URL || 'https://aitechcontest.kms-technology.com/api';
}

function generateCompanyName(): string {
  return process.env.DASHBOARD_COMPANY_NAME || DEFAULT_DASHBOARD_COMPANY_NAME;
}

function agentEnvName(agentId: AgentId) {
  return `DASHBOARD_AGENT_${agentId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_ID`;
}

function normalizeAgentId(value: unknown): AgentId | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  return AGENT_IDS.has(normalized as AgentId) ? (normalized as AgentId) : null;
}

function readAgentIdsFromEnv(): DashboardAgentIdMap {
  const agents: DashboardAgentIdMap = {};
  const rawJson = process.env.DASHBOARD_AGENT_IDS?.trim();

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        const logicalId = normalizeAgentId(key);
        if (logicalId && typeof value === 'string' && value.trim()) {
          agents[logicalId] = value.trim();
        }
      }
    } catch {
      console.warn('[Dashboard] DASHBOARD_AGENT_IDS is not valid JSON; falling back to individual agent env vars.');
    }
  }

  for (const agent of AGENTS) {
    const envValue = process.env[agentEnvName(agent.agent_id)]?.trim();
    if (envValue) agents[agent.agent_id] = envValue;
  }

  return agents;
}

function applyIdentityToProcessEnv(identity: DashboardIdentity) {
  process.env.DASHBOARD_COMPANY_ID = identity.company_id;
  process.env.DASHBOARD_AGENT_IDS = JSON.stringify(identity.agents);
  for (const agent of AGENTS) {
    const dashboardAgentId = identity.agents[agent.agent_id];
    if (dashboardAgentId) process.env[agentEnvName(agent.agent_id)] = dashboardAgentId;
  }
}

/** In-memory dashboard identity cache so registration is stable per process. */
let cachedIdentity: DashboardIdentity | null = null;

export function getDashboardCompanyId(): string | null {
  return cachedIdentity?.company_id || process.env.DASHBOARD_COMPANY_ID || null;
}

export function getDashboardAgentId(agentId: AgentId): string | null {
  return cachedIdentity?.agents[agentId] || readAgentIdsFromEnv()[agentId] || null;
}

function createDisabledIdentity(): DashboardIdentity {
  return {
    company_id: 'mock-company',
    name: `${generateCompanyName()} (dashboard disabled)`,
    created_at: new Date().toISOString(),
    agents: Object.fromEntries(AGENTS.map((agent) => [agent.agent_id, `mock-${agent.agent_id}`])) as Record<AgentId, string>,
    mocked: true,
    dashboardDisabled: true
  };
}

function existingIdentityFromEnv(): DashboardIdentity | null {
  const companyId = process.env.DASHBOARD_COMPANY_ID?.trim();
  if (!companyId) return null;

  return {
    company_id: companyId,
    name: process.env.DASHBOARD_COMPANY_NAME || generateCompanyName(),
    agents: readAgentIdsFromEnv(),
    reused: true
  };
}

function toDashboardIdentitySnapshot(identity?: DashboardIdentity | null): DashboardIdentitySnapshot {
  const agentIds = identity?.agents || readAgentIdsFromEnv();
  return {
    dashboardEnabled: isDashboardEnabled(),
    company_id: identity?.company_id || process.env.DASHBOARD_COMPANY_ID || null,
    name: identity?.name || process.env.DASHBOARD_COMPANY_NAME || generateCompanyName(),
    created_at: identity?.created_at,
    agents: AGENTS.map((agent) => ({
      ...agent,
      dashboard_agent_id: agentIds[agent.agent_id] || null,
      created: Boolean(agentIds[agent.agent_id])
    })),
    agentIds,
    dashboardDisabled: identity?.dashboardDisabled,
    mocked: identity?.mocked,
    reused: identity?.reused
  };
}

export function getDashboardIdentitySnapshot(): DashboardIdentitySnapshot {
  return toDashboardIdentitySnapshot(cachedIdentity || existingIdentityFromEnv());
}

function extractStringField(value: unknown, fieldNames: string[]) {
  if (!value || typeof value !== 'object') return null;
  const objectValue = value as Record<string, unknown>;

  for (const fieldName of fieldNames) {
    const fieldValue = objectValue[fieldName];
    if (typeof fieldValue === 'string' && fieldValue.trim()) return fieldValue.trim();
    if (typeof fieldValue === 'number') return String(fieldValue);
  }

  return null;
}

function extractCompanyId(response: unknown) {
  return (
    extractStringField(response, ['company_id', 'companyId', 'id', 'uuid']) ||
    extractStringField((response as Record<string, unknown>)?.company, ['company_id', 'companyId', 'id', 'uuid']) ||
    extractStringField((response as Record<string, unknown>)?.data, ['company_id', 'companyId', 'id', 'uuid'])
  );
}

function extractAgentId(response: unknown) {
  return extractStringField(response, ['dashboard_agent_id', 'agent_uuid', 'agentId', 'id', 'uuid', '_id', 'agent_id']);
}

function candidateAgentArrays(response: unknown): unknown[] {
  if (!response || typeof response !== 'object') return [];
  const objectValue = response as Record<string, unknown>;
  const candidates = [
    objectValue.agents,
    objectValue.data,
    objectValue.items,
    objectValue.results,
    (objectValue.company as Record<string, unknown> | undefined)?.agents,
    (objectValue.data as Record<string, unknown> | undefined)?.agents
  ];

  return candidates.filter(Array.isArray).flat() as unknown[];
}

function extractAgentIdsFromResponse(response: unknown): DashboardAgentIdMap {
  const agents: DashboardAgentIdMap = {};

  for (const item of candidateAgentArrays(response)) {
    if (!item || typeof item !== 'object') continue;
    const objectItem = item as Record<string, unknown>;
    const logicalId =
      normalizeAgentId(objectItem.logical_agent_id) ||
      normalizeAgentId(objectItem.logicalAgentId) ||
      normalizeAgentId(objectItem.slug) ||
      normalizeAgentId(objectItem.key) ||
      normalizeAgentId(objectItem.agent_id) ||
      AGENTS.find((agent) => agent.name.toLowerCase() === String(objectItem.name || '').trim().toLowerCase())?.agent_id ||
      null;

    const dashboardAgentId = extractAgentId(item);
    if (logicalId && dashboardAgentId) agents[logicalId] = dashboardAgentId;
  }

  return agents;
}

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = text
    ? (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })()
    : {};

  if (!response.ok) {
    throw new Error(`${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }

  return parsed;
}

async function deleteJson(url: string) {
  const response = await fetch(url, { method: 'DELETE' });
  const text = await response.text();
  const parsed = text
    ? (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })()
    : {};

  if (!response.ok) {
    throw new Error(`${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }

  return parsed;
}

async function createDashboardCompany() {
  const body = {
    name: generateCompanyName(),
    description: 'AI-powered multi-agent software delivery team'
  };

  try {
    return await postJson(`${dashboardBaseUrl()}/companies`, body);
  } catch (error) {
    // Compatibility fallback for the original contest API shape used by this repo.
    const fallbackBody = { ...body, agents: AGENTS };
    return postJson(`${dashboardBaseUrl()}/companies`, fallbackBody).catch((fallbackError) => {
      throw new Error(
        `Dashboard company create failed. First attempt: ${error instanceof Error ? error.message : String(error)}. Fallback with agents: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`
      );
    });
  }
}

async function deleteExistingDashboardCompanyBeforeCreate() {
  const existing = cachedIdentity || existingIdentityFromEnv();
  if (!existing?.company_id || existing.company_id === 'mock-company') return;

  await deleteDashboardAgents(existing.company_id);
  await deleteDashboardCompany(existing.company_id);
}

export async function createDashboardCompanyRecord(options: { replaceExisting?: boolean } = {}): Promise<DashboardIdentity> {
  if (!isDashboardEnabled()) {
    cachedIdentity = createDisabledIdentity();
    return cachedIdentity;
  }

  if (options.replaceExisting) {
    await deleteExistingDashboardCompanyBeforeCreate();
  }

  if (cachedIdentity?.company_id) {
    await persistDashboardIdentityToEnv(cachedIdentity);
    return cachedIdentity;
  }

  const fromEnv = existingIdentityFromEnv();
  if (fromEnv) {
    cachedIdentity = fromEnv;
    applyIdentityToProcessEnv(fromEnv);
    await persistDashboardIdentityToEnv(fromEnv);
    return fromEnv;
  }

  const companyResponse = await createDashboardCompany();
  const companyId = extractCompanyId(companyResponse);
  if (!companyId) {
    throw new Error(`Dashboard company create response did not include company_id: ${JSON.stringify(companyResponse)}`);
  }

  cachedIdentity = {
    company_id: companyId,
    name: extractStringField(companyResponse, ['name']) || generateCompanyName(),
    created_at: extractStringField(companyResponse, ['created_at', 'createdAt']) || new Date().toISOString(),
    agents: extractAgentIdsFromResponse(companyResponse)
  };
  applyIdentityToProcessEnv(cachedIdentity);
  await persistDashboardIdentityToEnv(cachedIdentity);

  return cachedIdentity;
}

async function createDashboardAgent(companyId: string, agent: DashboardAgentDefinition) {
  const body = {
    company_id: companyId,
    logical_agent_id: agent.agent_id,
    agent_id: agent.agent_id,
    name: agent.name,
    role: agent.role,
    description: agent.description
  };
  const configuredPath = process.env.DASHBOARD_AGENT_CREATE_PATH?.trim();
  const paths = configuredPath
    ? [configuredPath.replace('{company_id}', encodeURIComponent(companyId))]
    : [`/companies/${encodeURIComponent(companyId)}/agents`, '/agents'];
  const failures: string[] = [];

  for (const createPath of paths) {
    try {
      return await postJson(`${dashboardBaseUrl()}${createPath}`, body);
    } catch (error) {
      failures.push(`${createPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Dashboard agent create failed for ${agent.agent_id}. ${failures.join(' | ')}`);
}

async function ensureDashboardAgents(identity: DashboardIdentity): Promise<DashboardIdentity> {
  const agents: DashboardAgentIdMap = { ...identity.agents };

  for (const agent of AGENTS) {
    if (agents[agent.agent_id]) continue;

    try {
      const response = await createDashboardAgent(identity.company_id, agent);
      const agentIds = extractAgentIdsFromResponse(response);
      const directAgentId = extractAgentId(response);
      agents[agent.agent_id] = agentIds[agent.agent_id] || directAgentId || agent.agent_id;
    } catch (error) {
      if (process.env.DASHBOARD_REQUIRE_AGENT_IDS === 'true') {
        throw error;
      }

      console.warn(
        `[Dashboard] Could not create/store remote agent id for ${agent.agent_id}; falling back to logical id. Set DASHBOARD_AGENT_CREATE_PATH or DASHBOARD_REQUIRE_AGENT_IDS=true to enforce remote agent creation. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      agents[agent.agent_id] = agent.agent_id;
    }
  }

  return { ...identity, agents };
}

export async function createDashboardAgents(companyId?: string): Promise<DashboardIdentity> {
  if (!isDashboardEnabled()) {
    cachedIdentity = createDisabledIdentity();
    return cachedIdentity;
  }

  const identity =
    cachedIdentity ||
    (companyId
      ? {
          company_id: companyId,
          name: process.env.DASHBOARD_COMPANY_NAME || generateCompanyName(),
          agents: readAgentIdsFromEnv()
        }
      : existingIdentityFromEnv());

  if (!identity?.company_id) {
    throw new Error('No dashboard company id found. Create a company first.');
  }

  cachedIdentity = await ensureDashboardAgents(identity);
  applyIdentityToProcessEnv(cachedIdentity);
  await persistDashboardIdentityToEnv(cachedIdentity);

  return cachedIdentity;
}

async function persistDashboardIdentityToEnv(identity: DashboardIdentity) {
  if (identity.dashboardDisabled) return;

  const fs = await import('fs/promises');
  const path = await import('path');
  const envPath = path.join(process.cwd(), '.env.local');

  try {
    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf-8');
    } catch {
      // The file is created below when it does not exist.
    }

    const setEnvValue = (key: string, value: string) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const line = `${key}=${value}`;
      const pattern = new RegExp(`^${escaped}=.*$`, 'm');
      if (pattern.test(content)) {
        content = content.replace(pattern, line);
      } else {
        content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${line}\n`;
      }
    };

    setEnvValue('DASHBOARD_COMPANY_ID', identity.company_id);
    setEnvValue('DASHBOARD_AGENT_IDS', JSON.stringify(identity.agents));
    for (const agent of AGENTS) {
      const dashboardAgentId = identity.agents[agent.agent_id];
      if (dashboardAgentId) setEnvValue(agentEnvName(agent.agent_id), dashboardAgentId);
    }

    await fs.writeFile(envPath, content, 'utf-8');
  } catch (error) {
    console.warn('[Dashboard] Failed to persist dashboard identity to .env.local:', error instanceof Error ? error.message : error);
  }
}

async function updateEnvFileValues(values: Record<string, string>) {
  const fs = await import('fs/promises');
  const path = await import('path');
  const envPath = path.join(process.cwd(), '.env.local');

  try {
    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf-8');
    } catch {
      // Nothing to clear when the file does not exist.
    }

    for (const [key, value] of Object.entries(values)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const line = `${key}=${value}`;
      const pattern = new RegExp(`^${escaped}=.*$`, 'm');
      if (pattern.test(content)) {
        content = content.replace(pattern, line);
      } else if (value) {
        content += `${content.endsWith('\n') || content === '' ? '' : '\n'}${line}\n`;
      }
      process.env[key] = value;
    }

    await fs.writeFile(envPath, content, 'utf-8');
  } catch (error) {
    console.warn('[Dashboard] Failed to update .env.local:', error instanceof Error ? error.message : error);
  }
}

async function clearDashboardAgentsFromEnv() {
  await updateEnvFileValues({
    DASHBOARD_AGENT_IDS: '',
    ...Object.fromEntries(AGENTS.map((agent) => [agentEnvName(agent.agent_id), '']))
  });
}

async function clearDashboardIdentityFromEnv() {
  await updateEnvFileValues({
    DASHBOARD_COMPANY_ID: '',
    DASHBOARD_AGENT_IDS: '',
    ...Object.fromEntries(AGENTS.map((agent) => [agentEnvName(agent.agent_id), '']))
  });
}

export async function registerDashboardCompany(): Promise<DashboardIdentity> {
  if (!isDashboardEnabled()) {
    cachedIdentity = createDisabledIdentity();
    return cachedIdentity;
  }

  const identity = await createDashboardCompanyRecord();
  return createDashboardAgents(identity.company_id);
}

export async function deleteDashboardCompany(companyId?: string): Promise<{ deleted: boolean; company_id?: string }> {
  const id = companyId || getDashboardCompanyId();
  if (!id || id === 'mock-company') {
    return { deleted: false };
  }

  const response = await fetch(`${dashboardBaseUrl()}/companies/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard delete failed ${response.status}: ${body}`);
  }

  if (cachedIdentity?.company_id === id) {
    cachedIdentity = null;
  }
  await clearDashboardIdentityFromEnv();

  return { deleted: true, company_id: id };
}

async function deleteDashboardAgent(companyId: string, agent: DashboardAgentSnapshot) {
  const dashboardAgentId = agent.dashboard_agent_id || agent.agent_id;
  const configuredPath = process.env.DASHBOARD_AGENT_DELETE_PATH?.trim();
  const replacements = (template: string) =>
    template
      .replace('{company_id}', encodeURIComponent(companyId))
      .replace('{agent_id}', encodeURIComponent(dashboardAgentId))
      .replace('{logical_agent_id}', encodeURIComponent(agent.agent_id));
  const paths = configuredPath
    ? [replacements(configuredPath)]
    : [
        `/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(dashboardAgentId)}`,
        `/agents/${encodeURIComponent(dashboardAgentId)}`
      ];
  const failures: string[] = [];

  for (const deletePath of paths) {
    try {
      await deleteJson(`${dashboardBaseUrl()}${deletePath}`);
      return;
    } catch (error) {
      failures.push(`${deletePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Dashboard agent delete failed for ${agent.agent_id}. ${failures.join(' | ')}`);
}

export async function deleteDashboardAgents(companyId?: string): Promise<{ deleted: boolean; company_id?: string; agents: DashboardAgentSnapshot[]; warnings: string[] }> {
  const id = companyId || getDashboardCompanyId();
  const snapshot = getDashboardIdentitySnapshot();
  const existingAgents = snapshot.agents.filter((agent) => agent.dashboard_agent_id);
  const warnings: string[] = [];

  if (!id || id === 'mock-company') {
    await clearDashboardAgentsFromEnv();
    if (cachedIdentity) cachedIdentity = { ...cachedIdentity, agents: {} };
    return { deleted: false, agents: [], warnings: ['No dashboard company id found. Local agent ids were cleared.'] };
  }

  if (isDashboardEnabled()) {
    for (const agent of existingAgents) {
      try {
        await deleteDashboardAgent(id, agent);
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        if (process.env.DASHBOARD_REQUIRE_AGENT_IDS === 'true') {
          throw error;
        }
        warnings.push(warning);
        console.warn(`[Dashboard] ${warning}`);
      }
    }
  }

  await clearDashboardAgentsFromEnv();
  if (cachedIdentity) cachedIdentity = { ...cachedIdentity, agents: {} };

  return { deleted: existingAgents.length > 0, company_id: id, agents: existingAgents, warnings };
}

export async function emitDashboardEvent(params: {
  agentId: AgentId;
  eventType: DashboardEventType;
  task: string;
  toAgent?: AgentId;
  artifact?: string;
}): Promise<AgentEvent> {
  const dashboardAgentId = getDashboardAgentId(params.agentId);
  const dashboardToAgentId = params.toAgent ? getDashboardAgentId(params.toAgent) : null;
  const event: AgentEvent = {
    agentId: params.agentId,
    eventType: params.eventType,
    task: params.task,
    toAgent: params.toAgent,
    timestamp: new Date().toISOString(),
    dashboardAccepted: false,
    dashboardAgentId: dashboardAgentId || undefined,
    dashboardToAgentId: dashboardToAgentId || undefined
  };

  if (!isDashboardEnabled()) {
    return {
      ...event,
      dashboardAccepted: false,
      mocked: true
    } as AgentEvent;
  }

  const companyId = getDashboardCompanyId();
  if (!companyId) return event;

  try {
    const response = await fetch(`${dashboardBaseUrl()}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        agent_id: dashboardAgentId || params.agentId,
        to_agent: dashboardToAgentId || params.toAgent,
        event_type: params.eventType,
        payload: {
          task: params.task,
          artifact: params.artifact,
          agent_state: params.eventType.toLowerCase(),
          logical_agent_id: params.agentId,
          logical_to_agent: params.toAgent
        }
      })
    });

    event.dashboardAccepted = response.ok;
  } catch {
    event.dashboardAccepted = false;
  }

  return event;
}
