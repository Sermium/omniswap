// apps/web/src/app/api/v1/dca/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';

/** Cancel a strategy. Scoped to { id, userId } so one user can't cancel another's. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id } = await params;

  try {
    const result = await prisma.dCAStrategy.updateMany({
      where: { id, userId: session.userId, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), readyAt: null },
    });

    if (result.count === 0) {
      return NextResponse.json(
        { error: 'Strategy not found, or already completed/cancelled' },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('DCA cancel failed:', error);
    return NextResponse.json({ error: 'Failed to cancel strategy' }, { status: 500 });
  }
}
