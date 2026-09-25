import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { notifyOperator } from '@/lib/telegram';
import { verifyPayment } from '@/lib/paymentVerification';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      chainId,
      contractAddress,
      symbol,
      name,
      decimals,
      totalSupply,
      logoUrl,
      description,
      websiteUrl,
      whitepaperUrl,
      twitterUrl,
      telegramUrl,
      discordUrl,
      githubUrl,
      coingeckoId,
      coinmarketcapId,
      launchDate,
      isAudited,
      auditUrl,
      additionalNotes,
      email,
      telegramHandle,
      projectRole,
      listingFee,
      payment, // Payment info included
    } = body;

    // Validate required fields
    if (!chainId || !contractAddress || !symbol || !name || !email) {
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

    // Check if token already submitted
    const existing = await prisma.tokenListingRequest.findUnique({
      where: {
        chainId_contractAddress: {
          chainId: parseInt(chainId),
          contractAddress: contractAddress.toLowerCase(),
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'This token has already been submitted for listing' },
        { status: 409 }
      );
    }

    // Get settings
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 'default' },
    });

    // Fee comes from server-side settings, never from the client's `listingFee`.
    const expectedFee = settings?.tokenListingFee || 300;

    // Guard against one payment being reused for multiple listings.
    const priorClaims = await prisma.tokenListingRequest.aggregate({
      where: { paymentTxHash: payment.txHash, paymentStatus: 'PAID' },
      _sum: { listingFee: true },
    });
    const cumulativeExpectedUsd = (priorClaims._sum.listingFee ?? 0) + expectedFee;

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

    // Create listing request - payment is now verified against the chain / Stripe
    const listing = await prisma.tokenListingRequest.create({
      data: {
        chainId: parseInt(chainId),
        contractAddress: contractAddress.toLowerCase(),
        symbol: symbol.toUpperCase(),
        name,
        decimals: decimals || 18,
        totalSupply,
        logoUrl,
        description,
        websiteUrl,
        whitepaperUrl,
        twitterUrl,
        telegramUrl,
        discordUrl,
        githubUrl,
        coingeckoId,
        coinmarketcapId,
        launchDate: launchDate ? new Date(launchDate) : null,
        isAudited: isAudited || false,
        auditUrl,
        additionalNotes,
        email,
        telegramHandle,
        projectRole,
        listingFee: expectedFee,
        paymentStatus: 'PAID',
        paymentChainId: payment.chainId,
        paymentMethod: payment.token,
        paymentTxHash: payment.txHash,
        paidAt: new Date(),
        // Status is pending review (not pending payment)
        status: 'PENDING_REVIEW',
      },
    });

    console.log('Created listing request with payment:', listing.id, 'txHash:', payment.txHash);

    // Operator notification - guarded, cannot fail the paid listing.
    await notifyOperator('Token listing submitted', [
      ['Token', `${symbol.toUpperCase()} (${name})`],
      ['Chain', chainId],
      ['Contract', contractAddress],
      ['Fee', `$${expectedFee}`],
      ['Contact', email],
      ['Listing', listing.id],
    ]);

    return NextResponse.json(listing);
  } catch (error) {
    console.error('Failed to create listing request:', error);
    return NextResponse.json(
      { error: 'Failed to create listing request' },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');

    if (!email) {
      return NextResponse.json(
        { error: 'Email required' },
        { status: 400 }
      );
    }

    const listings = await prisma.tokenListingRequest.findMany({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(listings);
  } catch (error) {
    console.error('Failed to fetch listings:', error);
    return NextResponse.json(
      { error: 'Failed to fetch listings' },
      { status: 500 }
    );
  }
}
