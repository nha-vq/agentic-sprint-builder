import type { AgentEvent, AgentId, DashboardEventType } from '@/lib/types';

const AGENTS = [
  { agent_id: 'ba', name: 'Huy BA', role: 'analyst' },
  { agent_id: 'tech-stack', name: 'Nha Tech Stack', role: 'architect' },
  { agent_id: 'dev', name: 'Nha & Dong DEV', role: 'dev' },
  { agent_id: 'code-review', name: 'Dong Code Review', role: 'reviewer' },
  { agent_id: 'deploy', name: 'Nha Deploy', role: 'devops' },
  { agent_id: 'qa', name: 'Tam QA', role: 'qa' }
];

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

function generateCompanyName(): string {
  // const now = new Date();
  // const dd = String(now.getDate()).padStart(2, '0');
  // const mm = String(now.getMonth() + 1).padStart(2, '0');
  // const hh = String(now.getHours()).padStart(2, '0');
  // const min = String(now.getMinutes()).padStart(2, '0');
  // return `Thermo Mini ${dd}/${mm}_${hh}:${min}`;
  return `Thermo Mini`;
}

/** In-memory company_id cache so we register once per process */
let cachedCompanyId: string | null = null;

export function getDashboardCompanyId(): string | null {
  return cachedCompanyId || process.env.DASHBOARD_COMPANY_ID || null;
}

export async function registerDashboardCompany() {
  if (!isDashboardEnabled()) {
    return {
      company_id: 'mock-company',
      name: 'Thermo Mini (disabled)',
      created_at: new Date().toISOString(),
      mocked: true,
      dashboardDisabled: true
    };
  }

  const baseUrl =
    process.env.DASHBOARD_BASE_URL ||
    'https://aitechcontest.kms-technology.com/api';

  const companyName = process.env.DASHBOARD_COMPANY_NAME || generateCompanyName();

  const response = await fetch(`${baseUrl}/companies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: companyName,
      description: 'AI-powered multi-agent software delivery team',
      agents: AGENTS
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard register failed ${response.status}: ${body}`);
  }

  const result = await response.json();
  cachedCompanyId = result.company_id;

  // Auto-save company_id to .env.local
  await persistCompanyIdToEnv(result.company_id);

  return result;
}

async function persistCompanyIdToEnv(companyId: string) {
  const fs = await import('fs/promises');
  const path = await import('path');
  const envPath = path.join(process.cwd(), '.env.local');

  try {
    let content = '';
    try {
      content = await fs.readFile(envPath, 'utf-8');
    } catch { /* file may not exist */ }

    if (content.includes('DASHBOARD_COMPANY_ID=')) {
      content = content.replace(/DASHBOARD_COMPANY_ID=.*/g, `DASHBOARD_COMPANY_ID=${companyId}`);
    } else {
      content += `${content.endsWith('\n') || content === '' ? '' : '\n'}DASHBOARD_COMPANY_ID=${companyId}\n`;
    }

    await fs.writeFile(envPath, content, 'utf-8');
  } catch (e) {
    console.warn('[Dashboard] Failed to persist company_id to .env.local:', e instanceof Error ? e.message : e);
  }
}

export async function deleteDashboardCompany(companyId?: string): Promise<{ deleted: boolean; company_id?: string }> {
  const id = companyId || getDashboardCompanyId();
  if (!id || id === 'mock-company') {
    return { deleted: false };
  }

  const baseUrl =
    process.env.DASHBOARD_BASE_URL ||
    'https://aitechcontest.kms-technology.com/api';

  const response = await fetch(`${baseUrl}/companies/${id}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard delete failed ${response.status}: ${body}`);
  }

  if (cachedCompanyId === id) {
    cachedCompanyId = null;
  }

  return { deleted: true, company_id: id };
}

export async function emitDashboardEvent(params: {
  agentId: AgentId;
  eventType: DashboardEventType;
  task: string;
  toAgent?: AgentId;
  artifact?: string;
}): Promise<AgentEvent> {
  const event: AgentEvent = {
    agentId: params.agentId,
    eventType: params.eventType,
    task: params.task,
    toAgent: params.toAgent,
    timestamp: new Date().toISOString(),
    dashboardAccepted: false
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

  const baseUrl =
    process.env.DASHBOARD_BASE_URL ||
    'https://aitechcontest.kms-technology.com/api';

  try {
    const response = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        agent_id: params.agentId,
        event_type: params.eventType,
        to_agent: params.toAgent,
        payload: {
          task: params.task,
          artifact: params.artifact,
          agent_state: params.eventType.toLowerCase()
        }
      })
    });

    event.dashboardAccepted = response.ok;
  } catch {
    event.dashboardAccepted = false;
  }

  return event;
}
