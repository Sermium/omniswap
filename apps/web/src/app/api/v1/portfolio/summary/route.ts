// apps/web/src/app/api/v1/portfolio/summary/route.ts
//
// Live portfolio for the signed-in wallet. See lib/portfolio.ts for what is
// real here and what deliberately is not (cost basis / PnL cannot be derived
// from the data we store, so they are reported as unavailable rather than
// invented).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';
import { getChainById } from '@/lib/chain-config';
import { readEvmBalances, priceBalances, tokensFromSwaps } from '@/lib/portfolio';

export const maxDuration = 60;

// A snapshot is written at most this often, so the 30s UI refetch doesn't
// fill the table. This is what gives /historical real data over time.
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;

export async function GET() {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    const swaps = await prisma.swap.findMany({
      where: { userId: session.userId },
      select: {
        inputChainId: true,
        inputToken: true,
        outputChainId: true,
        outputToken: true,
      },
      take: 1000,
      orderBy: { createdAt: 'desc' },
    });

    const byChain = tokensFromSwaps(swaps);

    const balanceLists = await Promise.all(
      [...byChain].map(([chainId, tokens]) => readEvmBalances(chainId, session.address, tokens))
    );

    // Dust is noise, not a holding. The UI has its own "hide small balances"
    // toggle for USD value; this only drops true zeroes.
    const balances = balanceLists.flat().filter((b) => Number(b.balance) > 0);

    const { priced, totalValueUsd } = await priceBalances(balances);

    const holdings = priced.map((h) => {
      const chain = getChainById(h.chainId);
      const valueUsd = h.valueUsd ?? 0;
      return {
        id: `${h.chainId}:${h.address}`,
        token: {
          address: h.address,
          symbol: h.symbol || chain?.symbol || 'UNKNOWN',
          name: h.symbol || chain?.symbol || 'Unknown token',
          chainId: String(h.chainId),
          decimals: h.decimals,
        },
        balance: h.balance,
        balanceUsd: valueUsd.toString(),
        price: h.priceUsd === null ? '0' : h.priceUsd.toString(),
        priceChange24h: h.change24h,
        // Not derivable - see lib/portfolio.ts.
        avgCostBasis: '0',
        totalCost: '0',
        unrealizedPnl: '0',
        unrealizedPnlPercent: 0,
        allocation: totalValueUsd > 0 ? (valueUsd / totalValueUsd) * 100 : 0,
      };
    });

    holdings.sort((a, b) => Number(b.balanceUsd) - Number(a.balanceUsd));

    // 24h change is the value-weighted move of the priced holdings, which is a
    // real number: it comes from each token's actual 24h price change.
    const priceable = priced.filter((h) => h.valueUsd !== null);
    const valueNow = priceable.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    const value24hAgo = priceable.reduce(
      (s, h) => s + (h.valueUsd ?? 0) / (1 + (h.change24h || 0) / 100),
      0
    );
    const change24h = valueNow - value24hAgo;
    const change24hPercent = value24hAgo > 0 ? (change24h / value24hAgo) * 100 : 0;

    await recordSnapshot(session.userId, totalValueUsd, holdings);

    return NextResponse.json({
      portfolio: {
        totalValueUsd: totalValueUsd.toString(),
        totalCostBasis: '0',
        totalUnrealizedPnl: '0',
        totalUnrealizedPnlPercent: 0,
        change24h: change24h.toString(),
        change24hPercent,
        holdings,
      },
      // Explicit, so the UI can label PnL as unavailable instead of showing 0.
      costBasisAvailable: false,
      unpricedTokens: priced.filter((h) => h.priceUsd === null).length,
    });
  } catch (error) {
    console.error('Portfolio summary failed:', error);
    return NextResponse.json({ error: 'Failed to build portfolio' }, { status: 500 });
  }
}

/** Append to the snapshot history, at most once per SNAPSHOT_INTERVAL_MS. */
async function recordSnapshot(userId: string, totalValueUsd: number, holdings: unknown) {
  try {
    const portfolio = await prisma.portfolio.upsert({
      where: { userId },
      create: { userId, totalValueUsd, lastUpdatedAt: new Date() },
      update: { totalValueUsd, lastUpdatedAt: new Date() },
      select: { id: true },
    });

    const latest = await prisma.portfolioSnapshot.findFirst({
      where: { portfolioId: portfolio.id },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    });

    if (latest && Date.now() - latest.timestamp.getTime() < SNAPSHOT_INTERVAL_MS) return;

    await prisma.portfolioSnapshot.create({
      data: {
        portfolioId: portfolio.id,
        totalValueUsd,
        totalPnlUsd: 0,
        holdings: holdings as never,
      },
    });
  } catch (error) {
    // History is a nice-to-have; never fail the portfolio response over it.
    console.error('Portfolio snapshot write failed:', error);
  }
}
