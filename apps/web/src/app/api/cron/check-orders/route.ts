// apps/web/src/app/api/cron/check-orders/route.ts
//
// Price-watch sweep for limit orders and DCA strategies.
//
// WHAT THIS DOES NOT DO: it does not execute anything. OmniSwap is
// non-custodial - it never holds a key that could sign on the user's behalf -
// so a limit order can only be marked *ready* and surfaced to the user, who
// signs it themselves. Marking readiness is the honest half of the feature
// that can work without custody; an "executed automatically" claim would need
// either custody or an on-chain keeper contract with an allowance, which this
// deployment does not have.
//
// Protected by CRON_SECRET, like /api/cron/check-alerts.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerTokenPrice } from '@/lib/serverPrice';
import { isOrderReady } from '@/lib/orders';
import { notifyOperator } from '@/lib/telegram';

export const maxDuration = 60;

/**
 * Exchange rate of fromToken priced in toToken, from two real USD quotes.
 * Null when either side cannot be priced - never a guess.
 */
async function exchangeRate(
  fromChainId: string,
  fromToken: string,
  toChainId: string,
  toToken: string
): Promise<number | null> {
  const [from, to] = await Promise.all([
    getServerTokenPrice(fromChainId, fromToken),
    getServerTokenPrice(toChainId, toToken),
  ]);
  if (!from || !to || to.priceUsd <= 0) return null;
  return from.priceUsd / to.priceUsd;
}

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }

  const provided =
    request.headers.get('x-cron-secret') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (provided !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const errors: string[] = [];

  // ---- 1. Expire orders that ran out of time -------------------------------
  let expired = 0;
  try {
    const result = await prisma.limitOrder.updateMany({
      where: {
        status: { in: ['PENDING', 'PARTIALLY_FILLED'] },
        expiresAt: { not: null, lte: now },
      },
      data: { status: 'EXPIRED', readyAt: null, readyPrice: null },
    });
    expired = result.count;
  } catch (error) {
    errors.push(`expiry sweep: ${(error as Error).message}`);
  }

  // ---- 2. Mark limit orders whose target price has been reached -------------
  let ordersChecked = 0;
  let ordersReady = 0;

  try {
    const orders = await prisma.limitOrder.findMany({
      where: { status: 'PENDING' },
      take: 500,
    });

    for (const order of orders) {
      ordersChecked++;
      try {
        const rate = await exchangeRate(
          order.fromChainId,
          order.fromTokenAddress,
          order.toChainId,
          order.toTokenAddress
        );
        if (rate == null) continue;

        const ready = isOrderReady(order.type, Number(order.targetPrice), rate);

        if (!ready) {
          // The target moved back out of range - withdraw the ready flag so
          // the UI doesn't keep offering a stale "execute now".
          if (order.readyAt) {
            await prisma.limitOrder.update({
              where: { id: order.id },
              data: { readyAt: null, readyPrice: null },
            });
          }
          continue;
        }

        if (order.readyAt) continue; // already flagged, don't re-notify

        await prisma.limitOrder.update({
          where: { id: order.id },
          data: { readyAt: now, readyPrice: rate.toString() },
        });
        ordersReady++;

        await prisma.notification.create({
          data: {
            userId: order.userId,
            type: 'LIMIT_ORDER',
            title: `${order.fromTokenSymbol} -> ${order.toTokenSymbol} is ready`,
            message:
              `Your ${order.type.toLowerCase()} order hit its target of ` +
              `${order.targetPrice} ${order.toTokenSymbol} per ${order.fromTokenSymbol} ` +
              `(now ${rate.toPrecision(6)}). Open OmniSwap to sign and execute it.`,
          },
        });
      } catch (error) {
        errors.push(`order ${order.id}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    errors.push(`order sweep: ${(error as Error).message}`);
  }

  // ---- 3. Mark DCA strategies that are due ---------------------------------
  let strategiesChecked = 0;
  let strategiesReady = 0;

  try {
    const strategies = await prisma.dCAStrategy.findMany({
      where: { status: 'ACTIVE', nextExecutionAt: { lte: now }, readyAt: null },
      take: 500,
    });

    for (const strategy of strategies) {
      strategiesChecked++;
      try {
        await prisma.dCAStrategy.update({
          where: { id: strategy.id },
          data: { readyAt: now },
        });
        strategiesReady++;

        await prisma.notification.create({
          data: {
            userId: strategy.userId,
            type: 'DCA',
            title: `DCA buy due: ${strategy.fromTokenSymbol} -> ${strategy.toTokenSymbol}`,
            message:
              `${strategy.amountPerExecution} ${strategy.fromTokenSymbol} is scheduled. ` +
              `Open OmniSwap to sign and execute it.`,
          },
        });
      } catch (error) {
        errors.push(`strategy ${strategy.id}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    errors.push(`DCA sweep: ${(error as Error).message}`);
  }

  if (errors.length > 0) {
    await notifyOperator(
      `Order sweep finished with ${errors.length} error(s):\n${errors.slice(0, 5).join('\n')}`
    );
  }

  return NextResponse.json({
    expired,
    ordersChecked,
    ordersReady,
    strategiesChecked,
    strategiesReady,
    errors,
  });
}
