// apps/web/src/app/api/v1/limit-orders/[id]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';

/**
 * Cancel an order. Scoped to { id, userId } via updateMany so a valid session
 * can't cancel someone else's order with a guessed id.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id } = await params;

  try {
    const result = await prisma.limitOrder.updateMany({
      // Only orders that haven't concluded can be cancelled.
      where: { id, userId: session.userId, status: { in: ['PENDING', 'PARTIALLY_FILLED'] } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: 'Cancelled by user',
        readyAt: null,
        readyPrice: null,
      },
    });

    if (result.count === 0) {
      return NextResponse.json(
        { error: 'Order not found, or it has already been filled or cancelled' },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Limit order cancel failed:', error);
    return NextResponse.json({ error: 'Failed to cancel order' }, { status: 500 });
  }
}
