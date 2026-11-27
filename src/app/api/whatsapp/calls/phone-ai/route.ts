import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { buildPhoneAiRequest, loadCallAiConfig } from '@/lib/whatsapp/call-ai'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * POST /api/whatsapp/calls/phone-ai — ask the connected external system
 * (Nutriherb panel, Dakiya, or a custom endpoint) to place its AI phone
 * call to a contact. Body: { conversation_id }.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`calls:${userId}`, RATE_LIMITS.calls)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { conversation_id?: unknown } | null
    const conversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : ''
    if (!conversationId) return NextResponse.json({ error: t('badRequest') }, { status: 400 })

    const ai = await loadCallAiConfig(supabase, accountId)
    const connector = ai?.phoneAi
    if (!connector || !connector.path) {
      return NextResponse.json({ error: t('phoneAiNotConfigured') }, { status: 400 })
    }

    const { data: conversation } = await supabase
      .from('conversations')
      .select('id, contact:contacts(name, phone)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    const contact = (conversation as unknown as { contact: { name: string | null; phone: string | null } | null } | null)
      ?.contact
    if (!contact?.phone) return NextResponse.json({ error: t('noRecipient') }, { status: 400 })

    const req = buildPhoneAiRequest(
      connector,
      { name: contact.name?.trim() || contact.phone, phone: contact.phone },
      { conversationId },
    )
    let res: Response
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
    } catch (err) {
      console.error('[calls] phone-AI connector unreachable:', err instanceof Error ? err.message : err)
      return NextResponse.json(
        { error: t('phoneAiUnreachable', { label: connector.label }) },
        { status: 502 },
      )
    }
    const text = await res.text()
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      parsed = null
    }
    // Nutriherb answers 200 with { ok: false, error } on refusals.
    const refused = !res.ok || parsed?.ok === false
    if (refused) {
      const reason = (parsed?.error as string) || (parsed?.message as string) || `HTTP ${res.status}`
      return NextResponse.json(
        { error: t('phoneAiRefused', { label: connector.label, reason: String(reason).slice(0, 300) }) },
        { status: 502 },
      )
    }
    return NextResponse.json({ success: true, label: connector.label, ref: parsed?.ref ?? null })
  } catch (error) {
    return toErrorResponse(error)
  }
}
