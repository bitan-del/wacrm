import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { CALL_RECORDINGS_BUCKET } from '@/lib/whatsapp/call-store'
import { getT } from '@/lib/i18n/translate'

const t = getT('Api.calls')

/**
 * GET /api/whatsapp/calls/[id]/recording — redirect to a 5-minute signed
 * URL for the call's recording. The bucket is private; access is
 * decided by RLS on the `calls` row (any account member).
 * `?download=1` asks the browser to save the file.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { supabase, accountId } = await getCurrentAccount()

    const { data: call } = await supabase
      .from('calls')
      .select('id, recording_path, recording_status, started_at')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!call || call.recording_status !== 'available' || !call.recording_path) {
      return NextResponse.json({ error: t('recordingNotFound') }, { status: 404 })
    }

    const download = new URL(request.url).searchParams.get('download') === '1'
    const ext = call.recording_path.split('.').pop() ?? 'ogg'
    const filename = `call-${String(call.started_at).slice(0, 19).replace(/[:T]/g, '-')}.${ext}`

    const { data, error } = await supabaseAdmin()
      .storage.from(CALL_RECORDINGS_BUCKET)
      .createSignedUrl(call.recording_path, 300, download ? { download: filename } : undefined)
    if (error || !data?.signedUrl) {
      console.error('[calls] could not sign recording URL:', error?.message)
      return NextResponse.json({ error: t('recordingNotFound') }, { status: 404 })
    }
    return NextResponse.redirect(data.signedUrl, { status: 302 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
