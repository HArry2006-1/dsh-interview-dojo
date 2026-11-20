/**
 * Interview Dojo host half.
 *
 * One prefix route serves the browser panel. Expensive work stays here:
 * official-site research through ctx.web, JSON generation through ctx.llm,
 * statement extraction, and local session persistence.
 */

import {
  STATEMENT_MAX_BYTES,
  extractDocument,
} from './lib/extract.js'
import { callJson, currentSelection, listModelCatalog, resolveSelection } from './lib/llm-call.js'
import { buildHintPrompt, buildOpeningPrompt, buildReportPrompt, buildResearchPrompt, buildTurnPrompt } from './lib/prompts.js'
import { collectUniversitySources } from './lib/research.js'
import {
  normalizeHint,
  normalizeOpening,
  normalizeReport,
  normalizeResearch,
  normalizeSessionSnapshot,
  normalizeTurn,
} from './lib/schema.js'
import {
  DEFAULT_EDGE_VOICE,
  EDGE_VOICES,
  edgeTtsAvailable,
  edgeVoiceIds,
  synthesizeEdge,
} from './lib/tts.js'
import {
  createSessionRecord,
  dataPaths,
  deleteSession,
  ensureDataDirs,
  latestSession,
  pruneSessions,
  readResearchCache,
  readSession,
  researchCacheKey,
  saveArchive,
  saveSession,
  writeResearchCache,
} from './lib/store.js'

const PREFIX = '/dsh-interview-dojo'
const BODY_LIMIT = 12 * 1024 * 1024
const ANSWER_MAX = 6000
const MAX_TURNS = 30

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

function ok(res, body = {}) {
  json(res, 200, { ok: true, ...body })
}

function fail(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return false
  }
  return true
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    const finish = (error, value) => {
      if (settled) return
      settled = true
      req.removeAllListeners('data')
      req.removeAllListeners('end')
      req.removeAllListeners('aborted')
      req.removeAllListeners('close')
      if (error) reject(error)
      else resolve(value)
    }
    const fail = (error) => {
      finish(error)
      req.on('error', () => {})
      try { req.resume() } catch { /* ignore */ }
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        fail(new HttpError(413, 'payload-too-large', '请求体过大（限制 12MB）'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      if (chunks.length === 0) {
        finish(undefined, {})
        return
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = JSON.parse(text)
        finish(undefined, value && typeof value === 'object' ? value : {})
      } catch {
        finish(new HttpError(400, 'invalid-json', '请求不是有效的 JSON'))
      }
    })
    req.on('aborted', () => {
      fail(new HttpError(400, 'request-aborted', '请求已中断'))
    })
    req.on('close', () => {
      if (!settled && req.complete !== true) {
        fail(new HttpError(400, 'request-aborted', '请求已中断'))
      }
    })
    req.on('error', (error) => {
      fail(error instanceof HttpError ? error : new HttpError(400, 'request-failed', '读取请求失败'))
    })
  })
}

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asStringArray(value, limit = 12) {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim().slice(0, 500) : ''))
    .filter(Boolean)
    .slice(0, limit)
}

function readSetup(body) {
  const setup = body?.setup && typeof body.setup === 'object' ? body.setup : {}
  const university = cleanString(setup.university, 100)
  if (university === '') throw new HttpError(400, 'university-required', '请填写目标大学')
  return {
    university,
    faculty: cleanString(setup.faculty, 120),
    major: cleanString(setup.major, 120),
    program: cleanString(setup.program, 60) || '学部（本科）',
    format: cleanString(setup.format, 60) || '个人面试',
    jlpt: cleanString(setup.jlpt, 30) || 'N2',
    officialUrl: cleanString(setup.officialUrl, 500),
  }
}

function readStatement(body) {
  return cleanString(body?.statement, 24000)
}

function publicSession(session) {
  const normalized = normalizeSessionSnapshot(session)
  normalized.research = session?.research ?? null
  normalized.model = session?.model ?? null
  return normalized
}

