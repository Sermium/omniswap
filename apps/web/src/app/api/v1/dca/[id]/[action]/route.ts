// apps/web/src/app/api/v1/dca/[id]/[action]/route.ts
//
// POST /api/v1/dca/:id/pause  and  /api/v1/dca/:id/resume
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';
import { nextExecutionAfter } from '@/lib/orders';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id, action } = await params;

  if (action !== 'pause' && action !== 'resume') {
    return NextResponse.json({ error: `Unsupported action "${action}"` }, { status: 400 });
  }

  try {
    const strategy = await prisma.dCAStrategy.findFirst({
      where: { id, userId: session.userId },
    });
    if (!strategy) {
      return NextResponse.json({ error: 'Strategy not found' }, { status: 404 });
    }

    if (action === 'pause') {
      if (strategy.status !== 'ACTIVE') {
        return NextResponse.json({ error: 'Only an active strategy can be paused' }, { status: 400 });
      }
      await prisma.dCAStrategy.update({
        where: { id },
        data: { status: 'PAUSED', pausedAt: new Date(), readyAt: null },
      });
    } else {
      if (strategy.status !== 'PAUSED') {
        return NextResponse.json({ error: 'Only a paused strategy can be resumed' }, { status: 400 });
      }
      // Re-base the schedule from now, so a long pause doesn't come back with
      // a pile of missed executions due at once.
      await prisma.dCAStrategy.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          pausedAt: null,
          nextExecutionAt: nextExecutionAfter(
            strategy.frequency,
            new Date(),
            strategy.customIntervalHours
          ),
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DCA action failed:', error);
    return NextResponse.json({ error: 'Failed to update strategy' }, { status: 500 });
  }
}
