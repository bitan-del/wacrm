import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * POST /api/whatsapp/calls/dial — the Calls page dialer.
 * Body: { phone, name? } — a number in international format (country
 * code first, any spacing / "+" / dashes). Finds or creates the contact
 * and its conversation, so the call (or the permission request) runs
 * through the same path as calling from a chat.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { phone?: unknown; name?: unknown } | null
    const phone = normalizePhone(typeof body?.phone === 'string' ? body.phone : '')
    if (!/^[1-9]\d{7,14}$/.test(phone)) {
      return NextResponse.json({ error: t('dialBadNumber') }, { status: 400 })
    }
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : ''

    let contact = await findExistingContact(supabase, accountId, phone)
    if (!contact) {
      const { data: created, error } = await supabase
        .from('contacts')
        .insert({ account_id: accountId, user_id: userId, phone, name: name || phone })
        .select('*')
        .single()
      if (error) {
        if (isUniqueViolation(error)) contact = await findExistingContact(supabase, accountId, phone)
        if (!contact) {
          console.error('[calls] dialer could not create contact:', error.message)
          return NextResponse.json({ error: t('unexpected') }, { status: 500 })
        }
      } else {
        contact = created
      }
    }
    if (!contact) {
      return NextResponse.json({ error: t('unexpected') }, { status: 500 })
    }

    const findConversation = async () => {
      const { data } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contact!.id)
        .order('created_at', { ascending: true })
        .limit(1)
      return (data?.[0]?.id as string | undefined) ?? null
    }
    let conversationId = await findConversation()
    if (!conversationId) {
      const { data: conv, error } = await supabase
        .from('conversations')
        .insert({ account_id: accountId, user_id: userId, contact_id: contact.id })
        .select('id')
        .single()
      if (error && isUniqueViolation(error)) conversationId = await findConversation()
      else if (error) {
        console.error('[calls] dialer could not open conversation:', error.message)
        return NextResponse.json({ error: t('unexpected') }, { status: 500 })
      } else conversationId = conv.id as string
    }

    const c = contact as { id: string; name?: string | null; phone: string }
    return NextResponse.json({
      conversation_id: conversationId,
      contact_id: c.id,
      label: c.name?.trim() || c.phone,
      phone: c.phone,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
