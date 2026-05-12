'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { RunResult } from '@/lib/types';

const DEFAULT_REQUIREMENTS = `# Simple Shopping Cart App

## Overview
Build a full-stack Watch shopping cart app.

## In Scope
Only implement features defined below.

### Features
Only implement 2 pages:
1. Home Page – Product list page.
2. Product Detail Page – View details of a product.

Mockup files are provided for UI/UX, layout, header, footer, navigation bar, and menu.

## Out of Scope
- NFRs
- Implementing all features shown in mockups`;

const DEFAULT_TECH_SPEC = `# Simple Shopping Cart App

## Overview
Build a full-stack shopping cart app.

### Technical Stack
| Layer | Technology |
|---|---|
| Frontend | Next.js + Tailwind CSS |
| Backend | FastAPI + SQLModel |
| Database | SQLite |`;

export default function HomePage() {
  const [requirements, setRequirements] = useState(DEFAULT_REQUIREMENTS);
  const [techSpec, setTechSpec] = useState(DEFAULT_TECH_SPEC);
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function runAgents() {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requirements,
          techSpec: techSpec.trim() ? techSpec : null,
          topic: 'Simple Shopping Cart App'
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Run failed');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function registerDashboard() {
    setError('');
    try {
      const response = await fetch('/api/dashboard/register', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Dashboard registration failed');
      alert(`Company created: ${data.company_id}\nCopy it into DASHBOARD_COMPANY_ID in .env.local.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">AI Tech Contest Phase 1</p>
              <h1 className="mt-2 text-4xl font-bold">Agentic Sprint Builder</h1>
              <p className="mt-3 max-w-3xl text-slate-600">
                Markdown-skill BA, DEV, and QA agents read requirements, generate artifacts, write implementation files,
                and emit dashboard events through an orchestrated SDLC flow.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/runs" className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
                View Runs
              </Link>
              <button onClick={registerDashboard} className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
                Register Dashboard Company
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Editor title="requirements.md" value={requirements} onChange={setRequirements} />
          <Editor title="tech-spec.md optional" value={techSpec} onChange={setTechSpec} />
        </section>

        <div className="flex items-center gap-3">
          <button disabled={loading} onClick={runAgents} className="rounded-2xl bg-blue-600 px-6 py-3 font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60">
            {loading ? 'Running AI Team...' : 'Run AI Team'}
          </button>
          {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        </div>

        {result && <RunResultView result={result} />}
      </div>
    </main>
  );
}

function Editor(props: { title: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block rounded-3xl bg-white p-5 shadow-sm">
      <span className="font-semibold">{props.title}</span>
      <textarea
        className="mt-3 h-80 w-full resize-y rounded-2xl border border-slate-200 bg-slate-50 p-4 font-mono text-sm"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function RunResultView({ result }: { result: RunResult }) {
  return (
    <section className="space-y-6">
      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h2 className="text-2xl font-bold">Run completed</h2>
        <p className="mt-1 text-sm text-slate-500">Run ID: {result.runId}</p>
        <p className="mt-1 text-sm font-semibold text-slate-700">QA Status: {result.qaStatus || 'Not recorded'}</p>
        <p className="mt-1 text-sm text-slate-500">Build readiness fix iterations: {result.buildReadinessFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">QA fix iterations: {result.qaFixIterations ?? 0}</p>
        <p className="mt-1 text-sm text-slate-500">Artifacts: {result.outputDir}</p>
        <p className="mt-1 text-sm text-slate-500">Generated code: {result.codeOutputDir}</p>
        <Link href={`/runs/${result.runId}`} className="mt-4 inline-flex rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white hover:bg-slate-800">
          Open run output
        </Link>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {result.events.map((event, index) => (
            <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-bold uppercase text-blue-600">{event.agentId} · {event.eventType}</p>
              <p className="mt-2 text-sm text-slate-700">{event.task}</p>
              <p className="mt-2 text-xs text-slate-400">Dashboard: {event.dashboardAccepted ? 'accepted' : 'local only'}</p>
            </div>
          ))}
        </div>
      </div>

      <Artifact title="BA Artifacts" content={result.baOutput} />
      <Artifact title="Architecture" content={result.devOutput.architecture} />
      <Artifact title="Generated Files" content={result.devOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')} />
      <Artifact title="Setup Instructions" content={result.devOutput.setupInstructions} />
      <Artifact title="QA Report" content={result.qaOutput} />
    </section>
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
