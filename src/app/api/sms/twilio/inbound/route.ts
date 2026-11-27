import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolvePublicOrigin } from '@/lib/sms/config'
import { processInboundSms } from '@/lib/sms/inbound'
import { parseTwilioInbound } from '@/lib/sms/twilio'
import { verifySmsWebhook } from '@/lib/sms/webhook'

// Inbound processing (contact/conversation upsert, keyword handling and
// an optional HELP auto-reply) runs in after(); give it headroom.
export const maxDuration = 60

/** Empty TwiML: acknowledge without Twilio sending any reply itself. */
function emptyTwiml() {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  })
}

/**
 * POST /api/sms/twilio/inbound?cfg=<sms_config.id>
 *
 * Twilio's "A message comes in" webhook. Public (no session); trusted
 * only after X-Twilio-Signature validates against the matching
 * account's Auth Token — see `verifySmsWebhook`.
 */
export async function POST(request: Request) {
  const db = supabaseAdmin()
  const verified = await verifySmsWebhook(db, request, 'x-twilio-signature')
  if (!verified.ok) {
    console.warn(`[sms/twilio/inbound] rejected: ${verified.reason}`)
    return NextResponse.json({ error: verified.reason }, { status: verified.status })
  }

  const sms = parseTwilioInbound(verified.params)
  if (!sms) return NextResponse.json({ error: 'not an inbound message' }, { status: 400 })

  const origin = resolvePublicOrigin(request)
  const { config, provider } = verified

  // Ack fast (Twilio times out at 15 s); the work is kept alive by after().
  after(async () => {
    try {
      await processInboundSms(db, config, provider, sms, origin)
    } catch (err) {
      console.error('[sms/twilio/inbound] processing failed:', err)
    }
  })

  return emptyTwiml()
}
