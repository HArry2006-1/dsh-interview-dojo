import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'
import { createSessionRecord, saveSession, dataPaths, ensureDataDirs, readSession } from '../lib/store.js'

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.statusCode = status
      this.headers = headers
    },
    end(text = '') {
      this.body = text
      this.writableEnded = true
    },
  }
}

function makeRequest({ method = 'GET', url = '/dsh-interview-dojo/health', headers = {}, body } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:63306', ...headers }
  return stream
}

function makeContext(routeBox, speechService, llmResponses = []) {
  const connection = {
    requestRejection: () => undefined,
  }
  let llmIndex = 0
  return {
    effect(callback) {
      const disposer = callback()
      return disposer
    },
    inject(services, callback) {
      if (!Array.isArray(services)) return () => {}
      if (services.includes('speechToText') && speechService) {
        callback({
          get(name) {
            return name === 'speechToText' ? speechService : undefined
          },
        })
      }
      if (services.includes('connection')) {
        callback({
          get(name) {
            return name === 'connection' ? connection : undefined
          },
        })
      }
      return () => {}
    },
    webServer: {
      register(route) {
        routeBox.route = route
        return () => {}
      },
    },
    llm: {
      stream: async function* stream() {
        const text = llmResponses[Math.min(llmIndex, llmResponses.length - 1)]
        llmIndex += 1
        if (typeof text === 'string') {
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      },
      listProviders: () => [{ id: 'test-provider', name: 'Test Provider' }],
      listModels: async () => [{ id: 'test-model', name: 'Test Model' }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    },
    web: {
      search: async () => ({ sources: [], truncated: false }),
      fetch: async () => ({ statusCode: 404, url: 'https://example.ac.jp/', body: { kind: 'html', content: '' } }),
    },
    logger: { info() {}, warn(message) { console.error('[host-test]', message) } },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      return undefined
    },
  }
}

test('host registers a working health route and statement extraction', async (t) => {
  const home = join(tmpdir(), `dsh-interview-dojo-test-${process.pid}-${Date.now()}`)
  process.env.DSH_HOME = home
  const routeBox = {}
  const ctx = makeContext(routeBox)
  apply(ctx)
  t.after(async () => {
    delete process.env.DSH_HOME
    try {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a transient handle open on the temp directory.
    }
  })

  assert.ok(routeBox.route, 'route registered')
  assert.equal(routeBox.route.kind, 'prefix')
  assert.equal(routeBox.route.path, '/dsh-interview-dojo')

  const healthRes = makeResponse()
  await routeBox.route.handler(makeRequest(), healthRes)
  const health = JSON.parse(healthRes.body)
  assert.equal(healthRes.statusCode, 200)
  assert.equal(health.ok, true)
  assert.equal(health.llm.current.provider, 'test-provider')
  assert.equal(health.llm.current.model, 'test-model')
  assert.equal(health.llm.providers[0].models[0].id, 'test-model')
  assert.equal(health.web.search, true)
  assert.equal(health.web.fetch, true)

  const modelsRes = makeResponse()
  await routeBox.route.handler(makeRequest({ url: '/dsh-interview-dojo/models' }), modelsRes)
  const models = JSON.parse(modelsRes.body)
  assert.equal(models.ok, true)
  assert.equal(models.current.model, 'test-model')

  const text = '私の志望理由は、貴学の少人数教育で学びたいからです。'
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  const statementRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/statement',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: { filename: '理由書.txt', base64 },
  }), statementRes)
  const statement = JSON.parse(statementRes.body)
  assert.equal(statementRes.statusCode, 200)
  assert.equal(statement.ok, true)
  assert.equal(statement.text, text)
  assert.equal(statement.chars, text.length)
})

test('creates a session record with a valid persisted id', async (t) => {
  const home = join(tmpdir(), `dsh-interview-dojo-test-${process.pid}-${Date.now()}-session`)
  process.env.DSH_HOME = home
  const paths = dataPaths()
  await ensureDataDirs(paths)
  const session = createSessionRecord({ statement: 'test' })
  assert.match(session.id, /^[0-9a-f-]{36}$/i)
  await saveSession(paths, session)
  t.after(async () => {
    delete process.env.DSH_HOME
    try {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a transient handle open on the temp directory.
    }
  })
})

