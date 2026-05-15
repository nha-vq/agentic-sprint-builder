import Link from 'next/link';
import { listRunResults } from '@/lib/storage/file-writer';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const runs = await listRunResults();

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Run History</p>
              <h1 className="mt-2 text-4xl font-bold">Agent Outputs</h1>
              <p className="mt-3 max-w-3xl text-slate-600">
                Review BA, DEV, and QA artifacts from previous AI Team runs.
              </p>
            </div>
            <Link href="/" className="rounded-2xl border border-slate-200 px-5 py-3 font-semibold hover:bg-slate-50">
              New Run
            </Link>
          </div>
        </section>

        {runs.length === 0 ? (
          <section className="rounded-3xl bg-white p-8 text-slate-600 shadow-sm">
            No runs yet. Start a new run to generate artifacts.
          </section>
        ) : (
          <section className="grid gap-4">
            {runs.map((run) => (
              <Link
                key={run.runId}
                href={`/runs/${run.runId}`}
                className="block rounded-3xl bg-white p-6 shadow-sm hover:shadow-md"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-sm font-semibold uppercase text-blue-600">{run.topic}</p>
                    <h2 className="mt-1 text-2xl font-bold">{run.runId}</h2>
                    <p className="mt-2 text-sm text-slate-500">{new Date(run.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="grid gap-2 text-sm text-slate-600 md:min-w-72">
                    <p>Events: {run.events.length}</p>
                    <p>Files changed: {run.devOutput.files.length}</p>
                    <p>QA status: {run.qaStatus || 'Not recorded'}</p>
                    <p>Readiness fixes: {run.buildReadinessFixIterations ?? 0}</p>
                    <p>Execution validation: {run.executionValidation?.status || 'Not recorded'}</p>
                    <p>
                      Runtime:{' '}
                      {run.runtime
                        ? run.runtime.services.map((service) => `${service.name} ${service.status}`).join(', ')
                        : 'Not recorded'}
                    </p>
                    <p>Generated code: {run.codeOutputDir || 'generated-code'}</p>
                  </div>
                </div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
