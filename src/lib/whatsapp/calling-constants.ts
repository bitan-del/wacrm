/**
 * WhatsApp calling constants shared by server code and the browser
 * (Settings panel). Pure — no imports — so client bundles stay free of
 * the Graph API helpers.
 */

/** Meta's documented limits. */
export const CALLING_LIMITS = {
  /** `biz_opaque_callback_data` max length. */
  callbackData: 512,
  /** `recording.purpose` max length. */
  recordingPurpose: 250,
} as const

/** Locales Meta accepts for the recording announcement. */
export const RECORDING_ANNOUNCEMENT_LANGUAGES = [
  'en',
  'en_US',
  'en_GB',
  'en_IN',
  'en_AU',
  'en_CA',
  'en_NZ',
  'hi',
  'kn',
  'te',
  'es',
  'es_ES',
  'pt',
  'fr',
  'de',
  'it',
  'nl',
  'vi',
] as const

export type RecordingAnnouncementLanguage =
  (typeof RECORDING_ANNOUNCEMENT_LANGUAGES)[number]

export function isRecordingAnnouncementLanguage(
  value: unknown,
): value is RecordingAnnouncementLanguage {
  return (
    typeof value === 'string' &&
    (RECORDING_ANNOUNCEMENT_LANGUAGES as readonly string[]).includes(value)
  )
}