test('host archives a practice document and deletes the current session', async (t) => {
  const home = join(tmpdir(), `dsh-interview-dojo-test-${process.pid}-${Date.now()}-archive`)
  process.env.DSH_HOME = home
  const paths = dataPaths()
  await ensureDataDirs(paths)
  const session = createSessionRecord({ setup: { university: '例大学' }, turns: [] })
  await saveSession(paths, session)
  const routeBox = {}
  apply(makeContext(routeBox))
  t.after(async () => {
    delete process.env.DSH_HOME
    try {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a transient handle open on the temp directory.
    }
  })

  const archiveRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/archive',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: {
      sessionId: session.id,
      baseName: '例大学-経済学科',
      markdown: '# 存档\n\n- 目标大学：例大学\n',
      html: '<!doctype html><html><body><h1>存档</h1></body></html>',
    },
  }), archiveRes)
  const archived = JSON.parse(archiveRes.body)
  assert.equal(archiveRes.statusCode, 200)
  assert.equal(archived.ok, true)
  assert.match(archived.archive.doc, /\.doc$/)
  const savedHtml = await fs.readFile(join(paths.archivesDir, archived.archive.doc), 'utf8')
  assert.match(savedHtml, /<h1>存档<\/h1>/)

  const deleteRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'DELETE',
    url: `/dsh-interview-dojo/session/${session.id}`,
    headers: { origin: 'http://127.0.0.1:63306' },
  }), deleteRes)
  const deleted = JSON.parse(deleteRes.body)
  assert.equal(deleteRes.statusCode, 200)
  assert.equal(deleted.removed, true)
  assert.equal(await readSession(paths, session.id), undefined)
})

test('host exposes local speech readiness and transcription', async (t) => {
  const home = join(tmpdir(), `dsh-interview-dojo-test-${process.pid}-${Date.now()}-speech`)
  process.env.DSH_HOME = home
  const calls = []
  const speechService = {
    snapshot: () => ({
      providers: [{
        id: 'sensevoice-local',
        name: 'SenseVoiceSmall (INT8)',
        location: 'host-local',
        languages: ['auto', 'zh', 'ja'],
        preparation: { phase: 'ready' },
      }],
      selection: { providerId: 'sensevoice-local', language: 'ja' },
    }),
    resolve: (request) => {
      calls.push(['resolve', request.language, request.audio.length])
      return {
        provider: { info: { id: 'sensevoice-local' } },
        audio: request.audio,
        language: request.language,
      }
    },
    transcribe: async (spec) => {
      calls.push(['transcribe', spec.language, spec.audio.length])
      return { text: 'こんにちは、面接を始めます。', audioSeconds: 1.2, inferenceSeconds: 0.3 }
    },
  }
  const routeBox = {}
  apply(makeContext(routeBox, speechService))
  t.after(async () => {
    delete process.env.DSH_HOME
    try {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a transient handle open on the temp directory.
    }
  })

  const statusRes = makeResponse()
  await routeBox.route.handler(makeRequest({ url: '/dsh-interview-dojo/voice/status' }), statusRes)
  const status = JSON.parse(statusRes.body)
  assert.equal(statusRes.statusCode, 200)
  assert.equal(status.voice.available, true)
  assert.equal(status.voice.provider.id, 'sensevoice-local')

  const audio = Buffer.from('fake-wave-bytes')
  const transcribeRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/transcribe',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: { audioBase64: audio.toString('base64') },
  }), transcribeRes)
  const transcribed = JSON.parse(transcribeRes.body)
  assert.equal(transcribeRes.statusCode, 200)
  assert.equal(transcribed.text, 'こんにちは、面接を始めます。')
  assert.equal(transcribed.provider, 'sensevoice-local')
  assert.equal(calls[0][1], 'ja')
  assert.equal(calls[1][0], 'transcribe')
})

