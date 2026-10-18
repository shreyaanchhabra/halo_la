/** Optional bridge to the local VoiceID sidecar. A missing sidecar never blocks transcription. */

export type VoiceIdentity = {
  status: 'MATCH' | 'UNKNOWN' | 'UNCERTAIN'
  speaker_id: string | null
  speaker_name: string | null
  similarity_score: number | null
  reason?: string
}

const DEFAULT_TIMEOUT_MS = 3500

export async function identifySpeakerWav(
  wav: Uint8Array,
  options: { endpoint?: string; timeoutMs?: number } = {},
): Promise<VoiceIdentity | null> {
  const endpoint = (options.endpoint ?? process.env.HALO_VOICEID_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '')
  try {
    const response = await fetch(`${endpoint}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav as BodyInit,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const result = await response.json() as Partial<VoiceIdentity>
    if (!['MATCH', 'UNKNOWN', 'UNCERTAIN'].includes(String(result.status))) return null
    return {
      status: result.status as VoiceIdentity['status'],
      speaker_id: typeof result.speaker_id === 'string' ? result.speaker_id : null,
      speaker_name: typeof result.speaker_name === 'string' ? result.speaker_name : null,
      similarity_score: typeof result.similarity_score === 'number' ? result.similarity_score : null,
      reason: typeof result.reason === 'string' ? result.reason : undefined,
    }
  } catch {
    // VoiceID is optional: preserve HALO's current transcript/calendar path if the local service is off.
    return null
  }
}
