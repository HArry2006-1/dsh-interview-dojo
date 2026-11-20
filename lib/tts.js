/**
 * Optional natural Japanese speech through Microsoft Edge's online neural TTS.
 *
 * The third-party recognizer is loaded lazily: when the optional dependency is
 * absent the plugin still works with the browser's system voice.
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const EDGE_VOICES = [
  { id: 'ja-JP-NanamiNeural', name: '七海（女声，自然）', default: true },
  { id: 'ja-JP-KeitaNeural', name: '圭太（男声，自然）', default: false },
]

export const DEFAULT_EDGE_VOICE = EDGE_VOICES[0].id
const MAX_TEXT_CHARS = 900
const MAX_CACHE_FILES = 100

let edgeModulePromise
let edgeAvailable

export function edgeVoiceIds() {
  return EDGE_VOICES.map((voice) => voice.id)
}

export async function edgeTtsAvailable() {
  if (edgeAvailable !== undefined) return edgeAvailable
  try {
    const module = await loadEdgeModule()
    edgeAvailable = typeof module.EdgeTTS === 'function'
  } catch {
    edgeAvailable = false
  }
  return edgeAvailable
}

async function loadEdgeModule() {
  if (edgeModulePromise === undefined) {
    edgeModulePromise = import('@andresaya/edge-tts/dist/services/EdgeTTS.js').then((module) => {
      const EdgeTTS = module.EdgeTTS ?? module.default?.EdgeTTS ?? module.default
      if (typeof EdgeTTS !== 'function') throw new Error('Edge TTS 依赖未导出 EdgeTTS')
      return { EdgeTTS }
    })
  }
  return edgeModulePromise
}

function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
}

function rateExpression(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  const percent = Number.isFinite(number) ? Math.round(number) : 0
  const clamped = Math.max(-30, Math.min(20, percent))
  return `${clamped >= 0 ? '+' : ''}${clamped}%`
}

function cacheKey(text, voice, rate) {
  return createHash('sha256')
    .update(JSON.stringify({ text, voice, rate }))
    .digest('hex')
}

async function pruneCache(dir) {
  try {
    const names = await fs.readdir(dir)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.mp3')) continue
      const file = join(dir, name)
      const info = await fs.stat(file)
      files.push({ file, mtimeMs: info.mtimeMs })
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs)
    await Promise.all(files.slice(MAX_CACHE_FILES).map((entry) => fs.rm(entry.file, { force: true })))
  } catch {
    // Best effort; speech still works without a cache.
  }
}

/**
 * Synthesize one Japanese sentence/paragraph with Edge neural TTS.
 * @param {object} input
 * @param {string} input.text
 * @param {string} [input.voice]
 * @param {number} [input.rate] rate as a percentage delta (-30..20)
 * @param {string} input.audioDir
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs]
 */
export async function synthesizeEdge(input) {
  const text = cleanText(input?.text)
  if (text === '') throw new Error('没有可朗读的文本')
  const voice = edgeVoiceIds().includes(input?.voice) ? input.voice : DEFAULT_EDGE_VOICE
  const rate = rateExpression(input?.rate)
  const audioDir = input?.audioDir
  if (typeof audioDir !== 'string' || audioDir.trim() === '') throw new Error('缺少语音缓存目录')
  const key = cacheKey(text, voice, rate)
  const file = join(audioDir, `${key}.mp3`)
  try {
    const audio = await fs.readFile(file)
    return { audio, mimeType: 'audio/mpeg', cached: true, voice, rate }
  } catch {
    // Cache miss.
  }

  const { EdgeTTS } = await loadEdgeModule()
  const timeout = AbortSignal.timeout(input?.timeoutMs ?? 45000)
  const signal = input?.signal ? AbortSignal.any([input.signal, timeout]) : timeout
  const tts = new EdgeTTS()
  let result
  try {
    result = await tts.generate(text, voice, {
      rate,
      pitch: '+0Hz',
      signal,
      timeout: input?.timeoutMs ?? 30000,
    })
  } catch (error) {
    if (input?.signal?.aborted) throw new Error('朗读已取消')
    throw error instanceof Error ? error : new Error(String(error))
  }
  const audio = Buffer.from(result.audio)
  if (audio.length === 0) throw new Error('自然语音返回了空音频')
  try {
    await fs.mkdir(audioDir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    await fs.writeFile(temporary, audio, { mode: 0o600 })
    await fs.rename(temporary, file)
    await pruneCache(audioDir)
  } catch {
    // A cache write failure must not discard a successfully synthesized answer.
  }
  return {
    audio,
    mimeType: 'audio/mpeg',
    cached: false,
    voice,
    rate,
    duration: Number(result.duration) || 0,
  }
}
