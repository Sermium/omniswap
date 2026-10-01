// apps/web/src/app/api/v1/portfolio/transactions/route.ts
//
// The signed-in wallet's swap history, straight from the Swap rows this app
// wrote. Same-chain swaps are reported as "swap", cross-chain as "bridge".

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';
import { getChainById } from '@/lib/chain-config';
import { getServerTokenPrice } from '@/lib/serverPrice';

/** Swap.status is a free-text string; map it onto what the UI renders. */
function uiStatus(status: string): 'completed' | 'pending' | 'failed' {
  const s = status.toUpperCase();
  if (s === 'COMPLETED' || s === 'SUCCESS' || s === 'FILLED') return 'completed';
  if (s === 'FAILED' || s === 'CANCELLED' || s === 'REFUNDED') return 'failed';
  return 'pending';
}

export async function GET(request: NextRequest) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const limitParam = Number(request.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;

  try {
    const swaps = await prisma.swap.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        steps: {
          where: { txHash: { not: null } },
          orderBy: { stepIndex: 'asc' },
          select: { txHash: true },
          take: 1,
        },
      },
    });

    // Price the input side to get a USD value per transaction. Prices are
    // current, not historical - we have no historical price source - so a
    // token we cannot price reports an empty value rather than a wrong one.
    const transactions = await Promise.all(
      swaps.map(async (swap) => {
        const price = await getServerTokenPrice(swap.inputChainId, swap.inputToken);
        const amount = Number(swap.inputAmount);
        const valueUsd =
          price && Number.isFinite(amount) ? (amount * price.priceUsd).toString() : '';

        const inputChain = getChainById(swap.inputChainId);
        const outputChain = getChainById(swap.outputChainId);

        return {
          id: swap.id,
          type: swap.inputChainId === swap.outputChainId ? 'swap' : 'bridge',
          status: uiStatus(swap.status),
          fromToken: {
            symbol: shortSymbol(swap.inputToken, inputChain?.symbol),
            amount: swap.inputAmount,
          },
          toToken: {
            symbol: shortSymbol(swap.outputToken, outputChain?.symbol),
            amount: swap.actualOutput ?? swap.expectedOutput,
          },
          valueUsd,
          timestamp: (swap.completedAt ?? swap.createdAt).toISOString(),
          txHash: swap.steps[0]?.txHash ?? '',
          chainId: swap.inputChainId,
        };
      })
    );

    return NextResponse.json({ transactions });
  } catch (error) {
    console.error('Portfolio transactions failed:', error);
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}

/**
 * Swap rows store addresses, not symbols. Show the chain's native symbol for
 * the native sentinel, otherwise a truncated address - honest about what we
 * know rather than inventing a ticker.
 */
function shortSymbol(address: string, nativeSymbol?: string): string {
  const a = address.toLowerCase();
  if (
    a === '0x0000000000000000000000000000000000000000' ||
    a === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  ) {
    return nativeSymbol || 'NATIVE';
  }
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
