import fs from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

function reportsDir() {
  return path.resolve(process.cwd(), 'reports');
}

function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function resolveReportPath(parts: string[]) {
  const base = reportsDir();
  const target = path.resolve(base, ...parts);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid report path.');
  }
  return target;
}

export async function GET(_request: NextRequest, { params }: { params: { path: string[] } }) {
  try {
    const filePath = resolveReportPath(params.path);
    const file = await fs.readFile(filePath);
    return new NextResponse(file, {
      headers: {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store'
      }
    });
  } catch {
    return NextResponse.json({ error: 'Report not found.' }, { status: 404 });
  }
}
