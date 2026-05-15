import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readRunResult } from '@/lib/storage/file-writer';

export const dynamic = 'force-dynamic';

export default async function RunOutputPage({ params }: { params: { runId: string } }) {
  const result = await readRunResult(params.runId);
  if (!result) notFound();

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Run Output</p>
              <h1 className="mt-2 text-4xl font-bold">{result.runId}</h1>
              <p className="mt-3 max-w-3xl text-slate-600">
                {result.topic} · {new Date(result.createdAt).toLocaleString()}
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-700">QA Status: {result.qaStatus || 'Not recorded'}</p>
              <p className="mt-1 text-sm text-slate-500">Build readiness fix iterations: {result.buildReadinessFixIterations ?? 0}</p>
              <p className="mt-1 text-sm text-slate-500">QA fix iterations: {result.qaFixIterations ?? 0}</p>
              <p className="mt-1 text-sm text-slate-500">Execution validation fixes: {result.executionValidationFixIterations ?? 0}</p>
              <p className="mt-2 text-sm text-slate-500">Artifacts: {result.outputDir}</p>
              <p className="mt-1 text-sm text-slate-500">Generated code: {result.codeOutputDir}</p>
              <ExecutionValidationStatus result={result} />
              <RuntimeStatus result={result} />
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/runs" className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
                All Runs
              </Link>
              <Link href="/" className="rounded-2xl bg-slate-900 px-5 py-3 font-semibold text-white hover:bg-slate-800">
                New Run
              </Link>
            </div>
          </div>
        </section>

        <section className="rounded-3xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold">Timeline</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {result.events.map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-slate-200 p-4">
                <p className="text-sm font-bold uppercase text-blue-600">{event.agentId} · {event.eventType}</p>
                <p className="mt-2 text-sm text-slate-700">{event.task}</p>
                <p className="mt-2 text-xs text-slate-400">Dashboard: {event.dashboardAccepted ? 'accepted' : 'local only'}</p>
              </div>
            ))}
          </div>
        </section>

        <Artifact title="BA Artifacts" content={result.baOutput} />
        <Artifact title="Architecture" content={result.devOutput.architecture} />
        <Artifact
          title="Generated Files"
          content={result.devOutput.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``).join('\n\n')}
        />
        <Artifact title="Setup Instructions" content={result.devOutput.setupInstructions} />
        {result.executionValidation && (
          <Artifact title="Execution Validation" content={JSON.stringify(result.executionValidation, null, 2)} />
        )}
        <Artifact title="QA Report" content={result.qaOutput} />
      </div>
    </main>
  );
}

function ExecutionValidationStatus({ result }: { result: Awaited<ReturnType<typeof readRunResult>> }) {
  if (!result?.executionValidation) return null;

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

function RuntimeStatus({ result }: { result: Awaited<ReturnType<typeof readRunResult>> }) {
  if (!result?.runtime) return null;

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
      <pre className="mt-4 max-h-[700px] overflow-auto whitespace-pre-wrap rounded-2xl bg-slate-950 p-4 text-sm text-slate-100">{content}</pre>
    </details>
  );
}
