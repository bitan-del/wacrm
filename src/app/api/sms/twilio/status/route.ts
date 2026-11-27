import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { applySmsStatusEvent } from '@/lib/sms/status'
import { parseTwilioStatus } from '@/lib/sms/twilio'
import { verifySmsWebhook } from '@/lib/sms/webhook'

/**
 * POST /api/sms/twilio/status?cfg=<sms_config.id>
 *
 * Twilio's message StatusCallback (queued → sent → delivered /
 * undelivered / failed). We pass this URL on every send, so it always
 * carries `cfg`. Signature-verified like the inbound webhook.
 */
export async function POST(request: Request) {
  const db = supabaseAdmin()
  const verified = await verifySmsWebhook(db, request, 'x-twilio-signature')
  if (!verified.ok) {
    console.warn(`[sms/twilio/status] rejected: ${verified.reason}`)
    return NextResponse.json({ error: verified.reason }, { status: verified.status })
  }

  const event = parseTwilioStatus(verified.params)
  if (!event) return NextResponse.json({ error: 'not a status callback' }, { status: 400 })

  const accountId = verified.config.account_id
  after(async () => {
    try {
      await applySmsStatusEvent(db, accountId, event)
    } catch (err) {
      console.error('[sms/twilio/status] processing failed:', err)
    }
  })

  return new Response(null, { status: 204 })
}