test('host runs research-backed session start, answer, and report with the public LLM stream', async (t) => {
  const home = join(tmpdir(), `dsh-interview-dojo-test-${process.pid}-${Date.now()}-flow`)
  process.env.DSH_HOME = home
  const opening = JSON.stringify({
    openingJp: 'こんにちは。面接を始めます。',
    openingZh: '你好。面试开始。',
    question: {
      id: 'q1',
      category: '自己紹介',
      phase: '導入',
      difficulty: 1,
      schoolSpecific: false,
      jp: 'まず、自己紹介をお願いします。',
      zh: '首先请做自我介绍。',
      intentZh: '确认基本信息。',
      sourceIds: [],
    },
    analysis: {
      intentZh: '看表达是否清楚。',
      vocabulary: [{ word: '自己紹介', reading: 'じこしょうかい', meaningZh: '自我介绍', level: 'N4', exampleJp: '自己紹介を始めます。' }],
      modelAnswerJp: 'はい、〇〇と申します。よろしくお願いいたします。',
      modelAnswerZh: '好的，我叫〇〇。请多关照。',
    },
  })
  const turn = JSON.stringify({
    evaluation: {
      score: 78,
      verdictZh: '内容不错，但基本信息不足。',
      reactionJp: 'ありがとうございます。志望理由が明確ですね。',
      reactionZh: '谢谢。志愿理由很明确。',
      strengthsZh: ['志望理由明确'],
      improvementsZh: ['补充姓名和学校'],
      correctedJp: 'はい、〇〇と申します。',
    },
    nextQuestion: {
      id: 'q2',
      category: '学部学习',
      phase: '学部理解',
      difficulty: 2,
      schoolSpecific: true,
      jp: 'なぜこの学部を選びましたか。',
      zh: '为什么选择这个学部？',
      intentZh: '确认学部理解。',
      sourceIds: ['S1'],
    },
    analysis: {
      intentZh: '确认志望理由与学部的关联。',
      vocabulary: [{ word: '学部', reading: 'がくぶ', meaningZh: '学部', level: 'N4' }],
      modelAnswerJp: '少人数教育に魅力を感じたからです。',
      modelAnswerZh: '因为被少人数教育吸引。',
    },
    phase: '学部理解',
  })
  const report = JSON.stringify({
    overallScore: 76,
    summaryZh: '整体表现稳定，基本信息仍需补足。',
    strengthsZh: ['志望理由清楚'],
    improvementsZh: ['自我介绍结构'],
    universityFitZh: '方向匹配。',
    languageNotesZh: ['句子可以更短。'],
    nextStepsZh: ['练习一分钟自我介绍'],
    keyVocabulary: [{ word: '志望理由', reading: 'しぼうりゆう', meaningZh: '志愿理由' }],
  })
  const routeBox = {}
  apply(makeContext(routeBox, undefined, [opening, turn, report]))
  t.after(async () => {
    delete process.env.DSH_HOME
    try {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a transient handle open on the temp directory.
    }
  })

  const research = {
    universityNameJa: '例大学',
    universityNameZh: '例大学',
    overviewZh: '一所示例大学。',
    questions: [
      { id: 'q1', category: '自己紹介', jp: '自己紹介をお願いします。', zh: '请做自我介绍。', schoolSpecific: false },
      { id: 'q2', category: '学部学习', jp: 'なぜこの学部ですか。', zh: '为什么选择这个学部？', schoolSpecific: true, sourceIds: ['S1'] },
    ],
    sources: [{ id: 'S1', title: '入試情報', url: 'https://example.ac.jp/admission', chars: 120 }],
  }
  const setup = {
    university: '例大学',
    faculty: '例学部',
    major: '経済学科',
    program: '学部（本科）',
    format: '个人面试',
    jlpt: 'N2',
    officialUrl: 'https://example.ac.jp/',
  }
  const startedRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/session/start',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: {
      setup,
      statement: '貴学で学びたいです。',
      research,
      model: { provider: 'test-provider', model: 'test-model' },
    },
  }), startedRes)
  const started = JSON.parse(startedRes.body)
  assert.equal(startedRes.statusCode, 200, startedRes.body)
  assert.equal(started.ok, true)
  assert.match(started.session.id, /^[0-9a-f-]{36}$/i)
  assert.equal(started.session.turns.length, 1)
  assert.equal(started.session.turns[0].question.jp, 'まず、自己紹介をお願いします。')
  assert.equal(started.session.research.sources[0].id, 'S1')
  assert.equal(started.session.setup.major, '経済学科')

  const answeredRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/session/answer',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: {
      sessionId: started.session.id,
      turnN: 1,
      answer: 'はい、〇〇と申します。',
    },
  }), answeredRes)
  const answered = JSON.parse(answeredRes.body)
  assert.equal(answeredRes.statusCode, 200)
  assert.equal(answered.session.turns.length, 2)
  assert.equal(answered.session.turns[0].evaluation.score, 78)
  assert.equal(answered.session.turns[1].reactionJp, 'ありがとうございます。志望理由が明確ですね。')
  assert.equal(answered.session.turns[1].question.jp, 'なぜこの学部を選びましたか。')

  const staleRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/session/answer',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: { sessionId: started.session.id, turnN: 99, answer: '古い回答' },
  }), staleRes)
  assert.equal(staleRes.statusCode, 409)
  assert.equal(JSON.parse(staleRes.body).error.code, 'stale-turn')

  const reportRes = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/session/finish',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:63306' },
    body: { sessionId: started.session.id },
  }), reportRes)
  const finished = JSON.parse(reportRes.body)
  assert.equal(reportRes.statusCode, 200)
  assert.equal(finished.session.status, 'finished')
  assert.equal(finished.session.finalReport.overallScore, 76)
})

test('host rejects cross-origin requests and unknown routes', async (t) => {
  const home = join(tmpdir(), `dsh-interview-dojo-test-${process.pid}-${Date.now()}-b`)
  process.env.DSH_HOME = home
  const routeBox = {}
  apply(makeContext(routeBox))
  t.after(async () => {
    delete process.env.DSH_HOME
    try {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Windows may keep a transient handle open on the temp directory.
    }
  })

  const rejected = makeResponse()
  await routeBox.route.handler(makeRequest({
    method: 'POST',
    url: '/dsh-interview-dojo/statement',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: { text: 'x' },
  }), rejected)
  assert.equal(rejected.statusCode, 403)
  assert.equal(JSON.parse(rejected.body).error.code, 'origin-rejected')

  const missing = makeResponse()
  await routeBox.route.handler(makeRequest({ url: '/dsh-interview-dojo/nope' }), missing)
  assert.equal(missing.statusCode, 404)

  const latest = makeResponse()
  await routeBox.route.handler(makeRequest({ url: '/dsh-interview-dojo/session/latest' }), latest)
  const payload = JSON.parse(latest.body)
  assert.equal(latest.statusCode, 200)
  assert.equal(payload.session, null)
})
