import { NextRequest, NextResponse } from 'next/server';
import { assertRunApiAccess } from '@/lib/security/api-guard';
import fs from 'fs/promises';
import path from 'path';

export const runtime = 'nodejs';

const CLEANUP_DIRS = [
  path.join(process.cwd(), 'generated-code'),
  path.join(process.cwd(), 'generated-runs')
];

export async function POST(request: NextRequest) {
  try {
    assertRunApiAccess(request);

    const removed: string[] = [];
    for (const dir of CLEANUP_DIRS) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        removed.push(path.basename(dir));
      } catch {
        // Directory may not exist, that's fine
      }
    }

    return NextResponse.json({ success: true, removed });
  } catch (error) {
    console.error('[cleanup] Failed', error);
    return NextResponse.json({ error: 'Cleanup failed.' }, { status: 500 });
  }
}
