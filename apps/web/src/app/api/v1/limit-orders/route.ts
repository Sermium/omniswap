// apps/web/src/app/api/v1/limit-orders/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';
import type { OrderStatus } from '@prisma/client';
import { toUiOrder } from '@/lib/orders';

export async function GET(request: NextRequest) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const status = request.nextUrl.searchParams.get('status') || 'all';

  try {
    const where =
      status === 'active'
        ? { userId: session.userId, status: { in: ['PENDING', 'PARTIALLY_FILLED'] as OrderStatus[] } }
        : { userId: session.userId };

    const [orders, all] = await Promise.all([
      prisma.limitOrder.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.limitOrder.findMany({
        where: { userId: session.userId },
        select: { status: true, inputAmount: true },
      }),
    ]);

    const filled = all.filter((o) => o.status === 'FILLED').length;
    const closed = all.filter((o) =>
      ['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED'].includes(o.status)
    ).length;

    const stats = {
      totalOrders: all.length,
      activeOrders: all.filter((o) => o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED')
        .length,
      filledOrders: filled,
      totalVolume: all
        .reduce((sum, o) => sum + (Number(o.inputAmount) || 0), 0)
        .toString(),
      // Share of concluded orders that actually filled. Undefined (0) until
      // something has concluded, rather than a flattering 100%.
      successRate: closed > 0 ? (filled / closed) * 100 : 0,
    };

    return NextResponse.json({ orders: orders.map(toUiOrder), stats });
  } catch (error) {
    console.error('Limit order fetch failed:', error);
    return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      type,
      fromChainId,
      toChainId,
      fromTokenAddress,
      toTokenAddress,
      fromTokenSymbol,
      toTokenSymbol,
      inputAmount,
      targetPrice,
      slippage,
      expiresIn, // hours
    } = body;

    if (!fromChainId || !toChainId || !fromTokenAddress || !toTokenAddress) {
      return NextResponse.json({ error: 'Missing token/chain fields' }, { status: 400 });
    }

    const amount = Number(inputAmount);
    const target = Number(targetPrice);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'inputAmount must be greater than 0' }, { status: 400 });
    }
    if (!Number.isFinite(target) || target <= 0) {
      return NextResponse.json({ error: 'targetPrice must be greater than 0' }, { status: 400 });
    }

    const slippagePct = Number.isFinite(Number(slippage)) ? Number(slippage) : 0.5;
    // Guard against a minOutput of 0, which would accept any fill.
    const minOutputAmount = (amount * target * (1 - slippagePct / 100)).toString();

    const order = await prisma.limitOrder.create({
      data: {
        userId: session.userId,
        type: String(type).toLowerCase() === 'buy' ? 'BUY' : 'SELL',
        fromChainId: String(fromChainId),
        toChainId: String(toChainId),
        fromTokenAddress,
        toTokenAddress,
        fromTokenSymbol: fromTokenSymbol || 'UNKNOWN',
        toTokenSymbol: toTokenSymbol || 'UNKNOWN',
        inputAmount: String(inputAmount),
        targetPrice: String(targetPrice),
        minOutputAmount,
        slippage: slippagePct,
        expiresAt:
          expiresIn && Number(expiresIn) > 0
            ? new Date(Date.now() + Number(expiresIn) * 60 * 60 * 1000)
            : null,
      },
    });

    return NextResponse.json(toUiOrder(order), { status: 201 });
  } catch (error) {
    console.error('Limit order creation failed:', error);
    return NextResponse.json({ error: 'Failed to create order' }, { status: 500 });
  }
}
