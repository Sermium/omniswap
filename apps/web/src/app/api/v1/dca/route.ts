// apps/web/src/app/api/v1/dca/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getUserSession } from '@/lib/user-auth';
import { UI_TO_DB_FREQUENCY, nextExecutionAfter, toUiStrategy } from '@/lib/orders';

export async function GET() {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    const strategies = await prisma.dCAStrategy.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return NextResponse.json({ strategies: strategies.map(toUiStrategy) });
  } catch (error) {
    console.error('DCA fetch failed:', error);
    return NextResponse.json({ error: 'Failed to fetch strategies' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  try {
    const body = await request.json();
    const {
      name,
      fromChainId,
      toChainId,
      fromTokenAddress,
      toTokenAddress,
      fromTokenSymbol,
      toTokenSymbol,
      amountPerExecution,
      frequency,
      customIntervalHours,
      totalExecutions,
      skipOnHighGas,
      maxGasUsd,
    } = body;

    if (!fromChainId || !toChainId || !fromTokenAddress || !toTokenAddress) {
      return NextResponse.json({ error: 'Missing token/chain fields' }, { status: 400 });
    }

    const amount = Number(amountPerExecution);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { error: 'amountPerExecution must be greater than 0' },
        { status: 400 }
      );
    }

    const dbFrequency =
      UI_TO_DB_FREQUENCY[String(frequency).toLowerCase()] ??
      (['HOURLY', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'].includes(
        String(frequency).toUpperCase()
      )
        ? (String(frequency).toUpperCase() as any)
        : null);

    if (!dbFrequency) {
      return NextResponse.json({ error: `Unsupported frequency "${frequency}"` }, { status: 400 });
    }
    if (dbFrequency === 'CUSTOM' && !Number(customIntervalHours)) {
      return NextResponse.json(
        { error: 'customIntervalHours is required for a custom frequency' },
        { status: 400 }
      );
    }

    const now = new Date();

    const strategy = await prisma.dCAStrategy.create({
      data: {
        userId: session.userId,
        name: name || null,
        fromChainId: String(fromChainId),
        toChainId: String(toChainId),
        fromTokenAddress,
        toTokenAddress,
        fromTokenSymbol: fromTokenSymbol || 'UNKNOWN',
        toTokenSymbol: toTokenSymbol || 'UNKNOWN',
        amountPerExecution: String(amountPerExecution),
        frequency: dbFrequency,
        customIntervalHours: customIntervalHours ? Number(customIntervalHours) : null,
        totalExecutions: totalExecutions ? Number(totalExecutions) : null,
        skipOnHighGas: Boolean(skipOnHighGas),
        maxGasUsd: maxGasUsd ? Number(maxGasUsd) : null,
        startAt: now,
        // First run is due one interval from now, not immediately, so creating
        // a strategy never surprises the user with an instant execution.
        nextExecutionAt: nextExecutionAfter(dbFrequency, now, Number(customIntervalHours) || null),
      },
    });

    return NextResponse.json(toUiStrategy(strategy), { status: 201 });
  } catch (error) {
    console.error('DCA creation failed:', error);
    return NextResponse.json({ error: 'Failed to create strategy' }, { status: 500 });
  }
}