function withLock(locks, key, task) {
  const previous = locks.get(key) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(task)
  const tail = run.catch(() => {}).then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  locks.set(key, tail)
  return run
}

export const name = 'interview-dojo'
export const inject = ['webServer', 'llm', 'web', 'connection']

export function apply(ctx) {
  const paths = dataPaths()
  const locks = new Map()
  let llmActive = 0
  let connectionAdmission = undefined
  let speechService = undefined

  ctx.inject(['speechToText'], (speechCtx) => {
    const speech = speechCtx.get('speechToText')
    if (speech === undefined) return () => {}
    speechService = speech
    return () => {
      if (speechService === speech) speechService = undefined
    }
  })

  // Use the same browser-authentication fence as the host's own API routes.
  // The route is still same-origin checked below; admission adds the signed
  // browser cookie requirement when the Web connection service is present.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection')
    if (typeof connection?.requestRejection !== 'function') return () => {}
    const check = (request) => connection.requestRejection(request)
    connectionAdmission = check
    return () => {
      if (connectionAdmission === check) connectionAdmission = undefined
    }
  })

  ensureDataDirs(paths).catch((error) => {
    ctx.logger?.warn?.(`[interview-dojo] 无法创建数据目录：${error instanceof Error ? error.message : String(error)}`)
  })

  const runLlm = async (selection, promptInput) => {
    if (llmActive >= 4) {
      throw new HttpError(429, 'too-many-requests', '同时进行的模型请求过多，请稍后再试')
    }
    llmActive += 1
    try {
      return await callJson({
        ctx,
        selection,
        ...promptInput,
      })
    } finally {
      llmActive -= 1
    }
  }

  async function handleResearch(body, signal) {
    const setup = readSetup(body)
    const statement = readStatement(body)
    const refresh = body?.refresh === true
    const selection = resolveSelection(ctx, body?.model)
    if (selection.provider === undefined) {
      throw new HttpError(400, 'model-required', '当前对话没有可用模型，请先在 DSH 中配置模型')
    }
    const key = researchCacheKey({ ...setup, statement, model: selection })
    if (!refresh) {
      const cached = await readResearchCache(paths, key)
      if (cached?.research) {
        return {
          research: cached.research,
          cached: true,
          model: cached.model ?? selection,
          diagnostics: cached.diagnostics ?? [],
          officialUrl: cached.officialUrl ?? '',
        }
      }
    }

    const diagnostics = []
    let collected
    try {
      collected = await collectUniversitySources({ ctx, setup, statement, signal, diagnostics })
    } catch (error) {
      throw new HttpError(502, 'research-fetch-failed', error instanceof Error ? error.message : String(error))
    }
    const allowedIds = collected.sources.map((source) => source.id)
    const prompt = buildResearchPrompt({ setup, statement, sources: collected.sources, searchNotes: collected.searchNotes })
    let generated
    try {
      generated = await runLlm(selection, {
        system: prompt.system,
        prompt: prompt.prompt,
        maxTokens: 6500,
        temperature: 0.55,
        timeoutMs: 150000,
        signal,
      })
    } catch (error) {
      throw new HttpError(502, 'research-generation-failed', error instanceof Error ? error.message : String(error))
    }
    const research = normalizeResearch(generated.data, collected.sources, setup)
    research.officialUrl = collected.officialUrl
    research.diagnostics = [...diagnostics, ...collected.diagnostics]
    research.searchNotes = collected.searchNotes
    research.disclosure = '题库由公开官网资料与常见面试题型经模型归纳生成，不是学校官方过去问；请以学校最新募集要项为准。'
    // Keep source IDs inside the allowed set even when the model invents one.
    for (const question of research.questions) {
      question.sourceIds = question.sourceIds.filter((id) => allowedIds.includes(id))
    }
    for (const point of research.uniquePoints) {
      point.sourceIds = point.sourceIds.filter((id) => allowedIds.includes(id))
    }

    const record = {
      research,
      model: selection,
      createdAt: new Date().toISOString(),
      diagnostics: research.diagnostics,
      officialUrl: collected.officialUrl,
    }
    await writeResearchCache(paths, key, record).catch(() => {})
    return { research, cached: false, model: selection, diagnostics: research.diagnostics, officialUrl: collected.officialUrl }
  }

  function voiceStatus() {
    if (speechService === undefined || typeof speechService.snapshot !== 'function') {
      return {
        available: false,
        reason: 'DSH 的本机语音识别服务未加载；浏览器语音识别仍可使用。',
        providers: [],
      }
    }
    try {
      const snapshot = speechService.snapshot()
      const providers = (snapshot?.providers ?? []).map((provider) => {
        const phase = provider?.preparation?.phase ?? 'ready'
        return {
          id: String(provider?.id ?? ''),
          name: String(provider?.name ?? provider?.id ?? ''),
          languages: Array.isArray(provider?.languages) ? provider.languages : [],
          location: String(provider?.location ?? ''),
          phase,
          ready: phase === 'ready' || phase === 'standby',
        }
      })
      const selectedId = snapshot?.selection?.providerId
      const ready = providers.find((provider) => provider.id === selectedId
        && provider.ready
        && provider.location === 'host-local'
        && provider.languages.includes('ja'))
        ?? providers.find((provider) => provider.ready && provider.location === 'host-local' && provider.languages.includes('ja'))
      return {
        available: ready !== undefined,
        provider: ready ?? null,
        providers,
        selection: snapshot?.selection ?? null,
      }
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        providers: [],
      }
    }
  }

  async function handleTts(body, signal) {
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '') throw new HttpError(400, 'text-required', '缺少要朗读的文本')
    if (text.length > 1200) throw new HttpError(413, 'text-too-long', '朗读文本过长')
    const voice = edgeVoiceIds().includes(body?.voice) ? body.voice : DEFAULT_EDGE_VOICE
    const rate = Number.isFinite(Number(body?.rate)) ? Math.max(-30, Math.min(20, Number(body.rate))) : -5
    if (!(await edgeTtsAvailable())) {
      throw new HttpError(503, 'tts-unavailable', '自然语音组件未安装，请切换到系统语音或安装可选依赖')
    }
    try {
      const result = await synthesizeEdge({
        text,
        voice,
        rate,
        audioDir: paths.ttsDir,
        signal,
      })
      return {
        audioBase64: result.audio.toString('base64'),
        mimeType: result.mimeType,
        duration: result.duration ?? 0,
        cached: result.cached,
        voice: result.voice,
        rate: result.rate,
      }
    } catch (error) {
      throw new HttpError(502, 'tts-failed', error instanceof Error ? error.message : String(error))
    }
  }

  async function handleArchive(body) {
    const markdown = typeof body?.markdown === 'string' ? body.markdown : ''
    const html = typeof body?.html === 'string' ? body.html : ''
    if (markdown.trim() === '' || html.trim() === '') {
      throw new HttpError(400, 'archive-empty', '存档内容为空')
    }
    if (markdown.length > 4 * 1024 * 1024 || html.length > 6 * 1024 * 1024) {
      throw new HttpError(413, 'archive-too-large', '存档内容过大')
    }
    const archive = await saveArchive(paths, {
      markdown,
      html,
      baseName: typeof body?.baseName === 'string' ? body.baseName : 'interview-dojo',
    })
    return { archive }
  }

  async function handleDeleteSession(id) {
    const removed = await deleteSession(paths, id)
    return { removed }
  }

  async function handleTranscribe(body, signal) {
    if (speechService === undefined || typeof speechService.transcribe !== 'function') {
      throw new HttpError(503, 'speech-unavailable', '本机语音识别服务未加载，请改用浏览器语音识别或文字输入')
    }
    const base64 = typeof body?.audioBase64 === 'string' ? body.audioBase64.trim() : ''
    if (base64 === '' || base64.length > 6 * 1024 * 1024) {
      throw new HttpError(400, 'audio-required', '缺少录音数据或录音过长')
    }
    let buffer
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      throw new HttpError(400, 'invalid-audio', '录音编码无效')
    }
    if (buffer.length === 0) throw new HttpError(400, 'invalid-audio', '录音为空')
    if (buffer.length > 4 * 1024 * 1024) {
      throw new HttpError(413, 'audio-too-large', '录音超过 4MB，请缩短回答')
    }
    const status = voiceStatus()
    const selected = status.provider
    if (!status.available || !selected) {
      throw new HttpError(409, 'speech-not-ready', '本机日语识别模型尚未就绪，请先在 DSH 的语音输入设置中完成准备')
    }
    let spec
    try {
      spec = speechService.resolve({
        audio: new Uint8Array(buffer),
        providerId: selected.id,
        language: 'ja',
      })
    } catch (error) {
      throw new HttpError(422, 'speech-invalid', error instanceof Error ? error.message : String(error))
    }
    const combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
      : AbortSignal.timeout(90000)
    try {
      const transcript = await speechService.transcribe(spec, combined)
      return {
        text: typeof transcript?.text === 'string' ? transcript.text : '',
        audioSeconds: Number(transcript?.audioSeconds) || 0,
        inferenceSeconds: Number(transcript?.inferenceSeconds) || 0,
        provider: spec.provider?.info?.id ?? selected.id,
      }
    } catch (error) {
      throw new HttpError(502, 'transcription-failed', error instanceof Error ? error.message : String(error))
    }
  }

  async function handleStatement(body) {
    const filename = cleanString(body?.filename, 200) || '入学理由书'
    let buffer
    if (typeof body?.text === 'string') {
      const text = body.text.slice(0, 24000)
      return { text, filename, kind: 'text', warnings: [], chars: text.length }
    }
    if (typeof body?.base64 !== 'string' || body.base64.trim() === '') {
      throw new HttpError(400, 'file-required', '请选择理由书文件，或直接粘贴正文')
    }
    const base64 = body.base64.replace(/^data:[^;]+;base64,/, '')
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      throw new HttpError(400, 'invalid-base64', '文件编码无效')
    }
    if (buffer.length === 0) throw new HttpError(400, 'file-empty', '文件为空')
    if (buffer.length > STATEMENT_MAX_BYTES) {
      throw new HttpError(413, 'file-too-large', `文件超过 ${Math.round(STATEMENT_MAX_BYTES / 1024 / 1024)}MB 上限`)
    }
    try {
      const extracted = extractDocument({ filename, buffer })
      return { ...extracted, filename }
    } catch (error) {
      throw new HttpError(422, 'extract-failed', error instanceof Error ? error.message : String(error))
    }
  }

  async function handleStart(body, signal) {
    const setup = readSetup(body)
    const statement = readStatement(body)
    const incoming = body?.research
    if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.questions) || incoming.questions.length === 0) {
      throw new HttpError(400, 'research-required', '请先生成面试资料与题库')
    }
    const incomingSources = (Array.isArray(incoming.sources) ? incoming.sources : [])
      .slice(0, 20)
      .map((source, index) => {
        let url = typeof source?.url === 'string' ? source.url.slice(0, 1000) : ''
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') url = ''
        } catch {
          url = ''
        }
        if (url === '') return null
        return {
          id: String(source.id ?? `S${index + 1}`).slice(0, 20),
          title: String(source.title ?? '').slice(0, 300),
          url,
          chars: Math.max(0, Math.min(100000, Number(source.chars) || 0)),
        }
      })
      .filter(Boolean)
    const research = normalizeResearch(incoming, incomingSources, setup)
    if (research.questions.length === 0) {
      throw new HttpError(400, 'research-required', '题库为空，请重新生成面试资料')
    }
    research.officialUrl = cleanString(incoming.officialUrl, 500)
    research.disclosure = cleanString(incoming.disclosure, 500) || '题库由公开官网资料与常见面试题型经模型归纳生成，不是学校官方过去问；请以学校最新募集要项为准。'
    research.searchNotes = cleanString(incoming.searchNotes, 2000)
    research.diagnostics = asStringArray(incoming.diagnostics).slice(0, 8)
    const selection = resolveSelection(ctx, body?.model)
    if (selection.provider === undefined) {
      throw new HttpError(400, 'model-required', '当前对话没有可用模型，请先在 DSH 中配置模型')
    }
    const prompt = buildOpeningPrompt({ setup, statement, research })
    let generated
    try {
      generated = await runLlm(selection, {
        system: prompt.system,
        prompt: prompt.prompt,
        maxTokens: 5000,
        temperature: 0.65,
        timeoutMs: 120000,
        signal,
      })
    } catch (error) {
      throw new HttpError(502, 'opening-failed', error instanceof Error ? error.message : String(error))
    }
    const opening = normalizeOpening(generated.data)
    if (!opening.question.jp || opening.question.jp.includes('生成に失敗')) {
      throw new HttpError(502, 'opening-failed', '模型没有生成有效的第一题，请重试')
    }
    const session = createSessionRecord({
      setup,
      statement,
      statementFilename: cleanString(body?.statementFilename, 200),
      statementKind: cleanString(body?.statementKind, 30),
      statementWarnings: Array.isArray(body?.statementWarnings) ? body.statementWarnings.slice(0, 6) : [],
      research,
      model: selection,
      opening,
      turns: [
        {
          n: 1,
          question: opening.question,
          analysis: opening.analysis,
          reactionJp: '',
          reactionZh: '',
          answer: '',
          answeredAt: '',
          evaluation: null,
        },
      ],
    })
    await saveSession(paths, session)
    await pruneSessions(paths)
    return { session: publicSession(session) }
  }

  async function handleAnswer(body, signal) {
    const id = cleanString(body?.sessionId, 64)
    const answer = cleanString(body?.answer, ANSWER_MAX)
    if (id === '') throw new HttpError(400, 'session-required', '缺少会话 ID')
    if (answer === '') throw new HttpError(400, 'answer-required', '请先输入或说出你的回答')
    return withLock(locks, id, async () => {
      const session = await readSession(paths, id)
      if (session === undefined) throw new HttpError(404, 'session-not-found', '找不到这次面试记录，请新建面试')
      if (session.status === 'finished') throw new HttpError(409, 'session-finished', '这次面试已经结束，请新建面试')
      if (!Array.isArray(session.turns) || session.turns.length === 0) {
        throw new HttpError(500, 'session-invalid', '会话记录不完整')
      }
      if (session.turns.length >= MAX_TURNS) {
        throw new HttpError(409, 'session-too-long', '已达到本次面试的题数上限，请结束并查看报告')
      }
      const currentTurnN = session.turns[session.turns.length - 1]?.n
      const requestedTurnN = Number.isInteger(body?.turnN) ? body.turnN : undefined
      if (requestedTurnN !== undefined && requestedTurnN !== currentTurnN) {
        throw new HttpError(409, 'stale-turn', '这道题已经更新了，请刷新页面后再回答')
      }
      const selection = resolveSelection(ctx, session.model)
      if (selection.provider === undefined) throw new HttpError(400, 'model-required', '当前对话没有可用模型')
      const prompt = buildTurnPrompt({
        setup: session.setup,
        statement: session.statement,
        research: session.research,
        session,
        answer,
      })
      let generated
      try {
        generated = await runLlm(selection, {
          system: prompt.system,
          prompt: prompt.prompt,
          maxTokens: 5200,
          temperature: 0.65,
          timeoutMs: 120000,
          signal,
        })
      } catch (error) {
        throw new HttpError(502, 'turn-failed', error instanceof Error ? error.message : String(error))
      }
      const turn = normalizeTurn(generated.data)
      if (!turn.nextQuestion.jp || turn.nextQuestion.jp.includes('生成に失敗')) {
        throw new HttpError(502, 'turn-failed', '模型没有生成有效的下一题，请重试')
      }
      const latest = session.turns[session.turns.length - 1]
      latest.answer = answer
      latest.answeredAt = new Date().toISOString()
      latest.evaluation = turn.evaluation
      session.turns.push({
        n: session.turns.length + 1,
        question: turn.nextQuestion,
        analysis: turn.analysis,
        reactionJp: turn.reactionJp,
        reactionZh: turn.reactionZh,
        answer: '',
        answeredAt: '',
        evaluation: null,
      })
      session.model = selection
      await saveSession(paths, session)
      return { session: publicSession(session) }
    })
  }

  async function handleHint(body, signal) {
    const id = cleanString(body?.sessionId, 64)
    if (id === '') throw new HttpError(400, 'session-required', '缺少会话 ID')
    return withLock(locks, id, async () => {
      const session = await readSession(paths, id)
      if (session === undefined) throw new HttpError(404, 'session-not-found', '找不到这次面试记录')
      const selection = resolveSelection(ctx, session.model)
      if (selection.provider === undefined) throw new HttpError(400, 'model-required', '当前对话没有可用模型')
      const prompt = buildHintPrompt({ setup: session.setup, session })
      let generated
      try {
        generated = await runLlm(selection, {
          system: prompt.system,
          prompt: prompt.prompt,
          maxTokens: 1600,
          temperature: 0.6,
          timeoutMs: 90000,
          signal,
        })
      } catch (error) {
        throw new HttpError(502, 'hint-failed', error instanceof Error ? error.message : String(error))
      }
      return { hint: normalizeHint(generated.data) }
    })
  }

  async function handleFinish(body, signal) {
    const id = cleanString(body?.sessionId, 64)
    if (id === '') throw new HttpError(400, 'session-required', '缺少会话 ID')
    return withLock(locks, id, async () => {
      const session = await readSession(paths, id)
      if (session === undefined) throw new HttpError(404, 'session-not-found', '找不到这次面试记录')
      if (session.status === 'finished' && session.finalReport) {
        return { session: publicSession(session) }
      }
      const answered = Array.isArray(session.turns) ? session.turns.filter((turn) => turn.answer) : []
      if (answered.length === 0) {
        throw new HttpError(400, 'no-answers', '至少回答一题后再生成面试报告')
      }
      const selection = resolveSelection(ctx, session.model)
      if (selection.provider === undefined) throw new HttpError(400, 'model-required', '当前对话没有可用模型')
      const reportSession = {
        ...session,
        turns: session.turns.filter((turn) => Boolean(turn.answer)),
      }
      const prompt = buildReportPrompt({ setup: session.setup, session: reportSession })
      let generated
      try {
        generated = await runLlm(selection, {
          system: prompt.system,
          prompt: prompt.prompt,
          maxTokens: 4000,
          temperature: 0.55,
          timeoutMs: 120000,
          signal,
        })
      } catch (error) {
        throw new HttpError(502, 'report-failed', error instanceof Error ? error.message : String(error))
      }
      session.finalReport = normalizeReport(generated.data)
      session.status = 'finished'
      await saveSession(paths, session)
      return { session: publicSession(session) }
    })
  }

  async function route(req, res, signal) {
    if (typeof connectionAdmission !== 'function') {
      fail(res, 503, 'auth-unavailable', '认证服务尚未就绪，请稍后刷新页面')
      return
    }
    const rejection = connectionAdmission(req)
    if (rejection !== undefined) {
      fail(res, rejection === 403 ? 403 : 401, 'unauthorized', '请通过已登录的 DSH 页面打开面试道场')
      return
    }
    if (!sameOrigin(req)) {
      fail(res, 403, 'origin-rejected', '只接受来自 DSH 页面同源的请求')
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (!url.pathname.startsWith(PREFIX)) {
      fail(res, 404, 'not-found', 'not found')
      return
    }
    const relative = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')
    const segments = relative.split('/').filter(Boolean)
    const isGet = req.method === 'GET'
    const isPost = req.method === 'POST'
    const isDelete = req.method === 'DELETE'
    let body = {}

    if (isPost) {
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        fail(res, 415, 'json-required', '请求必须使用 application/json')
        return
      }
      body = await readJsonBody(req)
    }

    if (isGet && (relative === '' || relative === 'health')) {
      const catalog = await listModelCatalog(ctx, undefined).catch(() => ({ providers: [], current: undefined }))
      ok(res, {
        version: '0.1.0',
        llm: {
          available: typeof ctx.llm?.stream === 'function',
          current: catalog.current ?? currentSelection(ctx),
          providers: catalog.providers ?? [],
        },
        web: {
          search: typeof ctx.web?.search === 'function',
          fetch: typeof ctx.web?.fetch === 'function',
        },
        statement: {
          maxBytes: STATEMENT_MAX_BYTES,
          maxChars: 24000,
          formats: ['txt', 'md', 'docx', 'pdf'],
        },
        voice: {
          mode: 'browser',
          local: voiceStatus(),
          tts: {
            edge: await edgeTtsAvailable(),
            voices: EDGE_VOICES,
            defaultVoice: DEFAULT_EDGE_VOICE,
          },
          note: '语音识别优先使用浏览器实时识别，也可切换到本机 SenseVoice。朗读优先使用 Edge 神经语音，失败时回退系统语音。',
        },
      })
      return
    }

    if (isGet && relative === 'models') {
      const catalog = await listModelCatalog(ctx, undefined)
      ok(res, catalog)
      return
    }

    if (isGet && relative === 'voice/status') {
      ok(res, { voice: voiceStatus() })
      return
    }

    if (isGet && relative === 'session/latest') {
      const session = await latestSession(paths)
      ok(res, { session: session ? publicSession(session) : null })
      return
    }

    if (isGet && segments.length === 2 && segments[0] === 'session') {
      const session = await readSession(paths, segments[1])
      if (session === undefined) {
        fail(res, 404, 'session-not-found', '找不到这次面试记录')
        return
      }
      ok(res, { session: publicSession(session) })
      return
    }

    if (isPost && relative === 'archive') {
      ok(res, await handleArchive(body))
      return
    }

    if (isDelete && segments.length === 2 && segments[0] === 'session') {
      ok(res, await handleDeleteSession(segments[1]))
      return
    }

    if (isPost && relative === 'tts') {
      ok(res, await handleTts(body, signal))
      return
    }

    if (isPost && relative === 'transcribe') {
      ok(res, await handleTranscribe(body, signal))
      return
    }

    if (isPost && relative === 'statement') {
      ok(res, await handleStatement(body))
      return
    }

    if (isPost && relative === 'research') {
      ok(res, await handleResearch(body, signal))
      return
    }

    if (isPost && relative === 'session/start') {
      ok(res, await handleStart(body, signal))
      return
    }

    if (isPost && relative === 'session/answer') {
      ok(res, await handleAnswer(body, signal))
      return
    }

    if (isPost && relative === 'session/hint') {
      ok(res, await handleHint(body, signal))
      return
    }

    if (isPost && relative === 'session/finish') {
      ok(res, await handleFinish(body, signal))
      return
    }

    fail(res, 404, 'not-found', '接口不存在')
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const controller = new AbortController()
      const onClose = () => {
        if (!res.writableEnded) controller.abort()
      }
      res.on?.('close', onClose)
      try {
        await route(req, res, controller.signal)
      } catch (error) {
        if (res.writableEnded) return
        if (error instanceof HttpError) {
          fail(res, error.status, error.code, error.message)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[interview-dojo] ${message}`)
        if (res.destroyed) return
        fail(res, 500, 'internal-error', '内部错误，请稍后重试')
      } finally {
        res.off?.('close', onClose)
      }
    },
  }), 'dsh-interview-dojo: HTTP route')

  ctx.logger?.info?.(`[interview-dojo] 面试道场已就绪，数据目录：${paths.baseDir}`)
}
