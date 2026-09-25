// apps/web/src/app/api/health/route.ts
//
// Real health check for the external uptime monitor
// (.github/workflows/monitor.yml). Deliberately public and read-only: it
// exposes only boolean/timestamp health facts, no user data, no config values.
//
// Returns 200 when healthy and 503 when a dependency is down, so a plain HTTP
// status check is enough to page on.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// If the alert cron hasn't run in this long, something is wrong with the
// schedule (GitHub disables schedules on inactive repos, secrets can rotate).
const ALERT_CRON_STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

export async function GET() {
  const startedAt = Date.now();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // --- Database ---
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (error: any) {
    checks.database = { ok: false, detail: error?.message?.slice(0, 200) || 'query failed' };
  }

  // --- Alert cron freshness ---
  // `currentPrice` is written on every cron pass, so the newest updatedAt
  // across active alerts is a real heartbeat. With no active alerts there is
  // nothing to check, which is not a failure.
  try {
    const activeCount = await prisma.priceAlert.count({ where: { status: 'ACTIVE' } });
    if (activeCount === 0) {
      checks.alertCron = { ok: true, detail: 'no active alerts to check' };
    } else {
      const latest = await prisma.priceAlert.findFirst({
        where: { status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      });
      const age = latest ? Date.now() - new Date(latest.updatedAt).getTime() : null;
      if (age === null) {
        checks.alertCron = { ok: true, detail: 'no data yet' };
      } else if (age > ALERT_CRON_STALE_AFTER_MS) {
        checks.alertCron = {
          ok: false,
          detail: `no alert check in ${Math.round(age / 60000)} min`,
        };
      } else {
        checks.alertCron = { ok: true, detail: `last check ${Math.round(age / 60000)} min ago` };
      }
    }
  } catch (error: any) {
    checks.alertCron = { ok: false, detail: error?.message?.slice(0, 200) || 'check failed' };
  }

  // --- Configuration presence (booleans only, never the values) ---
  checks.config = {
    ok: true,
    detail: [
      process.env.CRON_SECRET ? 'cron' : 'cron:MISSING',
      process.env.USER_SESSION_SECRET ? 'session' : 'session:MISSING',
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID ? 'telegram' : 'telegram:off',
    ].join(' '),
  };

  const healthy = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 }
  );
}
