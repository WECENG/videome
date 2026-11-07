const EMOTIONS = new Set(['neutral', 'warm', 'serious', 'excited', 'sad', 'calm'])
const RATES = { slow: 0.9, natural: 1, fast: 1.1 }
const PAUSES = { light: 0.65, normal: 1, strong: 1.45 }

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)) }

function normalizeStyle(style = {}) {
  const rate = clamp(style.rate ?? RATES[style.ratePreset] ?? 1, 0.82, 1.18)
  const pause = style.pause === 'light' || style.pause === 'strong' ? style.pause : 'normal'
  const emotion = EMOTIONS.has(style.emotion) ? style.emotion : 'neutral'
  return { emotion, rate, pause }
}

function splitProsodyText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  if (!value) return []
  const pieces = value.match(/[^，。！？；：、,.!?;:]+[，。！？；：、,.!?;:]?|[^，。！？；：、,.!?;:]+$/g) || [value]
  return pieces.map((piece) => piece.trim()).filter(Boolean)
}

function pauseFor(text, style) {
  const last = String(text).slice(-1)
  const base = last === '。' || last === '.' ? 260 : last === '！' || last === '!' ? 300 : last === '？' || last === '?' ? 330 : last === '；' || last === ';' ? 180 : last === '，' || last === ',' || last === '、' ? 115 : 55
  return Math.round(base * PAUSES[style.pause])
}

function analyzeProsody(text, style = {}) {
  const normalized = normalizeStyle(style)
  const parts = splitProsodyText(text)
  const segments = parts.map((value, index) => {
    const ending = value.slice(-1)
    let segmentRate = normalized.rate
    if (normalized.emotion === 'excited') segmentRate = clamp(segmentRate * 1.14, 0.78, 1.25)
    if (normalized.emotion === 'warm') segmentRate = clamp(segmentRate * 1.03, 0.78, 1.25)
    if (normalized.emotion === 'calm') segmentRate = clamp(segmentRate * 0.9, 0.78, 1.25)
    if (normalized.emotion === 'sad' || normalized.emotion === 'serious') segmentRate = clamp(segmentRate * 0.84, 0.78, 1.25)
    if (ending === '？' || ending === '?') segmentRate = clamp(segmentRate * 0.96, 0.82, 1.18)
    if (ending === '！' || ending === '!') segmentRate = clamp(segmentRate * 1.08, 0.78, 1.25)
    return { text: value, rate: Number(segmentRate.toFixed(3)), pauseAfterMs: index === parts.length - 1 ? 0 : pauseFor(value, normalized) }
  })
  return { ...normalized, segments }
}

function normalizeProsodyPlan(text, plan, style = {}) {
  const fallback = analyzeProsody(text, style)
  if (!plan || !Array.isArray(plan.segments) || plan.segments.length === 0) return fallback
  const segments = plan.segments.map((segment, index) => ({
    text: String(segment.text || '').trim(),
    rate: clamp(segment.rate, 0.78, 1.25),
    pauseAfterMs: Math.round(clamp(segment.pauseAfterMs, 0, 900)),
  })).filter((segment) => segment.text)
  return segments.length ? { ...fallback, ...normalizeStyle(plan), segments } : fallback
}

module.exports = { EMOTIONS, RATES, PAUSES, normalizeStyle, splitProsodyText, analyzeProsody, normalizeProsodyPlan }
