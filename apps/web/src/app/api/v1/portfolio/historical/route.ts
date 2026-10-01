// apps/web/src/app/api/v1/portfolio/historical/route.ts
//
// Portfolio value over time, from the snapshots written by
// /api/v1/portfolio/summary (at most one per hour).
//
// A new account has no history, so this returns an empty series until
// snapshots accumulate. It does not back-fill a synthetic curve.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';
import { timeframeCutoff } from '@/lib/portfolio';

export async function GET(request: NextRequest) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const timeframe = request.nextUrl.searchParams.get('timeframe') || '30d';
  const cutoff = timeframeCutoff(timeframe);

  try {
    const portfolio = await prisma.portfolio.findUnique({
      where: { userId: session.userId },
      select: { id: true },
    });

    if (!portfolio) return NextResponse.json({ data: [] });

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        portfolioId: portfolio.id,
        ...(cutoff ? { timestamp: { gte: cutoff } } : {}),
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, totalValueUsd: true },
      take: 2000,
    });

    return NextResponse.json({
      data: snapshots.map((s) => ({
        timestamp: s.timestamp.toISOString(),
        value: s.totalValueUsd,
      })),
    });
  } catch (error) {
    console.error('Portfolio history failed:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}
