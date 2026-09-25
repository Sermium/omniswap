// apps/web/src/app/api/payments/stripe/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { notifyOperator } from '@/lib/telegram';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('stripe-signature');
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    if (!signature || !webhookSecret || !process.env.STRIPE_SECRET_KEY) {
      return NextResponse.json({ error: 'Missing signature or webhook secret' }, { status: 400 });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    });

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: any) {
      console.error('Webhook signature verification failed:', err.message);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        if (session.payment_status !== 'paid') {
          console.warn(`Session ${session.id} completed but payment_status is "${session.payment_status}"`);
          break;
        }

        // Stripe's webhook - not the browser redirect - is the source of truth
        // for payment completion. Rows created before checkout carry their id in
        // the session metadata so we can settle them here.
        const metadata = session.metadata || {};

        if (metadata.type === 'ad_booking' && metadata.bookingId) {
          const settings = await prisma.platformSettings.findUnique({ where: { id: 'default' } });
          await prisma.adBooking.update({
            where: { id: metadata.bookingId },
            data: {
              paymentStatus: 'PAID',
              paidAt: new Date(),
              paymentTxHash: session.id,
              paymentChainId: 'stripe',
              paymentMethod: 'USD',
              status: settings?.adRequiresApproval ? 'PENDING_APPROVAL' : 'APPROVED',
            },
          });

          await notifyOperator('Ad booking paid (Stripe)', [
            ['Booking', metadata.bookingId],
            ['Amount', session.amount_total != null ? `$${(session.amount_total / 100).toFixed(2)}` : null],
            ['Email', session.customer_details?.email || null],
          ]);
        } else if (metadata.type === 'token_listing' && metadata.listingId) {
          await prisma.tokenListingRequest.update({
            where: { id: metadata.listingId },
            data: {
              paymentStatus: 'PAID',
              paidAt: new Date(),
              paymentTxHash: session.id,
              paymentChainId: 'stripe',
              paymentMethod: 'USD',
              status: 'PENDING_REVIEW',
            },
          });

          await notifyOperator('Token listing paid (Stripe)', [
            ['Listing', metadata.listingId],
            ['Amount', session.amount_total != null ? `$${(session.amount_total / 100).toFixed(2)}` : null],
            ['Email', session.customer_details?.email || null],
          ]);
        } else {
          console.warn(`Session ${session.id} paid but metadata had no bookingId/listingId to settle`, metadata);
        }

        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        const metadata = session.metadata || {};

        // Release the pending row so the slot/token isn't blocked forever.
        if (metadata.type === 'ad_booking' && metadata.bookingId) {
          await prisma.adBooking.updateMany({
            where: { id: metadata.bookingId, paymentStatus: { not: 'PAID' } },
            data: { status: 'CANCELLED', paymentStatus: 'FAILED' },
          });
        } else if (metadata.type === 'token_listing' && metadata.listingId) {
          await prisma.tokenListingRequest.updateMany({
            where: { id: metadata.listingId, paymentStatus: { not: 'PAID' } },
            data: { status: 'CANCELLED', paymentStatus: 'FAILED' },
          });
        }
        break;
      }
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error('Webhook error:', error);
    return NextResponse.json({ error: 'Webhook handler failed' }, { status: 500 });
  }
}

