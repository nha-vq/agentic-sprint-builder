'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { DEFAULT_REQUIREMENTS, DEFAULT_TECH_SPEC } from '@/lib/default-run-inputs';
import { AGENT_MODEL_OPTIONS, DEFAULT_AGENT_MODELS } from '@/lib/agent-models';
import type { AgentId, AgentModelMap, RequirementImage, RunResult, RunStatusSnapshot } from '@/lib/types';

type DashboardAgentView = {
  agent_id: AgentId;
  name: string;
  role: string;
  description?: string;
  dashboard_agent_id?: string | null;
  created?: boolean;
};

type DashboardStatus = {
  dashboardEnabled: boolean;
  company_id?: string | null;
  name?: string;
  agents: DashboardAgentView[];
  warnings?: string[];
  connectivity?: {
    checked: boolean;
    reachable: boolean;
    status?: number;
    error?: string;
  };
  info?: string;
};

export default function HomePage() {
  const [requirements, setRequirements] = useState(DEFAULT_REQUIREMENTS);
  const [techSpec, setTechSpec] = useState(DEFAULT_TECH_SPEC);
  const [requirementImages, setRequirementImages] = useState<RequirementImage[]>([]);
  const [agentModels, setAgentModels] = useState<AgentModelMap>(DEFAULT_AGENT_MODELS);
  const [cleanBeforeRun, setCleanBeforeRun] = useState(true);
  const [result, setResult] = useState<RunResult | null>(null);
  const [liveStatus, setLiveStatus] = useState<RunStatusSnapshot | null>(null);
  const [progressModalOpen, setProgressModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [lastCompanyId, setLastCompanyId] = useState('');
  const [dashboardStatus, setDashboardStatus] = useState<DashboardStatus | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardEventMessage, setDashboardEventMessage] = useState('');
  const [dismissedRancherToastKey, setDismissedRancherToastKey] = useState('');

  useEffect(() => {
    void refreshDashboardStatus();
  }, []);

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollRunStatus(runId: string) {
    while (true) {
      const response = await fetch(`/api/runs/${runId}/status`, { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Run status lookup failed');

      setLiveStatus(data);

      if (data.status === 'COMPLETED') {
        if (data.result) setResult(data.result);
        return;
      }

      if (data.status === 'CANCELED') {
        return;
      }

      if (data.status === 'FAILED') {
        throw new Error(data.error || 'Run failed');
      }

      await sleep(1500);
    }
  }

  async function runAgents() {
    setLoading(true);
    setError('');
    setResult(null);
    setLiveStatus(null);
    setProgressModalOpen(true);
    try {
      if (cleanBeforeRun) {
        await fetch('/api/runs/cleanup', { method: 'POST' });
      }
      const response = await fetch('/api/runs?async=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirements,
          techSpec: techSpec.trim() ? techSpec : null,
          requirementImages: requirementImages.length > 0 ? requirementImages : null,
          agentModels,
          topic: 'New Full-Stack App'
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Run failed');
      setLiveStatus(data);

      if (data.status === 'COMPLETED' && data.result) {
        setResult(data.result);
      } else if (data.runId) {
        await pollRunStatus(data.runId);
      } else {
        setResult(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function stopRun() {
    if (!liveStatus?.runId || stopping) return;

    setStopping(true);
    setError('');
    try {
      const response = await fetch(`/api/runs/${liveStatus.runId}/cancel`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Stop request failed');
      setLiveStatus(data);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStopping(false);
    }
  }

  async function refreshDashboardStatus() {
    try {
      const response = await fetch('/api/dashboard/status', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Dashboard status lookup failed');
      setDashboardStatus(data);
      if (data.company_id) setLastCompanyId(data.company_id);
    } catch {
      // Keep the main workflow usable even if dashboard status is unavailable.
    }
  }

  async function runDashboardAction(action: () => Promise<Response>) {
    setError('');
    setDashboardLoading(true);
    try {
      const response = await action();
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Dashboard action failed');
      setDashboardStatus(data);
      if (data.company_id) setLastCompanyId(data.company_id);
      await refreshDashboardStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDashboardLoading(false);
    }
  }

  async function createCompany() {
    await runDashboardAction(() => fetch('/api/dashboard/company', { method: 'POST' }));
  }

  async function createAgents() {
    const companyId = dashboardStatus?.company_id || lastCompanyId;
    const query = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
    await runDashboardAction(() => fetch(`/api/dashboard/agents${query}`, { method: 'POST' }));
  }

  async function deleteAgents() {
    if (!window.confirm('Delete saved dashboard agents?')) return;
    const companyId = dashboardStatus?.company_id || lastCompanyId;
    const query = companyId ? `?company_id=${encodeURIComponent(companyId)}` : '';
    await runDashboardAction(() => fetch(`/api/dashboard/agents${query}`, { method: 'DELETE' }));
  }

  async function testDashboardEvent() {
    setDashboardLoading(true);
    setDashboardEventMessage('');
    setError('');
    try {
      const response = await fetch('/api/dashboard/event-test', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Dashboard event test failed');

      setDashboardStatus(data.status);
      const event = data.event as RunResult['events'][number];
      setDashboardEventMessage(
        event.dashboardAccepted
          ? `Diagnostic event accepted${event.dashboardPath ? ` via ${event.dashboardPath}` : ''}${event.dashboardStatus ? ` (${event.dashboardStatus})` : ''}.`
          : `Diagnostic event not accepted${event.dashboardPath ? ` via ${event.dashboardPath}` : ''}${event.dashboardStatus ? ` (${event.dashboardStatus})` : ''}: ${event.dashboardError || event.dashboardResponse || 'no dashboard response'}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setDashboardLoading(false);
    }
  }

  async function deleteCompany(companyId: string) {
    setError('');
    try {
      const response = await fetch(`/api/dashboard/delete?company_id=${encodeURIComponent(companyId)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Delete failed');
      if (lastCompanyId === companyId) setLastCompanyId('');
      setDashboardStatus((current) => current ? { ...current, company_id: null, agents: current.agents.map((agent) => ({ ...agent, dashboard_agent_id: null, created: false })) } : current);
      setDeleteModalOpen(false);
      await refreshDashboardStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return (
    <main className="min-h-screen p-3 md:p-4">
      <div className="mx-auto max-w-7xl space-y-3 md:space-y-4">
        <section className="rounded-3xl bg-white p-4 shadow-sm md:p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">AI Tech Contest Phase 1</p>
              <h1 className="mt-1 text-3xl font-bold md:text-4xl">Agentic Sprint Builder</h1>
              <DashboardIdentitySummary
                status={dashboardStatus}
                loading={dashboardLoading}
                agentModels={agentModels}
                onAgentModelChange={(agentId, model) => setAgentModels((current) => ({ ...current, [agentId]: model }))}
              />
            </div>
            <div className="flex w-full flex-col gap-2 md:w-auto md:min-w-80">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={createCompany}
                  disabled={dashboardLoading}
                  className="rounded-2xl border border-blue-200 px-4 py-2.5 font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                >
                  Create Company
                </button>
                <button
                  onClick={() => setDeleteModalOpen(true)}
                  disabled={dashboardLoading || !(dashboardStatus?.company_id || lastCompanyId)}
                  className="rounded-2xl border border-red-200 px-4 py-2.5 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                >
                  Delete Company
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={createAgents}
                  disabled={dashboardLoading || !(dashboardStatus?.company_id || lastCompanyId)}
                  className="rounded-2xl border border-emerald-200 px-4 py-2.5 font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                >
                  Create Agents
                </button>
                <button
                  onClick={deleteAgents}
                  disabled={dashboardLoading || !dashboardStatus?.agents.some((agent) => agent.dashboard_agent_id)}
                  className="rounded-2xl border border-amber-200 px-4 py-2.5 font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                >
                  Delete Agents
                </button>
              </div>
              <Link href="/runs" className="rounded-2xl border border-slate-200 px-4 py-2.5 text-center font-semibold hover:bg-slate-50">
                View Runs
              </Link>
              <button
                onClick={testDashboardEvent}
                disabled={dashboardLoading || !(dashboardStatus?.company_id || lastCompanyId)}
                className="rounded-2xl border border-slate-200 px-4 py-2.5 text-center font-semibold hover:bg-slate-50 disabled:opacity-50"
              >
                Test Dashboard Event
              </button>
              {dashboardEventMessage && <p className="text-xs text-slate-600">{dashboardEventMessage}</p>}
            </div>
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <MarkdownEditor title="requirements.md" expectedFileName="requirements.md" value={requirements} onChange={setRequirements} />
          <MarkdownEditor title="tech-spec.md optional" expectedFileName="tech-spec.md" value={techSpec} onChange={setTechSpec} />
        </section>

        <RequirementImageInput images={requirementImages} onChange={setRequirementImages} />

        <div className="flex flex-wrap items-center gap-3">
          <button disabled={loading} onClick={runAgents} className="rounded-2xl bg-blue-600 px-5 py-2.5 font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60">
            {loading ? 'Running AI Team...' : 'Run AI Team'}
          </button>
          <label className="flex cursor-pointer items-center gap-2 rounded-2xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
            <input
              type="checkbox"
              checked={cleanBeforeRun}
              onChange={(e) => setCleanBeforeRun(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            <span className="text-sm font-medium text-slate-700">Clean generated-code &amp; generated-runs before run</span>
          </label>
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        {liveStatus && (
          <RancherRuntimeToast
            status={liveStatus}
            dismissedKey={dismissedRancherToastKey}
            onDismiss={setDismissedRancherToastKey}
          />
        )}
        {liveStatus && progressModalOpen && (
          <RunProgressModal
            status={liveStatus}
            stopping={stopping}
            onStop={stopRun}
            onClose={() => setProgressModalOpen(false)}
          />
        )}
        {result && <RunResultView result={result} />}
        {!progressModalOpen && liveStatus && !result && <ProgressDock status={liveStatus} onOpen={() => setProgressModalOpen(true)} />}
        {result && <CompletionDock result={result} onOpenProgress={() => setProgressModalOpen(true)} />}

        {deleteModalOpen && (
          <DeleteCompanyModal
            defaultCompanyId={dashboardStatus?.company_id || lastCompanyId}
            onDelete={deleteCompany}
            onClose={() => setDeleteModalOpen(false)}
          />
        )}
      </div>
    </main>
  );
}

function MarkdownEditor(props: { title: string; expectedFileName: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loadedFileName, setLoadedFileName] = useState('');
  const [uploadError, setUploadError] = useState('');

  async function handleFileUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    setUploadError('');
    try {
      const content = await readTextFile(file);
      props.onChange(content);
      setLoadedFileName(file.name);
    } catch (error) {
      setLoadedFileName('');
      setUploadError(error instanceof Error ? error.message : `Failed to read ${file.name}`);
    }
  }

  return (
    <section className="rounded-3xl bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-semibold">{props.title}</span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
        >
          Upload {props.expectedFileName}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".md,text/markdown,text/plain"
          className="hidden"
          onChange={handleFileUpload}
        />
      </div>
      {(loadedFileName || uploadError) && (
        <p className={`mt-2 text-xs ${uploadError ? 'text-red-600' : 'text-slate-500'}`}>
          {uploadError || `Loaded ${loadedFileName}`}
        </p>
      )}
      <textarea
        className="mt-2 h-[24vh] min-h-[150px] max-h-64 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 p-3 font-mono text-sm"
        value={props.value}
        placeholder={props.placeholder}
        aria-label={`${props.title} content`}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </section>
  );
}

function DashboardIdentitySummary({
  status,
  loading,
  agentModels,
  onAgentModelChange
}: {
  status: DashboardStatus | null;
  loading: boolean;
  agentModels: AgentModelMap;
  onAgentModelChange: (agentId: AgentId, model: string) => void;
}) {
  const createdAgents = status?.agents.filter((agent) => agent.dashboard_agent_id) ?? [];

  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="font-mono text-slate-600">
        Company ID: {status?.company_id ? <span className="font-semibold text-slate-900">{status.company_id}</span> : <span className="text-slate-400">Not created</span>}
        {loading && <span className="ml-2 text-blue-600">Updating...</span>}
      </p>
      {status?.connectivity?.checked ? (
        <p className={`text-xs font-semibold ${status.connectivity.reachable ? 'text-emerald-700' : 'text-amber-700'}`}>
          Dashboard API: {status.connectivity.reachable ? `reachable${status.connectivity.status ? ` (${status.connectivity.status})` : ''}` : `unreachable${status.connectivity.error ? ` - ${status.connectivity.error}` : ''}`}
        </p>
      ) : null}
      <div className="grid max-w-6xl grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-3">
        {(status?.agents ?? []).map((agent) => (
          <span
            key={agent.agent_id}
            className={`grid max-w-full grid-cols-[minmax(0,1fr)_8.75rem] items-center gap-2 rounded-xl border px-3 py-1.5 font-mono text-xs ${
              agent.dashboard_agent_id ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            <span className="min-w-0">
              <span className="block font-semibold">{agent.name}</span>
              <span className="block truncate">{agent.dashboard_agent_id || 'not created'}</span>
            </span>
            <select
              value={agentModels[agent.agent_id] || DEFAULT_AGENT_MODELS[agent.agent_id]}
              onChange={(event) => onAgentModelChange(agent.agent_id, event.target.value)}
              className="w-full rounded-lg border border-white/80 bg-white px-2 py-1 text-xs font-semibold text-slate-700 shadow-sm focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-100"
              aria-label={`${agent.name} model`}
            >
              {AGENT_MODEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </span>
        ))}
        {!status?.agents?.length && <span className="text-slate-400">Agents: Not loaded</span>}
      </div>
      {createdAgents.length > 0 && (
        <p className="text-xs text-slate-500">
          Agents created: {createdAgents.length}/{status?.agents.length ?? 0}
        </p>
      )}
      {status?.warnings?.length ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {status.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeleteCompanyModal({ defaultCompanyId, onDelete, onClose }: { defaultCompanyId: string; onDelete: (id: string) => void; onClose: () => void }) {
  const [companyId, setCompanyId] = useState(defaultCompanyId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-bold text-slate-900">Delete Dashboard Company</h2>
        <p className="mt-2 text-sm text-slate-600">
          Enter the company ID to delete from the contest dashboard. This action is irreversible.
        </p>
        <input
          type="text"
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          placeholder="Company UUID..."
          className="mt-4 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-sm focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100"
        />
        {defaultCompanyId && (
          <p className="mt-2 text-xs text-slate-500">
            Pre-filled from last registered company.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={() => companyId.trim() && onDelete(companyId.trim())}
            disabled={!companyId.trim()}
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsText(file);
  });
}

function waitForBrowserPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

function RequirementImageInput({ images, onChange }: { images: RequirementImage[]; onChange: (images: RequirementImage[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const MAX_IMAGES = 8;
  const MAX_SIZE = 5 * 1024 * 1024;
  const MIN_UPLOAD_SPINNER_MS = 700;

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;

    setIsUploading(true);
    const startedAt = Date.now();
    try {
      await waitForBrowserPaint();

      const newImages: RequirementImage[] = [];
      for (const file of files) {
        if (images.length + newImages.length >= MAX_IMAGES) break;
        if (file.size > MAX_SIZE) continue;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) continue;

        await waitForBrowserPaint();
        const dataUrl = await readFileAsDataUrl(file);
        newImages.push({
          name: file.name,
          mimeType: file.type as RequirementImage['mimeType'],
          sizeBytes: file.size,
          dataUrl
        });
        await waitForBrowserPaint();
      }

      if (newImages.length > 0) onChange([...images, ...newImages]);
    } finally {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs < MIN_UPLOAD_SPINNER_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_UPLOAD_SPINNER_MS - elapsedMs));
      }
      setIsUploading(false);
    }
  }

  function removeImage(index: number) {
    onChange(images.filter((_, i) => i !== index));
  }

  return (
    <section className="rounded-3xl bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="font-semibold">Requirement Images</span>
          <span className="ml-2 text-xs text-slate-500">(mockups/screenshots - max {MAX_IMAGES}, 5MB each)</span>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={images.length >= MAX_IMAGES || isUploading}
          aria-label={isUploading ? 'Uploading images' : 'Add images'}
          className="inline-flex min-w-[112px] items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
        >
          {isUploading ? (
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600"
              aria-hidden="true"
            />
          ) : (
            '+ Add Images'
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={handleFiles}
        />
      </div>
      {images.length > 0 && (
        <div className="mt-3 flex max-h-24 flex-col gap-1.5 overflow-y-auto pr-1">
          {images.map((image, index) => (
            <div key={`${image.name}-${index}`} className="group flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5">
              <img
                src={image.dataUrl}
                alt={image.name}
                className="h-8 w-8 flex-none rounded-lg border border-slate-200 object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-700">{image.name}</p>
                <p className="text-[11px] text-slate-500">{Math.round(image.sizeBytes / 1024)} KB</p>
              </div>
              <button
                type="button"
                onClick={() => removeImage(index)}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-bold text-red-500 hover:bg-red-100"
                aria-label={`Remove ${image.name}`}
              >
                X
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RunProgressModal(props: {
  status: RunStatusSnapshot;
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <LiveRunStatus {...props} />
      </div>
    </div>
  );
}

function LiveRunStatus({
  status,
  stopping,
  onStop,
  onClose
}: {
  status: RunStatusSnapshot;
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
}) {
  const runActive = status.status === 'QUEUED' || status.status === 'RUNNING';
  const frontendUrl = status.result ? getGeneratedFrontendUrl(status.result) : undefined;
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const costLabel = status.result?.costSummary ? formatUsd(status.result.costSummary.totalUsd) : null;

  useEffect(() => {
    const logContainer = logContainerRef.current;
    if (!logContainer) return;

    const frame = window.requestAnimationFrame(() => {
      logContainer.scrollTop = logContainer.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frame);
  }, [status.logs.length, status.runId]);

  return (
    <section className="bg-white p-5">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold">{status.result ? 'Run completed' : 'Terminal console'}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {status.runId} - {status.status}
            {costLabel ? ` - Cost ${costLabel}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {frontendUrl && (
            <a href={frontendUrl} target="_blank" rel="noreferrer" className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
              Open generated page
            </a>
          )}
          {runActive && (
            <button
              onClick={onStop}
              disabled={stopping}
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
            >
              {stopping ? 'Stopping...' : 'Stop'}
            </button>
          )}
          {status.result && (
            <Link href={`/runs/${status.runId}`} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
              View Run
            </Link>
          )}
          <button onClick={onClose} className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50" aria-label="Close run progress">
            X
          </button>
        </div>
      </div>

      {status.result && (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-bold text-emerald-800">Everything finished.</p>
          <p className="mt-1 text-sm text-emerald-700">
            Total AI cost: {costLabel || '$0.0000'} across {status.result.costSummary?.totalCalls ?? 0} model call(s).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {frontendUrl && (
              <a href={frontendUrl} target="_blank" rel="noreferrer" className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
                Open generated product
              </a>
            )}
            <Link href={`/runs/${status.runId}`} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
              View Run
            </Link>
          </div>
        </div>
      )}

      <div ref={logContainerRef} className="mt-5 max-h-[50vh] overflow-auto rounded-2xl bg-slate-950 p-4 font-mono text-xs text-slate-100">
        {status.logs.length === 0 ? (
          <p className="text-slate-400">Waiting for logs...</p>
        ) : (
          status.logs.map((log, index) => (
            <p key={`${log.timestamp}-${index}`} className={log.level === 'error' ? 'text-red-300' : log.level === 'success' ? 'text-emerald-300' : log.level === 'warn' ? 'text-amber-300' : 'text-slate-100'}>
              [{new Date(log.timestamp).toLocaleTimeString()}] {log.level.toUpperCase()}: {log.message}
            </p>
          ))
        )}
      </div>
    </section>
  );
}

function firstUrl(value: string | undefined) {
  return value?.match(/https?:\/\/[^\s"'<>),]+/)?.[0];
}

function getGeneratedFrontendUrl(result: RunResult) {
  const runtimeUrl = result.runtime?.services.find((service) => service.name === 'frontend' && service.url)?.url;
  if (runtimeUrl) return runtimeUrl;

  const frontendHealth = result.executionValidation?.steps.find((step) => step.name.toLowerCase().includes('frontend') && step.status === 'PASS');
  return firstUrl(frontendHealth?.message) || firstUrl(frontendHealth?.command);
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function ProgressDock({ status, onOpen }: { status: RunStatusSnapshot; onOpen: () => void }) {
  return (
    <div className="fixed bottom-5 left-5 z-40 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg">
      <button onClick={onOpen} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
        Show progress
      </button>
      <span className="pr-2 text-xs font-semibold text-slate-500">{status.status}</span>
    </div>
  );
}

function CompletionDock({ result, onOpenProgress }: { result: RunResult; onOpenProgress: () => void }) {
  const frontendUrl = getGeneratedFrontendUrl(result);
  const costLabel = result.costSummary ? formatUsd(result.costSummary.totalUsd) : '$0.0000';

  return (
    <div className="fixed bottom-5 left-5 z-40 flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-lg">
      {frontendUrl && (
        <a href={frontendUrl} target="_blank" rel="noreferrer" className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">
          Open generated page
        </a>
      )}
      {result.observationReportUrl && (
        <a href={result.observationReportUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-blue-200 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50">
          Open report
        </a>
      )}
      <Link href={`/runs/${result.runId}`} className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
        View Run
      </Link>
      <span className="px-2 text-xs font-semibold text-slate-500">Cost {costLabel}</span>
      <button onClick={onOpenProgress} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
        Show dialog
      </button>
    </div>
  );
}

function compactLogMessage(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 96 ? `${compact.slice(0, 96)}...` : compact;
}

function RancherRuntimeToast({
  status,
  dismissedKey,
  onDismiss
}: {
  status: RunStatusSnapshot;
  dismissedKey: string;
  onDismiss: (key: string) => void;
}) {
  if (status.status !== 'RUNNING' && status.status !== 'QUEUED') return null;

  const latest = [...status.logs].reverse().find((log) =>
    /rancher\/docker|rancher desktop|docker_engine|containerd socket|rdctl|compose engine|docker engine|prewarming rancher|cli and engine are ready/i.test(log.message)
  );
  if (!latest) return null;

  const toastKey = `${latest.timestamp}-${latest.message}`;
  if (dismissedKey === toastKey) return null;

  const ready = /already ready|became ready|cli and engine are ready/i.test(latest.message);
  const active = ready || /prewarming|not ready|starting rancher|launching rancher|waiting for rancher|docker_engine|containerd socket/i.test(latest.message);
  if (!active) return null;

  return (
    <div className={`fixed bottom-5 left-5 z-[60] w-[min(320px,calc(100vw-2rem))] rounded-2xl border bg-white p-3 shadow-xl ${ready ? 'border-emerald-200' : 'border-amber-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {ready ? (
            <span className="mt-1 h-3 w-3 shrink-0 rounded-full bg-emerald-500" aria-hidden="true" />
          ) : (
            <span className="mt-0.5 block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-amber-200 border-t-amber-600" aria-hidden="true" />
          )}
          <div>
            <p className="text-sm font-bold text-slate-900">{ready ? 'Rancher/Docker ready' : 'Starting Rancher/Docker'}</p>
            <p className="mt-0.5 text-xs text-slate-600">
              {ready ? 'Compose can run now.' : 'Waiting for Docker pipe, about 5 min.'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(toastKey)}
          className="-mr-1 -mt-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          aria-label="Close Rancher/Docker status"
        >
          X
        </button>
      </div>
      <p className="mt-2 break-words rounded-lg bg-slate-50 px-2 py-1.5 font-mono text-[10px] leading-3 text-slate-600">
        {compactLogMessage(latest.message)}
      </p>
    </div>
  );
}

function RunResultView({ result }: { result: RunResult }) {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-bold">Run completed</h2>
        <p className="mt-1 text-sm text-slate-500">Run ID: {result.runId}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">QA Status: {result.qaStatus || 'Not recorded'}</p>
        <p className="mt-1 text-sm text-slate-500">Code review fix iterations: {result.codeReviewFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">DevOps fix iterations: {result.deployFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Build readiness fix iterations: {result.buildReadinessFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">QA fix iterations: {result.qaFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Execution validation fixes: {result.executionValidationFixIterations ?? 0}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">AI cost: {result.costSummary ? formatUsd(result.costSummary.totalUsd) : '$0.0000'}</p>
        {result.visualComparison ? (
          <p className="mt-1 text-sm font-semibold text-slate-700">
            Visual comparison: {result.visualComparison.score}/100 ({result.visualComparison.status})
          </p>
        ) : null}
        {result.costBudgetUsd ? (
          <p className={`mt-1 text-sm font-semibold ${result.costBudgetExceeded ? 'text-amber-700' : 'text-slate-500'}`}>
            Cost budget: {formatUsd(result.costBudgetUsd)}{result.costBudgetExceeded ? ' reached' : ''}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-slate-500">Free image candidates: {result.freeImageCandidates?.length ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Prepared media assets: {result.preparedMediaAssets?.length ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">TA DEV context: {result.projectDevContextPath || result.projectDevSkillPath || 'Not recorded'}</p>
        <p className="mt-1 text-sm text-slate-500">Artifacts: {result.outputDir}</p>
        <p className="mt-1 text-sm text-slate-500">Generated code: {result.codeOutputDir}</p>
        <ExecutionValidationStatus result={result} />
        <RuntimeStatus result={result} />
        <DashboardEventSummary result={result} />
        <div className="mt-4 flex flex-wrap gap-3">
          {getGeneratedFrontendUrl(result) && (
            <a href={getGeneratedFrontendUrl(result)} target="_blank" rel="noreferrer" className="inline-flex rounded-2xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700">
              Open generated page
            </a>
          )}
          <Link href={`/runs/${result.runId}`} className="inline-flex rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white hover:bg-slate-800">
            Open run output
          </Link>
          {result.observationReportUrl && (
            <a href={result.observationReportUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-2xl border border-blue-200 px-5 py-3 font-semibold text-blue-700 hover:bg-blue-50">
              Open observation report
            </a>
          )}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {result.events.map((event, index) => (
            <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-bold uppercase text-blue-600">{event.agentId} · {event.eventType}</p>
              <p className="mt-2 text-sm text-slate-700">{event.task}</p>
              <p className="mt-2 text-xs text-slate-400">
                Dashboard: {event.dashboardAccepted ? 'accepted' : event.dashboardError ? 'rejected' : 'local only'}
                {event.dashboardStatus ? ` (${event.dashboardStatus})` : ''}
              </p>
              {event.dashboardError ? <p className="mt-1 break-words text-xs text-red-500">{event.dashboardError}</p> : null}
            </div>
          ))}
        </div>
      </div>

      <Artifact title="BA Artifacts" content={result.baOutput} />
      {result.uxContract ? <Artifact title="UX Contract" content={JSON.stringify(result.uxContract, null, 2)} /> : null}
      {result.agentModels ? <Artifact title="Agent Models" content={formatAgentModels(result.agentModels)} /> : null}
      {result.costSummary ? <Artifact title="AI Cost" content={formatCostSummary(result.costSummary)} /> : null}
      {result.costControlNotes?.length ? <Artifact title="Cost Controls" content={result.costControlNotes.map((note) => `- ${note}`).join('\n')} /> : null}
      {result.visualComparison ? <Artifact title="Visual Comparison" content={formatVisualComparison(result.visualComparison)} /> : null}
      <Artifact title="Architecture" content={result.devOutput.architecture} />
      <Artifact title="Generated Files" content={result.devOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')} />
      <Artifact title="Setup Instructions" content={result.devOutput.setupInstructions} />
      {result.freeImageCandidates?.length ? <Artifact title="Free Image Candidates" content={formatFreeImageCandidates(result.freeImageCandidates)} /> : null}
      {result.preparedMediaAssets?.length ? <Artifact title="Prepared Media Assets" content={formatPreparedMediaAssets(result.preparedMediaAssets)} /> : null}
      <Artifact title="QA Report" content={result.qaOutput} />
    </section>
  );
}

function DashboardEventSummary({ result }: { result: RunResult }) {
  if (!result.events.length) return null;
  const accepted = result.events.filter((event) => event.dashboardAccepted).length;
  const rejected = result.events.filter((event) => !event.dashboardAccepted && event.dashboardError).length;
  const localOnly = result.events.length - accepted - rejected;
  const firstRejected = result.events.find((event) => !event.dashboardAccepted && event.dashboardError);

  return (
    <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${rejected ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
      <p className="font-semibold">
        Dashboard events: {accepted} accepted, {rejected} rejected, {localOnly} local only
      </p>
      {firstRejected ? (
        <p className="mt-1 break-words text-xs">
          First rejection: {firstRejected.agentId}/{firstRejected.eventType}
          {firstRejected.dashboardPath ? ` via ${firstRejected.dashboardPath}` : ''}
          {firstRejected.dashboardStatus ? ` (${firstRejected.dashboardStatus})` : ''}: {firstRejected.dashboardError}
        </p>
      ) : null}
    </div>
  );
}

function formatFreeImageCandidates(candidates: NonNullable<RunResult['freeImageCandidates']>) {
  return candidates
    .map(
      (candidate, index) => `### ${index + 1}. ${candidate.title}

- Query: ${candidate.query}
- Image URL: ${candidate.imageUrl}
- Source page: ${candidate.pageUrl}
- License: ${candidate.license}${candidate.licenseUrl ? `\n- License URL: ${candidate.licenseUrl}` : ''}
`
    )
    .join('\n');
}

function formatPreparedMediaAssets(assets: NonNullable<RunResult['preparedMediaAssets']>) {
  return assets
    .map(
      (asset, index) => `### ${index + 1}. ${asset.title}

- Public URL: ${asset.publicUrl}
- Generated path: ${asset.path}
- Source image: ${asset.sourceImageUrl}
- Source page: ${asset.sourcePageUrl}
- Download URL: ${asset.downloadUrl}
- License: ${asset.license}${asset.licenseUrl ? `\n- License URL: ${asset.licenseUrl}` : ''}
- Query: ${asset.query}
- Type/size: ${asset.mimeType}, ${Math.round(asset.sizeBytes / 1024)} KB
`
    )
    .join('\n');
}

function formatAgentModels(models: AgentModelMap) {
  return Object.entries(models)
    .map(([agentId, model]) => `- ${agentId}: ${model}`)
    .join('\n');
}

function formatCostSummary(summary: NonNullable<RunResult['costSummary']>) {
  return [
    `Total: ${formatUsd(summary.totalUsd)}`,
    `Calls: ${summary.totalCalls}`,
    `Tokens: ${summary.totalTokens} total (${summary.promptTokens} prompt, ${summary.completionTokens} completion)`,
    '',
    '## By Agent',
    ...summary.byAgent.map((item) => `- ${item.id}: ${formatUsd(item.costUsd)} (${item.calls} calls, ${item.totalTokens} tokens)`),
    '',
    '## By Model',
    ...summary.byModel.map((item) => `- ${item.id}: ${formatUsd(item.costUsd)} (${item.calls} calls, ${item.totalTokens} tokens)`)
  ].join('\n');
}

function formatVisualComparison(comparison: NonNullable<RunResult['visualComparison']>) {
  return [
    `Status: ${comparison.status}`,
    `Score: ${comparison.score}/100`,
    `Report: ${comparison.reportPath}`,
    `URL: ${comparison.reportUrl}`,
    '',
    '## Findings',
    ...(comparison.findings.length ? comparison.findings.map((finding) => `- ${finding}`) : ['- none']),
    '',
    '## Recommendations',
    ...(comparison.recommendations.length ? comparison.recommendations.map((item) => `- ${item}`) : ['- none']),
    '',
    '## Evidence',
    `- Mockups: ${comparison.mockups.length}`,
    `- Screenshots: ${comparison.screenshots.length}`
  ].join('\n');
}

function ExecutionValidationStatus({ result }: { result: RunResult }) {
  if (!result.executionValidation) return null;

  return (
    <div className="mt-4 rounded-2xl border border-slate-200 p-4">
      <p className="text-sm font-bold uppercase text-blue-600">Execution validation - {result.executionValidation.status}</p>
      <p className="mt-2 text-sm text-slate-700">Workspace: {result.executionValidation.workspace}</p>
      {result.executionValidation.findings.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-red-700">
          {result.executionValidation.findings.slice(0, 5).map((finding) => (
            <li key={finding}>{finding}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RuntimeStatus({ result }: { result: RunResult }) {
  if (!result.runtime) return null;

  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      {result.runtime.services.map((service) => (
        <div key={service.name} className="rounded-2xl border border-slate-200 p-4">
          <p className="text-sm font-bold uppercase text-blue-600">
            {service.name} runtime - {service.status}
          </p>
          <p className="mt-2 text-sm text-slate-700">{service.message}</p>
          {service.url && (
            <a href={service.url} target="_blank" rel="noreferrer" className="mt-2 block text-sm font-semibold text-blue-700 hover:text-blue-800">
              {service.url}
            </a>
          )}
          {service.pid && <p className="mt-2 text-xs text-slate-500">PID: {service.pid}</p>}
          {service.logFile && <p className="mt-1 break-all text-xs text-slate-500">Log: {service.logFile}</p>}
        </div>
      ))}
    </div>
  );
}

function Artifact({ title, content }: { title: string; content: string }) {
  return (
    <details open className="rounded-3xl bg-white p-6 shadow-sm">
      <summary className="cursor-pointer text-xl font-bold">{title}</summary>
      <pre className="mt-4 max-h-[600px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-sm text-slate-100">{content}</pre>
    </details>
  );
}
