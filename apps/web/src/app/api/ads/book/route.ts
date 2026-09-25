import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { notifyOperator } from '@/lib/telegram';
import { verifyPayment } from '@/lib/paymentVerification';
import { computeAdPricing } from '@/lib/adPricing';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      slotId,
      startDate,
      days,
      imageUrl,
      targetUrl,
      altText,
      email,
      companyName,
      contactName,
      // NOTE: body.pricing is intentionally NOT read - pricing is recomputed
      // server-side below from the slot's real basePrice.
      payment,
    } = body;

    // Validate required fields
    if (!slotId || !startDate || !days || !imageUrl || !targetUrl || !email) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Payment is required
    if (!payment?.txHash) {
      return NextResponse.json(
        { error: 'Payment transaction hash is required' },
        { status: 400 }
      );
    }

    // Get slot to verify it exists
    const slot = await prisma.adSlot.findUnique({
      where: { id: slotId },
    });

    if (!slot) {
      return NextResponse.json(
        { error: 'Ad slot not found' },
        { status: 404 }
      );
    }

    // Calculate end date
    const start = new Date(startDate);
    const end = new Date(start);
    end.setDate(end.getDate() + days - 1);

    // Check for conflicts (overlapping bookings)
    const conflicts = await prisma.adBooking.findMany({
      where: {
        slotId,
        status: {
          in: ['PENDING_APPROVAL', 'APPROVED', 'ACTIVE'],
        },
        OR: [
          {
            AND: [
              { startDate: { lte: start } },
              { endDate: { gte: start } },
            ],
          },
          {
            AND: [
              { startDate: { lte: end } },
              { endDate: { gte: end } },
            ],
          },
          {
            AND: [
              { startDate: { gte: start } },
              { endDate: { lte: end } },
            ],
          },
        ],
      },
    });

    if (conflicts.length > 0) {
      return NextResponse.json(
        { error: 'This slot is already booked for the selected dates' },
        { status: 409 }
      );
    }

    // Get settings for approval requirement
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 'default' },
    });

    // Recompute pricing SERVER-SIDE from the slot's real basePrice. The client's
    // `pricing` object is deliberately ignored - trusting it would let a caller
    // claim a $0.01 price and then "verify" a $0.01 payment for a real slot.
    const serverPricing = computeAdPricing({
      basePricePerDay: slot.basePrice,
      days,
      startDate: start,
    });

    // One payment can cover several slots (the UI books each slot in its own
    // request but sends the same txHash). So verify the payment covers the
    // cumulative total of everything already claimed against this txHash plus
    // this booking - which also stops one payment being replayed indefinitely.
    const priorClaims = await prisma.adBooking.aggregate({
      where: { paymentTxHash: payment.txHash, paymentStatus: 'PAID' },
      _sum: { finalPrice: true },
    });
    const cumulativeExpectedUsd = (priorClaims._sum.finalPrice ?? 0) + serverPricing.finalPrice;

    const verification = await verifyPayment({
      txHash: payment.txHash,
      chainId: String(payment.chainId),
      token: String(payment.token || ''),
      expectedAmountUsd: cumulativeExpectedUsd,
    });

    if (!verification.verified) {
      return NextResponse.json(
        { error: `Payment could not be verified: ${verification.reason}` },
        { status: 402 }
      );
    }

    // Create booking - payment is now verified against the chain / Stripe
    const booking = await prisma.adBooking.create({
      data: {
        slotId,
        email,
        companyName,
        contactName,
        startDate: start,
        endDate: end,
        days,
        imageUrl,
        targetUrl,
        altText,
        basePricePerDay: serverPricing.basePricePerDay,
        volumeDiscountPct: serverPricing.volumeDiscountPct,
        advanceDiscountPct: serverPricing.advanceDiscountPct,
        totalDiscountPct: serverPricing.totalDiscountPct,
        subtotal: serverPricing.subtotal,
        discountAmount: serverPricing.discountAmount,
        finalPrice: serverPricing.finalPrice,
        requiresApproval: settings?.adRequiresApproval ?? true,
        paymentStatus: 'PAID',
        paymentChainId: payment.chainId,
        paymentMethod: payment.token,
        paymentTxHash: payment.txHash,
        paidAt: new Date(),
        // Status is pending approval (not pending payment)
        status: settings?.adRequiresApproval ? 'PENDING_APPROVAL' : 'APPROVED',
      },
    });

    // Operator notification. Intentionally awaited-but-guarded: notifyOperator
    // never throws, so a Telegram outage cannot fail a paid booking.
    await notifyOperator('Ad booking paid', [
      ['Slot', slotId],
      ['Company', companyName || email],
      ['Amount', `$${serverPricing.finalPrice.toFixed(2)}`],
      ['Days', days],
      ['Starts', start.toISOString().slice(0, 10)],
      ['Status', booking.status],
      ['Booking', booking.id],
    ]);

    return NextResponse.json(booking);
  } catch (error) {
    console.error('Failed to create booking:', error);
    return NextResponse.json(
      { error: 'Failed to create booking' },
      { status: 500 }
    );
  }
}
