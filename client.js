window.__ModuleLoader__.load({
  id: 'dsh-interview-dojo',
  factory(require) {
    const React = require('react')
    const {
      useCallback,
      useEffect,
      useMemo,
      useRef,
      useState,
    } = React
    const h = React.createElement

    // ------------------------------------------------------------------
    // Constants and small helpers
    // ------------------------------------------------------------------

    const ROUTE_SEGMENT = '/dsh-interview-dojo'
    const PANEL_ID = 'dsh-interview-dojo/panel'
    const PANEL_KIND = 'interview-dojo'
    const STORAGE = {
      setup: 'dsh-interview-dojo.setup.v1',
      statement: 'dsh-interview-dojo.statement.v1',
      session: 'dsh-interview-dojo.session.v1',
      model: 'dsh-interview-dojo.model.v1',
      voice: 'dsh-interview-dojo.voice.v1',
      display: 'dsh-interview-dojo.display.v1',
    }
    const DEFAULT_SETUP = {
      university: '',
      faculty: '',
      major: '',
      program: '学部（本科）',
      format: '个人面试',
      jlpt: 'N2',
      officialUrl: '',
    }
    const EMPTY_STATEMENT = {
      text: '',
      filename: '',
      kind: '',
      warnings: [],
      chars: 0,
    }

    function routePrefixOf(baseURI) {
      if (baseURI === undefined || baseURI === '') return ''
      try {
        const url = new URL(baseURI)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
        return url.pathname.replace(/\/+$/, '')
      } catch {
        return ''
      }
    }

    const ROUTE = `${routePrefixOf(typeof document === 'undefined' ? undefined : document.baseURI)}${ROUTE_SEGMENT}`
    let runtimeContext = null

    function readSaved(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key)
        if (raw === null) return fallback
        return JSON.parse(raw)
      } catch {
        return fallback
      }
    }

    function writeSaved(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Private-mode storage failures must not break the interview.
      }
    }

    function asText(value) {
      return typeof value === 'string' ? value : ''
    }

    function errorText(error) {
      if (error instanceof Error && error.message) return error.message
      return String(error)
    }

    async function api(path, options = {}) {
      const timeoutMs = options.timeoutMs ?? 45000
      const controller = new AbortController()
      const timer = window.setTimeout(() => controller.abort(), timeoutMs)
      const init = {
        method: options.method ?? 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {},
        signal: controller.signal,
      }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      try {
        const response = await fetch(`${ROUTE}${path}`, init)
        let payload
        try {
          payload = await response.json()
        } catch {
          payload = {}
        }
        if (!response.ok || payload?.ok === false) {
          const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`)
          error.code = payload?.error?.code
          throw error
        }
        return payload
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error('请求超时，请稍后重试；若正在生成面试资料，可先检查网络。')
        }
        throw error
      } finally {
        window.clearTimeout(timer)
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const comma = result.indexOf(',')
          resolve(comma >= 0 ? result.slice(comma + 1) : result)
        }
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    function encodeWavPcm16(samples, sampleRate = 16000) {
      const dataLength = samples.length * 2
      const buffer = new ArrayBuffer(44 + dataLength)
      const view = new DataView(buffer)
      const writeString = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) {
          view.setUint8(offset + index, text.charCodeAt(index))
        }
      }
      writeString(0, 'RIFF')
      view.setUint32(4, 36 + dataLength, true)
      writeString(8, 'WAVE')
      writeString(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeString(36, 'data')
      view.setUint32(40, dataLength, true)
      let offset = 44
      for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, Number(samples[index]) || 0))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Uint8Array(buffer)
    }

    function bytesToBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
      }
      return window.btoa(binary)
    }

    function base64ToBytes(encoded) {
      const binary = window.atob(encoded)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      return bytes
    }

    async function audioBlobToWav(blob) {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext
      const OfflineContextCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext
      if (typeof AudioContextCtor !== 'function' || typeof OfflineContextCtor !== 'function') {
        throw new Error('当前浏览器不支持音频转码，无法使用本机识别；请改用浏览器实时识别或文字输入。')
      }
      const arrayBuffer = await blob.arrayBuffer()
      const audioContext = new AudioContextCtor()
      let decoded
      try {
        decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0))
      } finally {
        try { await audioContext.close?.() } catch { /* ignore */ }
      }
      if (!decoded || !Number.isFinite(decoded.duration) || decoded.duration <= 0) {
        throw new Error('无法解析录音，请重新录制')
      }
      const seconds = Math.min(decoded.duration, 90)
      const frames = Math.max(1, Math.ceil(seconds * 16000))
      const offline = new OfflineContextCtor(1, frames, 16000)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start(0)
      const rendered = await offline.startRendering()
      return encodeWavPcm16(rendered.getChannelData(0), 16000)
    }

    function preferredRecordingMime() {
      if (typeof window.MediaRecorder === 'undefined') return ''
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      return candidates.find((mime) => window.MediaRecorder.isTypeSupported?.(mime)) ?? ''
    }

    function escapeRegExp(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    function safeHost(url) {
      try {
        return new URL(url).hostname
      } catch {
        return ''
      }
    }

    function safeHttpUrl(url) {
      try {
        const parsed = new URL(url)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined
      } catch {
        return undefined
      }
    }

    function formatClock(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }

    function speechRecognitionCtor() {
      if (typeof window === 'undefined') return undefined
      return window.SpeechRecognition || window.webkitSpeechRecognition
    }

    function canSpeakJapanese() {
      return typeof window !== 'undefined'
        && window.speechSynthesis !== null
        && typeof window.speechSynthesis !== 'undefined'
        && typeof window.speechSynthesis.getVoices === 'function'
        && typeof window.SpeechSynthesisUtterance === 'function'
    }

    function questionSpeech(session, turn) {
      if (!turn) return ''
      const parts = []
      if (turn.n === 1 && session?.opening?.openingJp) parts.push(session.opening.openingJp)
      if (turn.reactionJp) parts.push(turn.reactionJp)
      if (turn.question?.jp) parts.push(turn.question.jp)
      return parts.join('\n')
    }

    function archiveBaseName(session) {
      const setup = session?.setup ?? {}
      const date = new Date(session?.createdAt || Date.now())
      const pad = (value) => String(value).padStart(2, '0')
      const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
      const parts = ['面试道场', stamp, asText(setup.university), asText(setup.major) || asText(setup.faculty)]
        .filter((part) => part !== '')
      return parts.join('-').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 88)
    }

    function archiveSourceText(source) {
      if (!source) return ''
      const label = source.title || source.url || '来源'
      return source.url && source.title && source.title !== source.url
        ? `[${source.id}] ${label} — ${source.url}`
        : `[${source.id}] ${source.url || label}`
    }

    function escapeArchiveHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character]))
    }

    function archiveMarkdownToHtml(markdown) {
      const lines = String(markdown ?? '').split(/\r?\n/)
      const output = []
      let listKind = ''
      const closeList = () => {
        if (listKind !== '') {
          output.push(`</${listKind}>`)
          listKind = ''
        }
      }
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line === '') {
          closeList()
          continue
        }
        if (line === '---') {
          closeList()
          output.push('<hr>')
          continue
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) {
          closeList()
          const level = heading[1].length
          output.push(`<h${level}>${escapeArchiveHtml(heading[2])}</h${level}>`)
          continue
        }
        if (line.startsWith('&gt; ')) {
          closeList()
          output.push(`<blockquote>${escapeArchiveHtml(line.slice(4))}</blockquote>`)
          continue
        }
        if (line.startsWith('> ')) {
          closeList()
          output.push(`<blockquote>${escapeArchiveHtml(line.slice(2))}</blockquote>`)
          continue
        }
        const bullet = line.match(/^[-*]\s+(.*)$/)
        if (bullet) {
          if (listKind !== 'ul') {
            closeList()
            output.push('<ul>')
            listKind = 'ul'
          }
          output.push(`<li>${escapeArchiveHtml(bullet[1])}</li>`)
          continue
        }
        const ordered = line.match(/^\d+\.\s+(.*)$/)
        if (ordered) {
          if (listKind !== 'ol') {
            closeList()
            output.push('<ol>')
            listKind = 'ol'
          }
          output.push(`<li>${escapeArchiveHtml(ordered[1])}</li>`)
          continue
        }
        closeList()
        output.push(`<p>${escapeArchiveHtml(line)}</p>`)
      }
      closeList()
      return output.join('\n')
    }

    function archiveHtmlDocument(title, markdown) {
      return [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
        `<title>${escapeArchiveHtml(title)}</title>`,
        '<style>',
        'body{font-family:"Yu Gothic","YuGothic","Meiryo","Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.75;color:#20242a;margin:2.2cm;max-width:980px}',
        'h1{font-size:20pt;border-bottom:2px solid #d65a3a;padding-bottom:8px;margin-top:0}',
        'h2{font-size:15pt;color:#a9462c;border-bottom:1px solid #e6c7bb;padding-bottom:4px;margin-top:26px}',
        'h3{font-size:12.5pt;color:#333;margin-top:18px}',
        'h4{font-size:11.5pt;color:#46505c;margin-top:14px}',
        'p{margin:5px 0 9px;white-space:pre-wrap}',
        'ul,ol{margin:4px 0 10px 22px;padding:0}',
        'li{margin:2px 0;white-space:pre-wrap}',
        'blockquote{margin:8px 0;padding:7px 12px;border-left:3px solid #d65a3a;background:#faf6f3;color:#4b5563}',
        'hr{border:0;border-top:1px solid #ddd;margin:18px 0}',
        '</style>',
        '</head>',
        '<body>',
        archiveMarkdownToHtml(markdown),
        '</body>',
        '</html>',
      ].join('\n')
    }

    function downloadArchiveFile(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1500)
    }

    function buildArchiveDocument(session, research) {
      const setup = session?.setup ?? {}
      const record = session?.research ?? research ?? {}
      const sources = new Map((record.sources ?? []).map((source) => [source.id, source]))
      const dateText = session?.createdAt
        ? new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })
        : new Date().toLocaleString('zh-CN', { hour12: false })
      const title = `面试道场存档：${asText(setup.university) || '目标大学'}`
      const lines = []
      const push = (...items) => lines.push(...items)

      push(`# ${title}`, '')
      push(`> 存档时间：${dateText}`, '')
      push('## 基本信息', '')
      push(`- 目标大学：${asText(setup.university) || '未填写'}`)
      push(`- 学部/研究科：${asText(setup.faculty) || '未填写'}`)
      push(`- 专业/专攻：${asText(setup.major) || '未填写'}`)
      push(`- 课程：${asText(setup.program) || '未填写'}`)
      push(`- 面试形式：${asText(setup.format) || '未填写'}`)
      push(`- 日语水平：${asText(setup.jlpt) || '未填写'}`)
      if (asText(setup.officialUrl)) push(`- 官网：${asText(setup.officialUrl)}`)
      if (asText(record.universityNameJa)) push(`- 大学日文名：${asText(record.universityNameJa)}`)
      if (asText(record.facultyNameJa)) push(`- 学部日文名：${asText(record.facultyNameJa)}`)
      push('')
      push('## 面试概览', '')
      push(`- 状态：${session?.status === 'finished' || session?.finalReport ? '已完成' : '进行中'}`)
      push(`- 题目总数：${(session?.turns ?? []).length}`)
      push(`- 已回答：${(session?.turns ?? []).filter((turn) => Boolean(turn.answer)).length}`)
      if (session?.finalReport?.overallScore !== undefined) {
        push(`- 综合评分：${session.finalReport.overallScore}／100`)
      }
      push('')

      if (asText(session?.statement)) {
        push('## 本次提交的入学理由书', '', asText(session.statement), '')
      }

      push('## 大学与官网资料', '')
      if (asText(record.overviewZh)) push(record.overviewZh, '')
      if (asText(record.admissionPolicyZh)) push('### 招生理念', '', record.admissionPolicyZh, '')
      if (Array.isArray(record.interviewFocusZh) && record.interviewFocusZh.length > 0) {
        push('### 面试重点', '')
        for (const item of record.interviewFocusZh) push(`- ${item}`)
        push('')
      }
      if (Array.isArray(record.questions) && record.questions.length > 0) {
        push('### 题库与出题依据', '')
        record.questions.forEach((question, index) => {
          push(`${index + 1}. ${asText(question.jp) || `问题 ${index + 1}`}`)
          if (asText(question.zh)) push(`   - 中文：${asText(question.zh)}`)
          if (asText(question.intentZh)) push(`   - 意图：${asText(question.intentZh)}`)
          if (asText(question.sourceNote)) push(`   - 依据：${asText(question.sourceNote)}`)
          const refs = (question.sourceIds ?? []).map((id) => sources.get(id)).filter(Boolean)
          if (refs.length > 0) push(`   - 来源：${refs.map(archiveSourceText).join('；')}`)
        })
        push('')
      }
      if (Array.isArray(record.sources) && record.sources.length > 0) {
        push('### 抓取的官网来源', '')
        for (const source of record.sources) push(`- ${archiveSourceText(source)}`)
        push('')
      }
      if (asText(record.disclosure)) push(`> ${record.disclosure}`, '')

      push('## 面试对话与逐题解析', '')
      if (asText(session?.opening?.openingJp)) {
        push('### 面试官开场', '', session.opening.openingJp, '')
        if (asText(session.opening.openingZh)) push(session.opening.openingZh, '')
      }
      const turns = Array.isArray(session?.turns) ? session.turns : []
      if (turns.length === 0) push('（本次没有面试题目记录。）', '')
      for (const turn of turns) {
        push(`### 第 ${turn.n} 问`, '')
        if (asText(turn.reactionJp)) push(`面试官反应：${turn.reactionJp}`, '')
        if (asText(turn.question?.jp)) push(turn.question.jp, '')
        if (asText(turn.question?.zh)) push(`中文：${turn.question.zh}`, '')
        if (asText(turn.question?.intentZh)) push(`面试官意图：${turn.question.intentZh}`, '')
        if (asText(turn.question?.sourceNote)) push(`出题依据：${turn.question.sourceNote}`, '')
        const refs = (turn.question?.sourceIds ?? []).map((id) => sources.get(id)).filter(Boolean)
        if (refs.length > 0) push(`来源：${refs.map(archiveSourceText).join('；')}`, '')
        push('#### 你的回答', '')
        push(asText(turn.answer) || '（此题未回答）', '')
        if (turn.evaluation) {
          push('#### 本题反馈', '')
          if (turn.evaluation.score !== undefined) push(`评分：${turn.evaluation.score}／100`)
          if (asText(turn.evaluation.verdictZh)) push(turn.evaluation.verdictZh)
          if (Array.isArray(turn.evaluation.strengthsZh) && turn.evaluation.strengthsZh.length > 0) {
            push(`优点：${turn.evaluation.strengthsZh.join('；')}`)
          }
          if (Array.isArray(turn.evaluation.improvementsZh) && turn.evaluation.improvementsZh.length > 0) {
            push(`改进：${turn.evaluation.improvementsZh.join('；')}`)
          }
          if (Array.isArray(turn.evaluation.languageNotesZh) && turn.evaluation.languageNotesZh.length > 0) {
            push(`语言建议：${turn.evaluation.languageNotesZh.join('；')}`)
          }
          if (Array.isArray(turn.evaluation.contentNotesZh) && turn.evaluation.contentNotesZh.length > 0) {
            push(`内容建议：${turn.evaluation.contentNotesZh.join('；')}`)
          }
          if (asText(turn.evaluation.correctedJp)) push('日语修正：', '', turn.evaluation.correctedJp, '')
          push('')
        }
        if (asText(turn.analysis?.modelAnswerJp)) {
          push('#### 参考回答', '', turn.analysis.modelAnswerJp, '')
          if (asText(turn.analysis.modelAnswerZh)) push(turn.analysis.modelAnswerZh, '')
        }
        push('#### 解析', '')
        if (Array.isArray(turn.analysis?.structureZh) && turn.analysis.structureZh.length > 0) {
          push('回答结构：')
          for (const item of turn.analysis.structureZh) push(`- ${item}`)
          push('')
        }
        if (Array.isArray(turn.analysis?.vocabulary) && turn.analysis.vocabulary.length > 0) {
          push('重难词汇：')
          for (const item of turn.analysis.vocabulary) {
            push(`- ${item.word}${item.reading ? `（${item.reading}）` : ''}：${item.meaningZh || ''}${item.level ? `［${item.level}］` : ''}${item.exampleJp ? ` 例：${item.exampleJp}` : ''}`)
          }
          push('')
        }
        if (Array.isArray(turn.analysis?.grammar) && turn.analysis.grammar.length > 0) {
          push('语法与表达：')
          for (const item of turn.analysis.grammar) {
            push(`- ${item.point}：${item.explanationZh || ''}${item.exampleJp ? ` 例：${item.exampleJp}` : ''}`)
          }
          push('')
        }
        if (Array.isArray(turn.analysis?.tipsZh) && turn.analysis.tipsZh.length > 0) {
          push(`回答提示：${turn.analysis.tipsZh.join('；')}`, '')
        }
        if (asText(turn.analysis?.culturalNoteZh)) push(`文化与礼仪：${turn.analysis.culturalNoteZh}`, '')
        push('')
      }

      if (session?.finalReport) {
        push('## 面试报告', '')
        push(`总分：${session.finalReport.overallScore}／100`, '')
        if (asText(session.finalReport.summaryZh)) push(session.finalReport.summaryZh, '')
        if (Array.isArray(session.finalReport.strengthsZh) && session.finalReport.strengthsZh.length > 0) {
          push(`优点：${session.finalReport.strengthsZh.join('；')}`)
        }
        if (Array.isArray(session.finalReport.improvementsZh) && session.finalReport.improvementsZh.length > 0) {
          push(`改进：${session.finalReport.improvementsZh.join('；')}`)
        }
        if (asText(session.finalReport.universityFitZh)) push(`大学匹配度：${session.finalReport.universityFitZh}`)
        if (Array.isArray(session.finalReport.languageNotesZh) && session.finalReport.languageNotesZh.length > 0) {
          push(`语言总结：${session.finalReport.languageNotesZh.join('；')}`)
        }
        if (Array.isArray(session.finalReport.nextStepsZh) && session.finalReport.nextStepsZh.length > 0) {
          push(`下一步：${session.finalReport.nextStepsZh.join('；')}`)
        }
        if (Array.isArray(session.finalReport.keyVocabulary) && session.finalReport.keyVocabulary.length > 0) {
          push('重点词汇：')
          for (const item of session.finalReport.keyVocabulary) {
            push(`- ${item.word}${item.reading ? `（${item.reading}）` : ''}：${item.meaningZh || ''}`)
          }
        }
        push('')
      }

      push('## 知识清单', '')
      const vocabulary = new Map()
      const grammar = new Map()
      for (const turn of turns) {
        for (const item of turn.analysis?.vocabulary ?? []) {
          const key = `${item.word}|${item.reading || ''}`
          if (!vocabulary.has(key)) vocabulary.set(key, item)
        }
        for (const item of turn.analysis?.grammar ?? []) {
          const key = `${item.point}|${item.explanationZh || ''}`
          if (!grammar.has(key)) grammar.set(key, item)
        }
      }
      for (const item of session?.finalReport?.keyVocabulary ?? []) {
        const key = `${item.word}|${item.reading || ''}`
        if (!vocabulary.has(key)) vocabulary.set(key, item)
      }
      if (vocabulary.size > 0) {
        push('### 重难词汇汇总', '')
        for (const item of vocabulary.values()) {
          push(`- ${item.word}${item.reading ? `（${item.reading}）` : ''}：${item.meaningZh || ''}${item.level ? `［${item.level}］` : ''}${item.exampleJp ? ` 例：${item.exampleJp}` : ''}`)
        }
        push('')
      }
      if (grammar.size > 0) {
        push('### 语法与表达汇总', '')
        for (const item of grammar.values()) {
          push(`- ${item.point}：${item.explanationZh || ''}${item.exampleJp ? ` 例：${item.exampleJp}` : ''}`)
        }
        push('')
      }
      if (vocabulary.size === 0 && grammar.size === 0) push('（本次没有词汇或语法解析记录。）', '')

      if (Array.isArray(record.diagnostics) && record.diagnostics.length > 0) {
        push('## 抓取诊断', '')
        for (const item of record.diagnostics) push(`- ${item}`)
        push('')
      }
      push('---', '')
      push('由「面试道场」插件生成。题目由官网公开资料、常见题型和提交的理由书归纳，不是学校官方过去问；正式面试请以学校最新募集要项和通知为准。')
      push('')
      const markdown = lines.join('\n').trim() + '\n'
      const html = archiveHtmlDocument(title, markdown)
      return { title, markdown, html, baseName: archiveBaseName(session) }
    }

    function isResearchStale(researchSetup, setup) {
      if (!researchSetup || !setup) return false
      const keys = ['university', 'faculty', 'major', 'program', 'format', 'jlpt', 'officialUrl']
      return keys.some((key) => (researchSetup[key] ?? '') !== (setup[key] ?? ''))
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    const STYLE = `
.idojo-root {
  --idojo-bg: var(--dsw-alias-bg-layer-1, #ffffff);
  --idojo-card: var(--dsw-alias-bg-layer-2, #f7f8fa);
  --idojo-card-strong: var(--dsw-alias-bg-layer-3, #f1f3f6);
  --idojo-line: var(--dsw-alias-border-l2, #e3e6eb);
  --idojo-line-soft: var(--dsw-alias-border-l1, #edf0f3);
  --idojo-text: var(--dsw-alias-label-primary, #1f2329);
  --idojo-text-2: var(--dsw-alias-label-secondary, #4b5563);
  --idojo-muted: var(--dsw-alias-label-tertiary, #7b8494);
  --idojo-brand: var(--dsw-alias-brand-primary, #d65a3a);
  --idojo-brand-soft: var(--dsw-alias-brand-primary-soft, rgba(214, 90, 58, 0.12));
  --idojo-danger: var(--dsw-alias-state-error-primary, #d14343);
  --idojo-danger-soft: var(--dsw-alias-state-error-secondary, rgba(209, 67, 67, 0.1));
  --idojo-success: var(--dsw-alias-state-success-primary, #2f8a5b);
  --idojo-hover: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 420px;
  overflow: hidden;
  background: var(--idojo-bg);
  color: var(--idojo-text);
  font-size: 13px;
  line-height: 1.6;
}
.idojo-root *, .idojo-root *::before, .idojo-root *::after { box-sizing: border-box; }
.idojo-root button, .idojo-root input, .idojo-root textarea, .idojo-root select {
  font: inherit;
  color: inherit;
}
.idojo-root button { cursor: pointer; }
.idojo-root button:disabled { cursor: not-allowed; opacity: .55; }
.idojo-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--idojo-line-soft);
  background: var(--idojo-bg);
  flex: none;
}
.idojo-brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: var(--idojo-brand-soft);
  color: var(--idojo-brand);
  flex: none;
}
.idojo-header-copy { min-width: 0; flex: 1; }
.idojo-title { margin: 0; font-size: 14px; font-weight: 700; letter-spacing: .01em; }
.idojo-subtitle { margin: 1px 0 0; color: var(--idojo-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.idojo-header-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.idojo-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--idojo-brand-soft);
  color: var(--idojo-brand);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}
.idojo-live-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.idojo-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px;
  scroll-behavior: smooth;
}
.idojo-scroll.is-chat { padding-bottom: 18px; }
.idojo-narrow { max-width: 760px; margin: 0 auto; width: 100%; }
.idojo-hero { padding: 1px 2px 12px; }
.idojo-kicker { color: var(--idojo-brand); font-weight: 700; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
.idojo-hero h2 { margin: 4px 0 5px; font-size: 19px; line-height: 1.35; letter-spacing: -.01em; }
.idojo-hero p { margin: 0; color: var(--idojo-muted); font-size: 12px; }
.idojo-stepper { display: flex; align-items: stretch; gap: 0; margin: 0 0 12px; }
.idojo-step {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--idojo-line);
  border-radius: 10px;
  background: var(--idojo-bg);
  padding: 7px 8px;
  text-align: left;
  color: var(--idojo-text-2);
  transition: border-color .15s, background .15s;
}
.idojo-step:hover { border-color: var(--idojo-brand); }
.idojo-step.is-active { border-color: color-mix(in srgb, var(--idojo-brand) 50%, var(--idojo-line)); background: var(--idojo-brand-soft); color: var(--idojo-brand); }
.idojo-step.is-done { color: var(--idojo-success); }
.idojo-step-num {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--idojo-card);
  color: var(--idojo-muted);
  font-size: 10.5px;
  font-weight: 800;
}
.idojo-step.is-active .idojo-step-num { background: var(--idojo-brand); color: #fff; }
.idojo-step.is-done .idojo-step-num { background: color-mix(in srgb, var(--idojo-success) 14%, transparent); color: var(--idojo-success); }
.idojo-step-copy { display: flex; flex-direction: column; min-width: 0; }
.idojo-step-label { font-size: 11px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.idojo-step-hint { font-size: 9.5px; color: var(--idojo-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.idojo-step-line { flex: none; width: 8px; align-self: center; height: 1px; background: var(--idojo-line); }
.idojo-onboard {
  border: 1px solid color-mix(in srgb, var(--idojo-brand) 18%, var(--idojo-line));
  background: linear-gradient(135deg, var(--idojo-brand-soft), var(--idojo-card) 72%);
  border-radius: 14px;
  padding: 14px;
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.idojo-onboard.is-compact { padding: 11px 13px; gap: 8px; }
.idojo-onboard-main { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.idojo-onboard-icon { width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; background: var(--idojo-bg); color: var(--idojo-brand); flex: none; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
.idojo-onboard-copy { min-width: 0; flex: 1; }
.idojo-onboard-copy h2 { margin: 3px 0 3px; font-size: 17px; line-height: 1.35; letter-spacing: -.01em; }
.idojo-onboard.is-compact .idojo-onboard-copy h2 { font-size: 14.5px; }
.idojo-onboard-copy p { margin: 0; color: var(--idojo-text-2); font-size: 11.5px; line-height: 1.6; }
.idojo-onboard-steps { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 7px; }
.idojo-onboard-steps > span:not(.idojo-onboard-arrow) { background: var(--idojo-bg); border: 1px solid var(--idojo-line-soft); border-radius: 7px; padding: 2px 7px; font-size: 10px; color: var(--idojo-text-2); }
.idojo-onboard-arrow { color: var(--idojo-brand); font-size: 10px; }
.idojo-onboard-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.idojo-display-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 7px 0 9px; margin-bottom: 7px; border-bottom: 1px solid var(--idojo-line-soft); }
.idojo-display-label { font-size: 10.5px; color: var(--idojo-muted); margin-right: 1px; }
.idojo-toggle {
  border: 1px solid var(--idojo-line);
  background: var(--idojo-bg);
  color: var(--idojo-muted);
  border-radius: 999px;
  padding: 2px 9px;
  font-size: 10.5px;
  font-weight: 650;
}
.idojo-toggle:hover { border-color: var(--idojo-brand); color: var(--idojo-brand); }
.idojo-toggle.is-on { border-color: color-mix(in srgb, var(--idojo-brand) 40%, transparent); background: var(--idojo-brand-soft); color: var(--idojo-brand); }
.idojo-step-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; background: var(--idojo-brand-soft); color: var(--idojo-brand); font-size: 10px; font-weight: 800; padding: 2px 8px; letter-spacing: .02em; }
.idojo-required { color: var(--idojo-danger); font-size: 10px; font-weight: 700; margin-left: 4px; }
.idojo-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.idojo-upload.is-large { padding: 16px; min-height: 92px; gap: 13px; }
.idojo-upload.is-large .idojo-upload-icon { width: 42px; height: 42px; border-radius: 12px; }
.idojo-upload.is-large .idojo-upload-title { font-size: 13px; }
.idojo-upload.is-large .idojo-upload-sub { font-size: 11px; }
.idojo-help-card { border: 1px dashed var(--idojo-line); border-radius: 10px; padding: 9px 10px; background: var(--idojo-card); }
.idojo-help-card h4 { margin: 0 0 3px; font-size: 11px; }
.idojo-help-card p { margin: 0; font-size: 10.8px; color: var(--idojo-muted); line-height: 1.55; }
.idojo-crash { min-height: 220px; padding: 22px; display: flex; flex-direction: column; align-items: flex-start; gap: 9px; color: var(--idojo-text); background: var(--idojo-bg); }
.idojo-crash h2 { margin: 0; font-size: 17px; }
.idojo-crash p { margin: 0; color: var(--idojo-text-2); font-size: 12px; line-height: 1.6; }
.idojo-crash pre { width: 100%; max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; padding: 8px; border-radius: 8px; background: var(--idojo-card); color: var(--idojo-muted); font-size: 10.5px; }
.idojo-settings-card {
  --idojo-bg: var(--dsw-alias-bg-layer-1, #ffffff);
  --idojo-card: var(--dsw-alias-bg-layer-2, #f7f8fa);
  --idojo-card-strong: var(--dsw-alias-bg-layer-3, #f1f3f6);
  --idojo-line: var(--dsw-alias-border-l2, #e3e6eb);
  --idojo-line-soft: var(--dsw-alias-border-l1, #edf0f3);
  --idojo-text: var(--dsw-alias-label-primary, #1f2329);
  --idojo-text-2: var(--dsw-alias-label-secondary, #4b5563);
  --idojo-muted: var(--dsw-alias-label-tertiary, #7b8494);
  --idojo-brand: var(--dsw-alias-brand-primary, #d65a3a);
  --idojo-brand-soft: var(--dsw-alias-brand-primary-soft, rgba(214, 90, 58, 0.12));
  --idojo-success: var(--dsw-alias-state-success-primary, #2f8a5b);
  --idojo-danger: var(--dsw-alias-state-error-primary, #d14343);
  --idojo-hover: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  border: 1px solid var(--idojo-line);
  border-radius: 12px;
  background: var(--idojo-bg);
  padding: 16px;
  max-width: 720px;
  color: var(--idojo-text);
  font-size: 12.5px;
  line-height: 1.65;
}
.idojo-settings-card, .idojo-settings-card * { box-sizing: border-box; }
.idojo-settings-card button { font: inherit; cursor: pointer; }
.idojo-settings-head { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; }
.idojo-settings-head h3 { margin: 0; font-size: 15px; }
.idojo-settings-head p { margin: 1px 0 0; color: var(--idojo-muted); font-size: 11px; }
.idojo-card {
  border: 1px solid var(--idojo-line);
  background: var(--idojo-bg);
  border-radius: 12px;
  padding: 13px;
  margin-bottom: 12px;
}
.idojo-card.is-soft { background: var(--idojo-card); }
.idojo-card.is-accent { background: var(--idojo-brand-soft); border-color: transparent; }
.idojo-card-head { display: flex; align-items: flex-start; gap: 8px; justify-content: space-between; margin-bottom: 9px; }
.idojo-card-title { margin: 0; font-size: 13px; font-weight: 700; }
.idojo-card-sub { margin: 2px 0 0; color: var(--idojo-muted); font-size: 11px; }
.idojo-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.idojo-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.idojo-field.is-full { grid-column: 1 / -1; }
.idojo-label { font-size: 11px; font-weight: 650; color: var(--idojo-text-2); }
.idojo-hint { font-size: 10.5px; color: var(--idojo-muted); line-height: 1.45; }
.idojo-input, .idojo-select, .idojo-textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--idojo-line);
  background: var(--idojo-bg);
  border-radius: 8px;
  padding: 7px 9px;
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.idojo-input:focus, .idojo-select:focus, .idojo-textarea:focus {
  border-color: var(--idojo-brand);
  box-shadow: 0 0 0 3px var(--idojo-brand-soft);
}
.idojo-textarea { min-height: 86px; resize: vertical; line-height: 1.65; }
.idojo-textarea.is-statement { min-height: 150px; font-size: 12px; }
.idojo-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.idojo-actions.is-end { justify-content: flex-end; }
.idojo-btn {
  border: 1px solid var(--idojo-line);
  background: var(--idojo-bg);
  color: var(--idojo-text);
  border-radius: 8px;
  min-height: 31px;
  padding: 5px 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: background .15s, border-color .15s, transform .1s;
}
.idojo-btn:hover:not(:disabled) { background: var(--idojo-hover); }
.idojo-btn:active:not(:disabled) { transform: translateY(1px); }
.idojo-btn.is-primary { background: var(--idojo-brand); border-color: var(--idojo-brand); color: var(--dsw-alias-label-primary-inverted, #ffffff); }
.idojo-btn.is-primary:hover:not(:disabled) { filter: brightness(1.05); background: var(--idojo-brand); }
.idojo-btn.is-soft { background: var(--idojo-brand-soft); border-color: transparent; color: var(--idojo-brand); }
.idojo-btn.is-danger { color: var(--idojo-danger); border-color: color-mix(in srgb, var(--idojo-danger) 30%, transparent); }
.idojo-btn.is-block { width: 100%; }
.idojo-btn.is-small { min-height: 26px; padding: 3px 8px; font-size: 11px; }
.idojo-btn.is-icon { width: 31px; min-height: 31px; padding: 0; }
.idojo-link { color: var(--dsw-alias-label-link, var(--idojo-brand)); text-decoration: none; }
.idojo-link:hover { text-decoration: underline; }
.idojo-muted { color: var(--idojo-muted); }
.idojo-small { font-size: 11px; }
.idojo-mt8 { margin-top: 8px; }
.idojo-mt10 { margin-top: 10px; }
.idojo-divider { height: 1px; background: var(--idojo-line-soft); margin: 11px 0; }
.idojo-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 999px;
  padding: 1.5px 7px;
  background: var(--idojo-card-strong);
  color: var(--idojo-text-2);
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.idojo-badge.is-school { background: var(--idojo-brand-soft); color: var(--idojo-brand); }
.idojo-badge.is-common { background: var(--dsw-alias-bg-multi-select, var(--idojo-card-strong)); color: var(--idojo-text-2); }
.idojo-badge.is-success { background: color-mix(in srgb, var(--idojo-success) 13%, transparent); color: var(--idojo-success); }
.idojo-badge.is-danger { background: var(--idojo-danger-soft); color: var(--idojo-danger); }
.idojo-badge.is-outline { background: transparent; border: 1px solid var(--idojo-line); }
.idojo-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.idojo-diff { display: inline-flex; gap: 2px; align-items: center; }
.idojo-diff i { display: block; width: 4px; height: 9px; border-radius: 2px; background: var(--idojo-line); }
.idojo-diff i.is-on { background: var(--idojo-brand); }
.idojo-alert {
  border-radius: 9px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.55;
  margin: 8px 0;
  border: 1px solid transparent;
}
.idojo-alert.is-error { color: var(--idojo-danger); background: var(--idojo-danger-soft); }
.idojo-alert.is-warn { color: var(--dsw-alias-state-warning-primary, #9a6700); background: color-mix(in srgb, #d4a72c 14%, transparent); }
.idojo-alert.is-info { color: var(--idojo-text-2); background: var(--idojo-card); border-color: var(--idojo-line-soft); }
.idojo-alert.is-success { color: var(--idojo-success); background: color-mix(in srgb, var(--idojo-success) 12%, transparent); }
.idojo-list { margin: 6px 0 0; padding-left: 18px; }
.idojo-list li { margin: 3px 0; }
.idojo-list.is-plain { list-style: none; padding-left: 0; }
.idojo-list.is-plain li { display: flex; gap: 7px; align-items: flex-start; }
.idojo-check { color: var(--idojo-success); flex: none; font-weight: 700; }
.idojo-warning-mark { color: var(--dsw-alias-state-warning-primary, #9a6700); flex: none; font-weight: 700; }
.idojo-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.idojo-chip { padding: 2px 8px; border-radius: 7px; background: var(--idojo-card); color: var(--idojo-text-2); font-size: 10.5px; }
.idojo-source-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.idojo-source {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 7px 8px;
  border: 1px solid var(--idojo-line-soft);
  border-radius: 8px;
  background: var(--idojo-bg);
  min-width: 0;
}
.idojo-source-id { flex: none; font-size: 10px; font-weight: 700; color: var(--idojo-brand); background: var(--idojo-brand-soft); border-radius: 5px; padding: 1px 5px; }
.idojo-source-copy { min-width: 0; flex: 1; }
.idojo-source-title { display: block; font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.idojo-source-url { display: block; color: var(--idojo-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.idojo-upload {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1.5px dashed var(--idojo-line);
  border-radius: 10px;
  padding: 10px;
  background: var(--idojo-card);
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.idojo-upload:hover, .idojo-upload.is-drag { border-color: var(--idojo-brand); background: var(--idojo-brand-soft); }
.idojo-upload-icon { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: var(--idojo-brand); background: var(--idojo-brand-soft); flex: none; }
.idojo-upload-copy { min-width: 0; flex: 1; }
.idojo-upload-title { font-size: 12px; font-weight: 650; }
.idojo-upload-sub { font-size: 10.5px; color: var(--idojo-muted); margin-top: 1px; }
.idojo-file-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 7px; font-size: 10.5px; color: var(--idojo-muted); }
.idojo-error-actions { margin-top: 6px; }
.idojo-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--idojo-text-2);
}
.idojo-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--idojo-line);
  border-top-color: var(--idojo-brand);
  animation: idojo-spin .8s linear infinite;
  flex: none;
}
@keyframes idojo-spin { to { transform: rotate(360deg); } }
.idojo-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--idojo-line-soft); padding: 0 0 8px; margin-bottom: 10px; flex: none; }
.idojo-tab { border: 0; background: transparent; padding: 5px 9px; border-radius: 7px; color: var(--idojo-muted); font-size: 12px; font-weight: 600; }
.idojo-tab:hover { background: var(--idojo-hover); color: var(--idojo-text); }
.idojo-tab.is-active { background: var(--idojo-brand-soft); color: var(--idojo-brand); }
.idojo-turn { margin: 0 0 14px; }
.idojo-speaker { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.idojo-avatar { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: var(--idojo-brand); color: #fff; font-size: 11px; font-weight: 700; flex: none; }
.idojo-avatar.is-user { background: var(--idojo-card-strong); color: var(--idojo-text-2); }
.idojo-speaker-name { font-size: 11px; font-weight: 700; color: var(--idojo-text-2); }
.idojo-speaker-time { font-size: 10px; color: var(--idojo-muted); }
.idojo-bubble {
  border: 1px solid var(--idojo-line);
  border-radius: 2px 12px 12px 12px;
  padding: 10px 11px;
  background: var(--idojo-bg);
  min-width: 0;
}
.idojo-bubble.is-user {
  border-radius: 12px 2px 12px 12px;
  background: var(--idojo-card);
  border-color: var(--idojo-line-soft);
}
.idojo-bubble.is-opening { border-color: transparent; background: var(--idojo-brand-soft); }
.idojo-reaction { font-size: 11.5px; color: var(--idojo-text-2); padding: 1px 2px 7px; display: flex; gap: 6px; align-items: flex-start; }
.idojo-reaction::before { content: '“'; color: var(--idojo-brand); font-size: 17px; line-height: 1; font-weight: 700; }
.idojo-jp { font-size: 15px; line-height: 1.8; letter-spacing: .01em; word-break: break-word; }
.idojo-jp.is-answer { font-size: 13px; line-height: 1.75; }
.idojo-zh { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--idojo-line-soft); color: var(--idojo-muted); font-size: 11.5px; line-height: 1.65; }
.idojo-mark { background: color-mix(in srgb, var(--idojo-brand) 17%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; border-bottom: 1px solid color-mix(in srgb, var(--idojo-brand) 55%, transparent); }
.idojo-pending {
  border: 1px dashed var(--idojo-line);
  border-radius: 9px;
  padding: 8px 10px;
  color: var(--idojo-muted);
  font-size: 11.5px;
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--idojo-card);
}
.idojo-details { border: 1px solid var(--idojo-line-soft); border-radius: 9px; margin-top: 9px; background: var(--idojo-card); overflow: hidden; }
.idojo-details > summary { cursor: pointer; padding: 7px 9px; font-size: 11.5px; font-weight: 650; color: var(--idojo-text-2); list-style: none; display: flex; align-items: center; gap: 6px; }
.idojo-details > summary::-webkit-details-marker { display: none; }
.idojo-details > summary::before { content: '▸'; color: var(--idojo-brand); font-size: 10px; transition: transform .15s; }
.idojo-details[open] > summary::before { transform: rotate(90deg); }
.idojo-details-body { padding: 0 9px 10px; border-top: 1px solid var(--idojo-line-soft); }
.idojo-details-body > .idojo-section:first-child { margin-top: 9px; }
.idojo-section { margin-top: 10px; }
.idojo-section-title { margin: 0 0 4px; font-size: 11px; font-weight: 700; color: var(--idojo-text-2); letter-spacing: .01em; }
.idojo-table-wrap { overflow-x: auto; border: 1px solid var(--idojo-line-soft); border-radius: 8px; }
.idojo-vocab { border-collapse: collapse; width: 100%; font-size: 10.8px; }
.idojo-vocab th, .idojo-vocab td { text-align: left; padding: 5px 7px; border-bottom: 1px solid var(--idojo-line-soft); vertical-align: top; }
.idojo-vocab th { background: var(--idojo-card-strong); color: var(--idojo-text-2); font-weight: 650; white-space: nowrap; }
.idojo-vocab tr:last-child td { border-bottom: 0; }
.idojo-vocab td.is-word { font-weight: 700; white-space: nowrap; }
.idojo-vocab td.is-reading { color: var(--idojo-muted); white-space: nowrap; }
.idojo-grammar { display: flex; flex-direction: column; gap: 6px; }
.idojo-grammar-item { border-left: 2px solid var(--idojo-brand); padding-left: 7px; }
.idojo-grammar-point { font-size: 11.5px; font-weight: 700; }
.idojo-grammar-copy { color: var(--idojo-text-2); font-size: 11px; margin-top: 1px; }
.idojo-example { color: var(--idojo-muted); font-size: 10.8px; margin-top: 2px; }
.idojo-answer-block { background: var(--idojo-bg); border: 1px solid var(--idojo-line-soft); border-radius: 8px; padding: 8px 9px; }
.idojo-answer-label { font-size: 10px; font-weight: 700; color: var(--idojo-brand); margin-bottom: 3px; }
.idojo-eval { border: 1px solid var(--idojo-line); border-radius: 10px; padding: 10px; margin-top: 8px; background: var(--idojo-bg); }
.idojo-eval-head { display: flex; align-items: center; gap: 10px; }
.idojo-score { width: 45px; height: 45px; border-radius: 50%; display: grid; place-items: center; font-size: 15px; font-weight: 800; flex: none; background: var(--idojo-card); color: var(--idojo-text-2); border: 2px solid var(--idojo-line); }
.idojo-score.is-good { color: var(--idojo-success); border-color: color-mix(in srgb, var(--idojo-success) 35%, transparent); background: color-mix(in srgb, var(--idojo-success) 9%, transparent); }
.idojo-score.is-mid { color: var(--dsw-alias-state-warning-primary, #9a6700); border-color: color-mix(in srgb, #d4a72c 35%, transparent); background: color-mix(in srgb, #d4a72c 9%, transparent); }
.idojo-score.is-low { color: var(--idojo-danger); border-color: color-mix(in srgb, var(--idojo-danger) 35%, transparent); background: color-mix(in srgb, var(--idojo-danger) 9%, transparent); }
.idojo-eval-verdict { min-width: 0; flex: 1; }
.idojo-eval-verdict strong { font-size: 12px; }
.idojo-eval-verdict p { margin: 2px 0 0; color: var(--idojo-text-2); font-size: 11px; }
.idojo-eval-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-top: 8px; }
.idojo-eval-col { background: var(--idojo-card); border-radius: 8px; padding: 7px 8px; min-width: 0; }
.idojo-eval-col h5 { margin: 0 0 3px; font-size: 10.5px; font-weight: 700; color: var(--idojo-text-2); }
.idojo-eval-col .idojo-list { margin-top: 2px; }
.idojo-report-score { display: flex; align-items: center; gap: 14px; }
.idojo-report-score .idojo-score { width: 70px; height: 70px; font-size: 23px; }
.idojo-report-kicker { font-size: 11px; color: var(--idojo-muted); }
.idojo-report-title { margin: 2px 0; font-size: 17px; font-weight: 750; }
.idojo-progress { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.idojo-progress-bar { height: 4px; border-radius: 999px; background: var(--idojo-card-strong); overflow: hidden; flex: 1; min-width: 80px; }
.idojo-progress-bar > i { display: block; height: 100%; background: var(--idojo-brand); border-radius: inherit; transition: width .25s; }
.idojo-composer { flex: none; border-top: 1px solid var(--idojo-line); background: var(--idojo-bg); padding: 10px 12px 12px; max-height: min(62%, 540px); overflow-y: auto; }
.idojo-composer-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 7px; }
.idojo-voice-switch { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--idojo-line); background: var(--idojo-bg); border-radius: 999px; padding: 3px 9px 3px 4px; font-size: 11px; font-weight: 650; color: var(--idojo-text-2); }
.idojo-voice-switch.is-on { border-color: color-mix(in srgb, var(--idojo-brand) 35%, transparent); background: var(--idojo-brand-soft); color: var(--idojo-brand); }
.idojo-switch-dot { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: var(--idojo-card-strong); color: var(--idojo-muted); }
.idojo-voice-switch.is-on .idojo-switch-dot { background: var(--idojo-brand); color: #fff; }
.idojo-voice-row { display: flex; align-items: flex-end; gap: 8px; }
.idojo-mic {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  flex: none;
  border: 1px solid var(--idojo-line);
  background: var(--idojo-card);
  color: var(--idojo-text-2);
  display: grid;
  place-items: center;
  position: relative;
  transition: background .15s, color .15s, border-color .15s, box-shadow .15s;
}
.idojo-mic:hover:not(:disabled) { border-color: var(--idojo-brand); color: var(--idojo-brand); }
.idojo-mic.is-listening { background: var(--idojo-brand); border-color: var(--idojo-brand); color: #fff; box-shadow: 0 0 0 5px var(--idojo-brand-soft); }
.idojo-mic.is-listening::after { content: ''; position: absolute; inset: -7px; border: 1px solid var(--idojo-brand); border-radius: 50%; animation: idojo-ping 1.4s ease-out infinite; }
@keyframes idojo-ping { 0% { transform: scale(.9); opacity: .6; } 100% { transform: scale(1.25); opacity: 0; } }
.idojo-live-transcript { margin-top: 6px; padding: 6px 8px; border-radius: 7px; background: var(--idojo-card); color: var(--idojo-text-2); font-size: 11.5px; min-height: 28px; }
.idojo-live-transcript.is-listening { border-left: 2px solid var(--idojo-brand); }
.idojo-wave { display: inline-flex; align-items: center; gap: 2px; height: 13px; margin-right: 6px; vertical-align: middle; }
.idojo-wave i { width: 2px; height: 5px; border-radius: 1px; background: var(--idojo-brand); animation: idojo-wave .9s ease-in-out infinite; }
.idojo-wave i:nth-child(2) { animation-delay: .15s; height: 9px; }
.idojo-wave i:nth-child(3) { animation-delay: .3s; height: 6px; }
@keyframes idojo-wave { 0%, 100% { transform: scaleY(.55); } 50% { transform: scaleY(1.2); } }
.idojo-voice-settings { margin-top: 7px; border-top: 1px dashed var(--idojo-line-soft); padding-top: 6px; }
.idojo-voice-settings > summary { cursor: pointer; font-size: 10.5px; color: var(--idojo-muted); }
.idojo-voice-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 5px 10px; margin-top: 6px; font-size: 10.5px; color: var(--idojo-text-2); }
.idojo-check-row { display: flex; align-items: center; gap: 5px; }
.idojo-check-row input { accent-color: var(--idojo-brand); }
.idojo-select.is-small { padding: 3px 6px; border-radius: 6px; font-size: 10.5px; }
.idojo-archive-note { border: 1px solid color-mix(in srgb, var(--idojo-success) 28%, var(--idojo-line)); background: color-mix(in srgb, var(--idojo-success) 8%, var(--idojo-bg)); border-radius: 9px; padding: 8px 11px; margin: 8px 0; font-size: 11px; line-height: 1.6; color: var(--idojo-text-2); word-break: break-all; }
.idojo-archive-note strong { display: block; color: var(--idojo-success); font-size: 11.5px; margin-bottom: 2px; }
.idojo-hint-card { border: 1px solid color-mix(in srgb, var(--idojo-brand) 25%, var(--idojo-line)); background: var(--idojo-brand-soft); border-radius: 9px; padding: 9px 10px; margin-bottom: 8px; }
.idojo-hint-card h4 { margin: 0 0 4px; font-size: 11.5px; }
.idojo-empty { padding: 24px 12px; text-align: center; color: var(--idojo-muted); font-size: 12px; }
.idojo-qbank { display: flex; flex-direction: column; gap: 6px; }
.idojo-qbank-item { border: 1px solid var(--idojo-line-soft); border-radius: 8px; background: var(--idojo-bg); overflow: hidden; }
.idojo-qbank-item > summary { list-style: none; cursor: pointer; padding: 7px 8px; display: flex; gap: 7px; align-items: flex-start; }
.idojo-qbank-item > summary::-webkit-details-marker { display: none; }
.idojo-qbank-num { flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center; background: var(--idojo-card); font-size: 10px; font-weight: 700; color: var(--idojo-muted); }
.idojo-qbank-copy { min-width: 0; flex: 1; }
.idojo-qbank-jp { font-size: 11.8px; line-height: 1.55; }
.idojo-qbank-zh { font-size: 10.5px; color: var(--idojo-muted); margin-top: 2px; }
.idojo-qbank-body { padding: 0 8px 8px 35px; color: var(--idojo-text-2); font-size: 10.8px; }
.idojo-footer-note { color: var(--idojo-muted); font-size: 10px; line-height: 1.5; margin-top: 10px; }
.idojo-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 27px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-secondary, #4b5563);
  padding: 0 8px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}
.idojo-pill:hover { border-color: var(--dsw-alias-brand-primary, #d65a3a); color: var(--dsw-alias-brand-primary, #d65a3a); }
.idojo-pill svg { flex: none; }
.idojo-hidden { display: none !important; }
@media (max-width: 420px) {
  .idojo-scroll { padding: 10px; }
  .idojo-header { padding: 9px 10px; }
  .idojo-composer { padding: 8px 9px 10px; }
  .idojo-live-badge { display: none; }
  .idojo-jp { font-size: 14px; }
  .idojo-btn { padding-left: 8px; padding-right: 8px; }
  .idojo-step { padding: 6px; gap: 4px; }
  .idojo-step-hint { display: none; }
  .idojo-step-line { width: 3px; }
  .idojo-onboard { padding: 11px; }
  .idojo-onboard-icon { width: 36px; height: 36px; }
  .idojo-onboard-copy h2 { font-size: 15px; }
  .idojo-upload.is-large { padding: 12px; min-height: 78px; }
}
@media (prefers-reduced-motion: reduce) {
  .idojo-spinner { animation-duration: 2.4s; }
  .idojo-wave i { animation: none; height: 7px; }
  .idojo-mic.is-listening::after { display: none; }
}
`

    // ------------------------------------------------------------------
    // Icons
    // ------------------------------------------------------------------

    function ToriiIcon({ size = 18 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 36 36',
        fill: 'none',
        'aria-hidden': true,
      },
        h('path', { d: 'M5.5 7.5h25', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' }),
        h('path', { d: 'M7.4 11.2h21.2', stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round' }),
        h('path', { d: 'M10.1 11.6 9.2 27.7M25.9 11.6l.9 16.1', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' }),
        h('path', { d: 'M11.1 17.4h13.8', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('path', { d: 'M17.3 12.1v5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function MicIcon({ size = 20, muted = false }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3, stroke: 'currentColor', strokeWidth: 1.8 }),
        h('path', { d: 'M5.8 11a6.2 6.2 0 0 0 12.4 0', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        h('path', { d: 'M12 17.2V21', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
        muted ? h('path', { d: 'M4 4l16 16', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }) : null,
      )
    }

    function VolumeIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M4 9.5v5h3.2L12 18V6L7.2 9.5H4Z', stroke: 'currentColor', strokeWidth: 1.8, strokeLinejoin: 'round' }),
        h('path', { d: 'M15.5 9a4.3 4.3 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function PlusIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M12 5v14M5 12h14', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function ArrowIcon({ size = 14 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M5 12h13M13 6l6 6-6 6', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    // ------------------------------------------------------------------
    // Shared UI
    // ------------------------------------------------------------------

    function Spinner({ label }) {
      return h('div', { className: 'idojo-loading' }, h('span', { className: 'idojo-spinner' }), h('span', null, label))
    }

    function Alert({ tone = 'info', children, onRetry, retryLabel = '重试' }) {
      return h('div', {
        className: `idojo-alert is-${tone}`,
        role: tone === 'error' || tone === 'warn' ? 'alert' : 'status',
      },
        children,
        onRetry ? h('div', { className: 'idojo-error-actions' }, h('button', { type: 'button', className: 'idojo-btn is-small', onClick: onRetry }, retryLabel)) : null,
      )
    }

    function Badge({ children, tone, title }) {
      return h('span', { className: `idojo-badge${tone ? ` is-${tone}` : ''}`, title }, children)
    }

    function Difficulty({ value }) {
      const level = Math.max(1, Math.min(5, Number(value) || 1))
      return h('span', { className: 'idojo-diff', title: `难度 ${level}/5` },
        [1, 2, 3, 4, 5].map((index) => h('i', { key: index, className: index <= level ? 'is-on' : '' })),
      )
    }

    function Field({ label, hint, full, children }) {
      return h('label', { className: `idojo-field${full ? ' is-full' : ''}` },
        h('span', { className: 'idojo-label' }, label),
        children,
        hint ? h('span', { className: 'idojo-hint' }, hint) : null,
      )
    }

    function Highlight({ text, vocabulary }) {
      const source = asText(text)
      const words = [...new Set((vocabulary ?? []).map((item) => asText(item?.word)).filter(Boolean))]
        .filter((word) => source.includes(word))
        .sort((left, right) => right.length - left.length)
      if (words.length === 0 || source === '') return source
      const map = new Map((vocabulary ?? []).map((item) => [item.word, item]))
      const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'g')
      return source.split(pattern).map((part, index) => {
        if (!words.includes(part)) return part
        const item = map.get(part)
        const title = [item?.reading, item?.meaningZh].filter(Boolean).join(' · ')
        return h('mark', { key: `${part}-${index}`, className: 'idojo-mark', title: title || undefined }, part)
      })
    }

    function VocabTable({ vocabulary }) {
      if (!Array.isArray(vocabulary) || vocabulary.length === 0) return null
      return h('div', { className: 'idojo-table-wrap' },
        h('table', { className: 'idojo-vocab' },
          h('thead', null, h('tr', null,
            h('th', null, '重难词汇'),
            h('th', null, '读音'),
            h('th', null, '中文'),
            h('th', null, '级别'),
          )),
          h('tbody', null, vocabulary.map((item, index) => h('tr', { key: `${item.word}-${index}` },
            h('td', { className: 'is-word' }, item.word),
            h('td', { className: 'is-reading' }, item.reading || '—'),
            h('td', null,
              item.meaningZh || '—',
              item.exampleJp ? h('div', { className: 'idojo-example' }, item.exampleJp) : null,
            ),
            h('td', { className: 'is-reading' }, item.level || '—'),
          ))),
        ),
      )
    }

    function SourceList({ sources }) {
      if (!Array.isArray(sources) || sources.length === 0) {
        return h('p', { className: 'idojo-hint' }, '暂无已抓取的官网页面。')
      }
      return h('div', { className: 'idojo-source-list' }, sources.map((source) => {
        const href = safeHttpUrl(source.url)
        return h('div', { className: 'idojo-source', key: source.id },
          h('span', { className: 'idojo-source-id' }, source.id),
          h('div', { className: 'idojo-source-copy' },
            href
              ? h('a', {
                className: 'idojo-source-title idojo-link',
                href,
                target: '_blank',
                rel: 'noreferrer noopener',
                title: href,
              }, source.title || safeHost(href))
              : h('span', { className: 'idojo-source-title' }, source.title || source.url),
            h('span', { className: 'idojo-source-url' }, `${safeHost(source.url)}${source.chars ? ` · ${source.chars} 字` : ''}`),
          ),
        )
      }))
    }

    function InlineSources({ ids, sources }) {
      if (!Array.isArray(ids) || ids.length === 0 || !Array.isArray(sources)) return null
      const map = new Map(sources.map((source) => [source.id, source]))
      const resolved = ids.map((id) => map.get(id)).filter(Boolean)
      if (resolved.length === 0) return null
      return h('div', { className: 'idojo-hint idojo-mt8' },
        '来源：',
        resolved.map((source, index) => {
          const href = safeHttpUrl(source.url)
          return h('span', { key: source.id },
            index > 0 ? ' · ' : null,
            href
              ? h('a', {
                className: 'idojo-link',
                href,
                target: '_blank',
                rel: 'noreferrer noopener',
                title: href,
              }, `[${source.id}] ${source.title || safeHost(href)}`)
              : h('span', null, `[${source.id}] ${source.title || source.url}`),
          )
        }),
      )
    }

    function QuestionBank({ questions, sources, limit }) {
      if (!Array.isArray(questions) || questions.length === 0) {
        return h('p', { className: 'idojo-hint' }, '题库为空。')
      }
      const selected = typeof limit === 'number' ? questions.slice(0, limit) : questions
      return h('div', { className: 'idojo-qbank' }, selected.map((question, index) => h('details', { className: 'idojo-qbank-item', key: question.id || index },
        h('summary', null,
          h('span', { className: 'idojo-qbank-num' }, index + 1),
          h('span', { className: 'idojo-qbank-copy' },
            h('span', { className: 'idojo-qbank-jp' }, question.jp),
            h('span', { className: 'idojo-qbank-zh' }, question.zh),
            h('span', { className: 'idojo-meta', style: { marginTop: '4px' } },
              h(Badge, { tone: question.schoolSpecific ? 'school' : 'common' }, question.schoolSpecific ? '本校专属' : '共通'),
              h(Badge, null, question.category),
              h(Difficulty, { value: question.difficulty }),
            ),
          ),
        ),
        h('div', { className: 'idojo-qbank-body' },
          h('div', null, h('strong', null, '面试官意图：'), question.intentZh || '未说明'),
          question.sourceNote ? h('div', { className: 'idojo-mt8' }, h('strong', null, '依据：'), question.sourceNote) : null,
          h(InlineSources, { ids: question.sourceIds, sources }),
        ),
      )))
    }

    function AnalysisDetails({ analysis, label = '题目解析 · 重难词汇 · 参考回答', showJp = true, showZh = true }) {
      if (!analysis || typeof analysis !== 'object') return null
      const hasModelAnswer = (showJp && analysis.modelAnswerJp) || (showZh && analysis.modelAnswerZh)
      const hasAny = analysis.intentZh || analysis.structureZh?.length || analysis.vocabulary?.length
        || analysis.grammar?.length || analysis.tipsZh?.length || hasModelAnswer
      if (!hasAny) return null
      return h('details', { className: 'idojo-details' },
        h('summary', null,
          h('span', null, label),
          analysis.vocabulary?.length ? h('span', { className: 'idojo-muted' }, ` · ${analysis.vocabulary.length} 个词`) : null,
        ),
        h('div', { className: 'idojo-details-body' },
          analysis.intentZh ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '面试官意图'),
            h('div', null, analysis.intentZh),
          ) : null,
          analysis.structureZh?.length ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '回答结构'),
            h('ol', { className: 'idojo-list' }, analysis.structureZh.map((item, index) => h('li', { key: index }, item))),
          ) : null,
          analysis.vocabulary?.length ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '重难词汇'),
            h(VocabTable, { vocabulary: analysis.vocabulary }),
          ) : null,
          analysis.grammar?.length ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '语法与表达'),
            h('div', { className: 'idojo-grammar' }, analysis.grammar.map((item, index) => h('div', { className: 'idojo-grammar-item', key: index },
              h('div', { className: 'idojo-grammar-point' }, item.point),
              h('div', { className: 'idojo-grammar-copy' }, item.explanationZh),
              item.exampleJp ? h('div', { className: 'idojo-example' }, item.exampleJp) : null,
            ))),
          ) : null,
          analysis.tipsZh?.length ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '回答提示'),
            h('ul', { className: 'idojo-list' }, analysis.tipsZh.map((item, index) => h('li', { key: index }, item))),
          ) : null,
          analysis.culturalNoteZh ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '文化与礼仪'),
            h('div', { className: 'idojo-small' }, analysis.culturalNoteZh),
          ) : null,
          hasModelAnswer ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '参考回答'),
            h('div', { className: 'idojo-answer-block' },
              showJp && analysis.modelAnswerJp ? h('div', { className: 'idojo-answer-label' }, '日本語') : null,
              showJp && analysis.modelAnswerJp ? h('div', { className: 'idojo-jp is-answer' }, h(Highlight, { text: analysis.modelAnswerJp, vocabulary: analysis.vocabulary })) : null,
              showZh && analysis.modelAnswerZh ? h('div', { className: 'idojo-zh' }, analysis.modelAnswerZh) : null,
            ),
          ) : null,
        ),
      )
    }

    function EvaluationCard({ evaluation, showJp = true, showZh = true }) {
      if (!evaluation) return null
      const showCorrection = showJp && (evaluation.correctedJp || evaluation.naturalJp)
      const showModel = (showJp && evaluation.modelAnswerJp) || (showZh && evaluation.modelAnswerZh)
      const score = Number(evaluation.score) || 0
      const tone = score >= 80 ? 'is-good' : score >= 60 ? 'is-mid' : 'is-low'
      return h('div', { className: 'idojo-eval' },
        h('div', { className: 'idojo-eval-head' },
          h('div', { className: `idojo-score ${tone}` }, score),
          h('div', { className: 'idojo-eval-verdict' },
            h('strong', null, '回答反馈'),
            h('p', null, evaluation.verdictZh || '已收到你的回答。'),
          ),
        ),
        h('div', { className: 'idojo-eval-grid' },
          evaluation.strengthsZh?.length ? h('div', { className: 'idojo-eval-col' },
            h('h5', null, '做得好的地方'),
            h('ul', { className: 'idojo-list is-plain' }, evaluation.strengthsZh.map((item, index) => h('li', { key: index },
              h('span', { className: 'idojo-check' }, '✓'),
              h('span', null, item),
            ))),
          ) : null,
          evaluation.improvementsZh?.length ? h('div', { className: 'idojo-eval-col' },
            h('h5', null, '可以改进'),
            h('ul', { className: 'idojo-list is-plain' }, evaluation.improvementsZh.map((item, index) => h('li', { key: index },
              h('span', { className: 'idojo-warning-mark' }, '△'),
              h('span', null, item),
            ))),
          ) : null,
        ),
        showCorrection ? h('div', { className: 'idojo-section' },
          h('h4', { className: 'idojo-section-title' }, '日语修正'),
          evaluation.correctedJp ? h('div', { className: 'idojo-answer-block' },
            h('div', { className: 'idojo-answer-label' }, '自然な日本語'),
            h('div', { className: 'idojo-jp is-answer' }, evaluation.correctedJp),
          ) : null,
          evaluation.naturalJp && evaluation.naturalJp !== evaluation.correctedJp ? h('div', { className: 'idojo-small idojo-mt8' }, evaluation.naturalJp) : null,
        ) : null,
        showModel ? h('details', { className: 'idojo-details' },
          h('summary', null, '这一题的参考回答'),
          h('div', { className: 'idojo-details-body' },
            h('div', { className: 'idojo-section' },
              showJp && evaluation.modelAnswerJp ? h('div', { className: 'idojo-jp is-answer' }, evaluation.modelAnswerJp) : null,
              showZh && evaluation.modelAnswerZh ? h('div', { className: 'idojo-zh' }, evaluation.modelAnswerZh) : null,
            ),
          ),
        ) : null,
        (evaluation.contentNotesZh?.length || evaluation.languageNotesZh?.length) ? h('div', { className: 'idojo-eval-grid' },
          evaluation.contentNotesZh?.length ? h('div', { className: 'idojo-eval-col' },
            h('h5', null, '内容建议'),
            h('ul', { className: 'idojo-list' }, evaluation.contentNotesZh.map((item, index) => h('li', { key: index }, item))),
          ) : null,
          evaluation.languageNotesZh?.length ? h('div', { className: 'idojo-eval-col' },
            h('h5', null, '语言建议'),
            h('ul', { className: 'idojo-list' }, evaluation.languageNotesZh.map((item, index) => h('li', { key: index }, item))),
          ) : null,
        ) : null,
      )
    }

    function TurnCard({ session, turn, isLast, busy, showJp = true, showZh = true }) {
      const pending = !turn.answer
      const opening = turn.n === 1 ? session.opening : null
      const showReaction = (showJp && turn.reactionJp) || (showZh && turn.reactionZh)
      const showOpening = (showJp && opening?.openingJp) || (showZh && opening?.openingZh)
      const questionLines = []
      if (showJp && turn.question.jp) {
        questionLines.push(h('div', { className: 'idojo-jp', key: 'jp' }, h(Highlight, { text: turn.question.jp, vocabulary: turn.analysis?.vocabulary })))
      }
      if (showZh && turn.question.zh) {
        questionLines.push(h('div', { className: 'idojo-zh', key: 'zh' }, turn.question.zh))
      }
      if (questionLines.length === 0) {
        questionLines.push(h('div', { className: 'idojo-hint', key: 'hidden' }, '日文与中文均已隐藏。可在上方「显示选项」中重新开启。'))
      }
      return h('article', {
        className: 'idojo-turn',
        'aria-live': isLast ? 'polite' : undefined,
        'aria-atomic': isLast ? 'false' : undefined,
      },
        showReaction ? h('div', { className: 'idojo-reaction' },
          h('div', null,
            showJp && turn.reactionJp ? h('div', { className: 'idojo-jp is-answer' }, turn.reactionJp) : null,
            showZh && turn.reactionZh ? h('div', { className: 'idojo-zh', style: { borderTop: 0, marginTop: 2, paddingTop: 0 } }, turn.reactionZh) : null,
          ),
        ) : null,
        h('div', { className: 'idojo-speaker' },
          h('span', { className: 'idojo-avatar' }, '面'),
          h('span', { className: 'idojo-speaker-name' }, '面试官'),
          h('span', { className: 'idojo-speaker-time' }, `第 ${turn.n} 问`),
        ),
        showOpening ? h('div', { className: 'idojo-bubble is-opening', style: { marginBottom: '7px' } },
          showJp && opening?.openingJp ? h('div', { className: 'idojo-jp is-answer' }, opening.openingJp) : null,
          showZh && opening?.openingZh ? h('div', { className: 'idojo-zh' }, opening.openingZh) : null,
        ) : null,
        h('div', { className: 'idojo-bubble' },
          questionLines,
          h('div', { className: 'idojo-meta', style: { marginTop: '7px' } },
            h(Badge, { tone: turn.question.schoolSpecific ? 'school' : 'common' }, turn.question.schoolSpecific ? '本校专属' : '共通'),
            h(Badge, null, turn.question.category),
            turn.question.followUp ? h(Badge, { tone: 'outline' }, '追问') : null,
            h(Difficulty, { value: turn.question.difficulty }),
          ),
          turn.question.sourceNote ? h('div', { className: 'idojo-hint idojo-mt8' }, `依据：${turn.question.sourceNote}`) : null,
          h(InlineSources, { ids: turn.question.sourceIds, sources: session.research?.sources }),
          turn.analysis?.vocabulary?.length ? h('div', { className: 'idojo-chips' },
            turn.analysis.vocabulary.slice(0, 4).map((item, index) => h('span', {
              className: 'idojo-chip',
              key: `${item.word}-${index}`,
              title: [item.reading, item.meaningZh].filter(Boolean).join(' · '),
            }, `${item.word}${item.reading ? `（${item.reading}）` : ''}${item.meaningZh ? ` · ${item.meaningZh}` : ''}`)),
          ) : null,
          h(AnalysisDetails, { analysis: turn.analysis, showJp, showZh }),
        ),
        turn.answer ? h('div', { className: 'idojo-turn', style: { marginTop: '9px', marginBottom: 0 } },
          h('div', { className: 'idojo-speaker' },
            h('span', { className: 'idojo-avatar is-user' }, '你'),
            h('span', { className: 'idojo-speaker-name' }, '你的回答'),
            turn.answeredAt ? h('span', { className: 'idojo-speaker-time' }, formatClock(turn.answeredAt)) : null,
          ),
          h('div', { className: 'idojo-bubble is-user' },
            h('div', { className: 'idojo-jp is-answer' }, turn.answer),
          ),
          h(EvaluationCard, { evaluation: turn.evaluation, showJp, showZh }),
        ) : pending ? h('div', { className: 'idojo-pending idojo-mt8' },
          isLast && busy === 'answer'
            ? [h('span', { key: 's', className: 'idojo-spinner' }), '面试官正在准备反馈和下一题…']
            : [h('span', { key: 'd', className: 'idojo-live-dot' }), isLast ? '轮到你回答。开启语音模式后，可以直接说日语。' : '等待回答'],
        ) : null,
      )
    }

    function ReportView({
      session,
      onRestart,
      onClear,
      onArchive,
      onArchiveMarkdown,
      onArchiveNew,
      lastArchive,
      showJp,
      showZh,
      onToggleJp,
      onToggleZh,
    }) {
      const report = session.finalReport
      if (!report) return h('div', { className: 'idojo-empty' }, '这份记录还没有生成面试报告。')
      const score = Number(report.overallScore) || 0
      const tone = score >= 80 ? 'is-good' : score >= 60 ? 'is-mid' : 'is-low'
      return h('div', { className: 'idojo-narrow' },
        h('div', { className: 'idojo-report-score' },
          h('div', { className: `idojo-score ${tone}` }, score),
          h('div', null,
            h('div', { className: 'idojo-report-kicker' }, '模拟面试总评'),
            h('h2', { className: 'idojo-report-title' }, `${session.setup?.university || '目标大学'} · 面试报告`),
            h('div', { className: 'idojo-muted idojo-small' }, report.summaryZh || ''),
          ),
        ),
        h(DisplayToggles, { showJp, showZh, onToggleJp, onToggleZh }),
        lastArchive && lastArchive.sessionId === session.id ? h('div', { className: 'idojo-archive-note' },
          h('strong', null, '已存档到本机'),
          h('div', { className: 'idojo-small' }, lastArchive.directory),
          h('div', { className: 'idojo-small' }, `Word：${lastArchive.doc} · Markdown：${lastArchive.markdown}`),
        ) : null,
        report.summaryZh ? h('div', { className: 'idojo-card idojo-mt10' },
          h('h3', { className: 'idojo-card-title' }, '总评'),
          h('p', { style: { margin: '5px 0 0' } }, report.summaryZh),
        ) : null,
        h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '做得好的地方'),
          report.strengthsZh?.length
            ? h('ul', { className: 'idojo-list is-plain' }, report.strengthsZh.map((item, index) => h('li', { key: index },
              h('span', { className: 'idojo-check' }, '✓'), h('span', null, item),
            )))
            : h('p', { className: 'idojo-hint' }, '暂无。'),
        ),
        h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '优先改进'),
          report.improvementsZh?.length
            ? h('ul', { className: 'idojo-list' }, report.improvementsZh.map((item, index) => h('li', { key: index }, item)))
            : h('p', { className: 'idojo-hint' }, '暂无。'),
        ),
        report.universityFitZh ? h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '与这所大学的匹配度'),
          h('p', { style: { margin: 0 } }, report.universityFitZh),
        ) : null,
        report.languageNotesZh?.length ? h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '日语表达总结'),
          h('ul', { className: 'idojo-list' }, report.languageNotesZh.map((item, index) => h('li', { key: index }, item))),
        ) : null,
        report.nextStepsZh?.length ? h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '下一步练习'),
          h('ol', { className: 'idojo-list' }, report.nextStepsZh.map((item, index) => h('li', { key: index }, item))),
        ) : null,
        report.keyVocabulary?.length ? h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '本场重点词汇'),
          h(VocabTable, { vocabulary: report.keyVocabulary }),
        ) : null,
        h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '存档与开始新练习'),
          h('p', { className: 'idojo-hint' }, '存档会保存完整对话、逐题解析、词汇语法清单和面试报告，并下载 Word 兼容文档。'),
          h('div', { className: 'idojo-actions' },
            h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: onArchive }, '存档为 Word'),
            h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: onArchiveNew }, '存档并新建'),
            h('button', { type: 'button', className: 'idojo-btn', onClick: onArchiveMarkdown }, '下载 Markdown'),
            h('button', { type: 'button', className: 'idojo-btn', onClick: onRestart }, '同一套资料再练一次'),
            h('button', { type: 'button', className: 'idojo-btn is-danger', onClick: onClear }, '清空并新建'),
          ),
        ),
        h('details', { className: 'idojo-details' },
          h('summary', null, '查看已回答的对话与逐题反馈'),
          h('div', { className: 'idojo-details-body' },
            session.turns
              .filter((turn) => turn.answer)
              .map((turn) => h(TurnCard, { key: turn.n, session, turn, isLast: false, busy: null, showJp, showZh })),
          ),
        ),
        h('p', { className: 'idojo-footer-note' }, '报告由模型根据本场回答生成，仅用于练习；正式面试请以学校最新募集要项和实际安排为准。'),
      )
    }

    // ------------------------------------------------------------------
    // Main panel
    // ------------------------------------------------------------------

    function SetupStepper({ step, setupReady, statementReady, onStep1, onStep2, onStep3 }) {
      const steps = [
        { id: 1, label: '目标大学', hint: '大学与专业', done: setupReady, onClick: onStep1 },
        { id: 2, label: '入学理由书', hint: '上传或粘贴', done: statementReady, onClick: onStep2 },
        { id: 3, label: '生成资料', hint: '题库与面试', done: false, onClick: onStep3 },
      ]
      return h('div', { className: 'idojo-stepper', 'aria-label': '使用步骤' },
        steps.map((item, index) => h(React.Fragment, { key: item.id },
          h('button', {
            type: 'button',
            className: `idojo-step${step === item.id ? ' is-active' : ''}${item.done ? ' is-done' : ''}`,
            onClick: item.onClick,
            'aria-current': step === item.id ? 'step' : undefined,
          },
            h('span', { className: 'idojo-step-num' }, item.done ? '✓' : item.id),
            h('span', { className: 'idojo-step-copy' },
              h('span', { className: 'idojo-step-label' }, item.label),
              h('span', { className: 'idojo-step-hint' }, item.hint),
            ),
          ),
          index < steps.length - 1 ? h('span', { className: 'idojo-step-line', 'aria-hidden': true }) : null,
        )),
      )
    }

    function DisplayToggles({ showJp, showZh, onToggleJp, onToggleZh }) {
      return h('div', { className: 'idojo-display-bar' },
        h('span', { className: 'idojo-display-label' }, '显示选项'),
        h('button', {
          type: 'button',
          className: `idojo-toggle${showJp ? ' is-on' : ''}`,
          onClick: onToggleJp,
          'aria-pressed': showJp,
          title: '显示或隐藏面试官问题、参考回答的日文原文',
        }, '日文原文'),
        h('button', {
          type: 'button',
          className: `idojo-toggle${showZh ? ' is-on' : ''}`,
          onClick: onToggleZh,
          'aria-pressed': showZh,
          title: '显示或隐藏面试官问题、参考回答的中文翻译',
        }, '中文翻译'),
        !showJp && !showZh ? h('span', { className: 'idojo-hint' }, '已隐藏全部对话原文') : null,
      )
    }

    function OnboardingBanner({ onStart, onSample, started }) {
      return h('section', { className: `idojo-onboard${started ? ' is-compact' : ''}` },
        h('div', { className: 'idojo-onboard-main' },
          h('div', { className: 'idojo-onboard-icon' }, h(ToriiIcon, { size: 26 })),
          h('div', { className: 'idojo-onboard-copy' },
            h('div', { className: 'idojo-kicker' }, started ? '继续准备' : '第一次使用？'),
            h('h2', null, started ? '按步骤完成，就可以开始面试' : '3 步，开始你的日本留学模拟面试'),
            h('p', null, '① 填写目标大学与专业 → ② 放入入学理由书 → ③ 生成资料并开始。每一步都有提示，照着点就可以。'),
            h('div', { className: 'idojo-onboard-steps' },
              h('span', null, '1  目标大学'),
              h('span', { className: 'idojo-onboard-arrow' }, '→'),
              h('span', null, '2  理由书'),
              h('span', { className: 'idojo-onboard-arrow' }, '→'),
              h('span', null, '3  生成并面试'),
            ),
          ),
        ),
        h('div', { className: 'idojo-onboard-actions' },
          h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: onStart }, '开始填写'),
          h('button', { type: 'button', className: 'idojo-btn', onClick: onSample }, '填入示例试试看'),
        ),
      )
    }

    class DojoErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        console.error('[interview-dojo] panel render failed', error, info)
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'idojo-root' },
            h('div', { className: 'idojo-crash' },
              h('div', { className: 'idojo-brand-mark' }, h(ToriiIcon, { size: 21 })),
              h('h2', null, '面试道场界面加载失败'),
              h('p', null, '不是你的操作问题。请刷新页面后再打开；如果仍然失败，请把下面的错误信息反馈给插件作者。'),
              h('pre', null, errorText(this.state.error)),
              h('div', { className: 'idojo-actions' },
                h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: () => window.location.reload() }, '刷新页面'),
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    function SafeDojoPanel(props) {
      return h(DojoErrorBoundary, null, h(DojoPanel, props))
    }

    function InterviewSettingsCard() {
      const open = () => {
        if (runtimeContext) openPanel(runtimeContext)
      }
      return h('div', { className: 'idojo-settings-card' },
        h('div', { className: 'idojo-settings-head' },
          h('div', { className: 'idojo-brand-mark' }, h(ToriiIcon, { size: 21 })),
          h('div', null,
            h('h3', null, '面试道场'),
            h('p', null, '日本留学面试实时语音模拟'),
          ),
        ),
        h('p', { className: 'idojo-small' }, '填写目标大学、专业和入学理由书，插件会检索官网、生成题库，并用日语进行带解析的模拟面试。'),
        h('ol', { className: 'idojo-list' },
          h('li', null, '点击下方「打开右侧栏面试道场」，或从对话主区域上方的「面试道场」标签进入。'),
          h('li', null, '按 1 → 2 → 3 三步填写；不知道填什么可以点「填入示例试试看」。'),
          h('li', null, '生成资料后开始面试；语音默认开启并免提，面试官朗读完会自动听你回答。'),
        ),
        h('div', { className: 'idojo-actions idojo-mt10' },
          h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: open }, '打开右侧栏面试道场'),
          h('button', { type: 'button', className: 'idojo-btn', onClick: () => window.location.reload() }, '刷新界面'),
        ),
        h('p', { className: 'idojo-footer-note' }, '若右侧栏没有入口，请刷新一次页面，让新插件的浏览器端加载。'),
      )
    }

    function DojoPanel() {
      const [booted, setBooted] = useState(false)
      const [health, setHealth] = useState(null)
      const [bootError, setBootError] = useState('')
      const [setup, setSetup] = useState(() => ({ ...DEFAULT_SETUP, ...readSaved(STORAGE.setup, {}) }))
      const [statement, setStatement] = useState(() => ({ ...EMPTY_STATEMENT, ...readSaved(STORAGE.statement, {}) }))
      const [modelSelection, setModelSelection] = useState(() => readSaved(STORAGE.model, { provider: '', model: '' }))
      const [research, setResearch] = useState(null)
      const [researchSetup, setResearchSetup] = useState(null)
      const [session, setSession] = useState(null)
      const [lastArchive, setLastArchive] = useState(null)
      const [tab, setTab] = useState('chat')
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [answerDraft, setAnswerDraft] = useState('')
      const [hint, setHint] = useState(null)
      const [dragOver, setDragOver] = useState(false)
      const [showJp, setShowJp] = useState(() => readSaved(STORAGE.display, {}).jp !== false)
      const [showZh, setShowZh] = useState(() => readSaved(STORAGE.display, {}).zh !== false)
      const [voiceMode, setVoiceMode] = useState(() => readSaved(STORAGE.voice, {}).mode !== false)
      const [handsFree, setHandsFree] = useState(() => readSaved(STORAGE.voice, {}).handsFree !== false)
      const [speakQuestions, setSpeakQuestions] = useState(() => readSaved(STORAGE.voice, {}).speakQuestions !== false)
      const [autoSend, setAutoSend] = useState(() => readSaved(STORAGE.voice, {}).autoSend !== false)
      const [ttsEngine, setTtsEngine] = useState(() => readSaved(STORAGE.voice, {}).ttsEngine === 'system' ? 'system' : 'edge')
      const [edgeVoice, setEdgeVoice] = useState(() => asText(readSaved(STORAGE.voice, {}).edgeVoice) || 'ja-JP-NanamiNeural')
      const [speechEngine, setSpeechEngine] = useState(() => {
        const saved = readSaved(STORAGE.voice, {}).engine
        return saved === 'browser' || saved === 'local' ? saved : 'auto'
      })
      const [voiceRate, setVoiceRate] = useState(() => Number(readSaved(STORAGE.voice, {}).rate) || 1)
      const [voiceURI, setVoiceURI] = useState(() => asText(readSaved(STORAGE.voice, {}).voiceURI))
      const [voices, setVoices] = useState([])
      const [speaking, setSpeaking] = useState(false)
      const [listening, setListening] = useState(false)
      const [localRecording, setLocalRecording] = useState(false)
      const [localTranscribing, setLocalTranscribing] = useState(false)
      const [localElapsed, setLocalElapsed] = useState(0)
      const [localSpeech, setLocalSpeech] = useState(null)
      const [liveTranscript, setLiveTranscript] = useState('')
      const [voiceError, setVoiceError] = useState('')

      const fileInputRef = useRef(null)
      const universityInputRef = useRef(null)
      const statementSectionRef = useRef(null)
      const generationSectionRef = useRef(null)
      const scrollRef = useRef(null)
      const recognitionRef = useRef(null)
      const recognitionGenerationRef = useRef(0)
      const silenceTimerRef = useRef(null)
      const listenMaxTimerRef = useRef(null)
      const submitOnEndRef = useRef(false)
      const mediaRecorderRef = useRef(null)
      const mediaStreamRef = useRef(null)
      const audioChunksRef = useRef([])
      const localTimerRef = useRef(null)
      const localStartRef = useRef(0)
      const cancelLocalRecordingRef = useRef(false)
      const localStartingRef = useRef(false)
      const localStartTokenRef = useRef(0)
      const localRecordingTokenRef = useRef(0)
      const aliveRef = useRef(true)
      const ttsContextRef = useRef(null)
      const ttsSourceRef = useRef(null)
      const speechSeqRef = useRef(0)
      const handsFreeRef = useRef(true)
      const voiceModeRef = useRef(voiceMode)
      const speakingRef = useRef(false)
      const sessionRef = useRef(session)
      const currentTurnRef = useRef(null)
      const answerDraftRef = useRef(answerDraft)
      const hintRef = useRef(hint)
      const listeningRef = useRef(false)
      const localRecordingRef = useRef(false)
      const localTranscribingRef = useRef(false)
      const autoListenTimerRef = useRef(null)
      const startHandsFreeRef = useRef(null)
      const maybeAutoListenRef = useRef(null)
      const vadSourceRef = useRef(null)
      const vadTimerRef = useRef(null)
      const finalRef = useRef('')
      const interimRef = useRef('')
      const suppressAutoSendRef = useRef(false)
      const autoSendRef = useRef(autoSend)
      const busyRef = useRef(busy)
      const voiceUnlockedRef = useRef(false)
      const spokeKeyRef = useRef('')
      const sendAnswerRef = useRef(null)
      const lastSessionIdRef = useRef('')

      const recognitionSupported = speechRecognitionCtor() !== undefined
      const ttsSupported = canSpeakJapanese()
      const japaneseVoices = useMemo(() => voices.filter((voice) => /^ja/i.test(voice.lang || '')), [voices])
      const localReady = Boolean(localSpeech?.available && localSpeech?.provider)
      const localProviderName = localSpeech?.provider?.name ?? '本机 SenseVoice'
      const edgeReady = health?.voice?.tts?.edge === true
      const edgeVoices = health?.voice?.tts?.voices ?? [
        { id: 'ja-JP-NanamiNeural', name: '七海（女声，自然）' },
        { id: 'ja-JP-KeitaNeural', name: '圭太（男声，自然）' },
      ]
      const naturalTts = ttsEngine === 'edge' && edgeReady

      useEffect(() => {
        if (!health) return
        if (health.voice?.tts?.edge !== true && ttsEngine === 'edge') setTtsEngine('system')
      }, [health, ttsEngine])
      const effectiveEngine = speechEngine === 'browser'
        ? (recognitionSupported ? 'browser' : null)
        : speechEngine === 'local'
          ? (localReady ? 'local' : null)
          : recognitionSupported
            ? 'browser'
            : (localReady ? 'local' : null)
      const voiceActive = listening || localRecording
      const currentTurn = session?.turns?.[session.turns.length - 1] ?? null
      const answeredCount = session?.turns?.filter((turn) => turn.answer).length ?? 0
      const view = !booted
        ? 'boot'
        : session
          ? (session.status === 'finished' || session.finalReport ? 'report' : 'interview')
          : research
            ? 'review'
            : 'setup'
      const stale = isResearchStale(researchSetup, setup)
      const setupStarted = Boolean(asText(setup.university).trim() || asText(setup.faculty).trim() || asText(setup.major).trim())
      const setupReady = Boolean(asText(setup.university).trim())
      const statementReady = Boolean(asText(statement.text).trim())
      const activeSetupStep = !setupReady ? 1 : !statementReady ? 2 : 3

      useEffect(() => {
        autoSendRef.current = autoSend
      }, [autoSend])

      useEffect(() => {
        busyRef.current = busy
      }, [busy])

      useEffect(() => {
        handsFreeRef.current = handsFree
      }, [handsFree])

      useEffect(() => {
        voiceModeRef.current = voiceMode
      }, [voiceMode])

      useEffect(() => {
        speakingRef.current = speaking
      }, [speaking])

      useEffect(() => {
        sessionRef.current = session
      }, [session])

      useEffect(() => {
        currentTurnRef.current = currentTurn
      }, [currentTurn])

      useEffect(() => {
        answerDraftRef.current = answerDraft
      }, [answerDraft])

      useEffect(() => {
        hintRef.current = hint
      }, [hint])

      useEffect(() => {
        listeningRef.current = listening
      }, [listening])

      useEffect(() => {
        localRecordingRef.current = localRecording
      }, [localRecording])

      useEffect(() => {
        localTranscribingRef.current = localTranscribing
      }, [localTranscribing])

      useEffect(() => {
        if (!notice) return undefined
        const timer = window.setTimeout(() => setNotice(''), 7000)
        return () => window.clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (view !== 'interview' || tab !== 'chat') return undefined
        const container = scrollRef.current
        if (!container) return undefined
        const timer = window.setTimeout(() => {
          container.scrollTop = container.scrollHeight
        }, 90)
        return () => window.clearTimeout(timer)
      }, [busy, hint, session?.turns?.length, tab, view])

      useEffect(() => {
        writeSaved(STORAGE.setup, setup)
      }, [setup])

      useEffect(() => {
        writeSaved(STORAGE.statement, statement)
      }, [statement])

      useEffect(() => {
        writeSaved(STORAGE.model, modelSelection)
      }, [modelSelection])

      useEffect(() => {
        writeSaved(STORAGE.display, { jp: showJp, zh: showZh })
      }, [showJp, showZh])

      useEffect(() => {
        writeSaved(STORAGE.voice, {
          mode: voiceMode,
          handsFree,
          speakQuestions,
          autoSend,
          ttsEngine,
          edgeVoice,
          engine: speechEngine,
          rate: voiceRate,
          voiceURI,
        })
      }, [voiceMode, handsFree, speakQuestions, autoSend, ttsEngine, edgeVoice, speechEngine, voiceRate, voiceURI])

      useEffect(() => {
        if (!ttsSupported) return undefined
        const load = () => {
          try {
            setVoices(window.speechSynthesis.getVoices())
          } catch {
            setVoices([])
          }
        }
        load()
        window.speechSynthesis.addEventListener?.('voiceschanged', load)
        return () => {
          window.speechSynthesis.removeEventListener?.('voiceschanged', load)
        }
      }, [ttsSupported])

      useEffect(() => {
        let disposed = false
        const boot = async () => {
          try {
            const healthPayload = await api('/health', { timeoutMs: 20000 })
            if (disposed) return
            setHealth(healthPayload)
            setLocalSpeech(healthPayload.voice?.local ?? null)
            if (healthPayload.voice?.local === undefined) {
              api('/voice/status', { timeoutMs: 15000 }).then((payload) => {
                if (!disposed) setLocalSpeech(payload.voice ?? null)
              }).catch(() => {})
            }
            let savedSession = null
            const savedIdRaw = (() => {
              try { return window.localStorage.getItem(STORAGE.session) ?? '' } catch { return '' }
            })()
            const newSessionMarker = savedIdRaw === 'none'
            if (!newSessionMarker) {
              try {
                const latest = await api('/session/latest', { timeoutMs: 20000 })
                savedSession = latest.session ?? null
              } catch (error) {
                if (!disposed) setBootError(errorText(error))
              }
            }
            if (!newSessionMarker && savedIdRaw && (!savedSession || savedSession.id !== savedIdRaw)) {
              try {
                const response = await api(`/session/${encodeURIComponent(savedIdRaw)}`, { timeoutMs: 20000 })
                savedSession = response.session ?? savedSession
              } catch {
                // Fall back to the latest valid session.
              }
            }
            if (disposed) return
            const providers = healthPayload.llm?.providers ?? []
            const firstModel = providers[0]?.models?.[0]
            const choose = (candidate) => {
              if (!candidate?.provider || !candidate?.model) return false
              if (providers.length === 0) return true
              const provider = providers.find((entry) => entry.id === candidate.provider)
              return provider !== undefined && provider.models.some((entry) => entry.id === candidate.model)
            }
            const current = healthPayload.llm?.current
            const savedModel = readSaved(STORAGE.model, { provider: '', model: '' })
            let selection = savedModel
            if (!choose(selection)) selection = current
            if (!choose(selection)) selection = savedSession?.model
            if (!choose(selection) && firstModel) selection = { provider: providers[0].id, model: firstModel.id }
            if (!selection) selection = { provider: '', model: '' }
            setModelSelection(selection)
            if (savedSession) {
              setSession(savedSession)
              setResearch(savedSession.research ?? null)
              setResearchSetup(savedSession.setup ?? null)
              setSetup((previous) => ({ ...previous, ...(savedSession.setup ?? {}) }))
              setStatement({
                text: savedSession.statement ?? '',
                filename: savedSession.statementFilename ?? '',
                kind: savedSession.statementKind ?? '',
                warnings: Array.isArray(savedSession.statementWarnings) ? savedSession.statementWarnings : [],
                chars: (savedSession.statement ?? '').length,
              })
              if (savedSession.model && choose(savedSession.model)) setModelSelection(savedSession.model)
              if (readSaved(STORAGE.voice, {}).mode !== false) voiceUnlockedRef.current = true
              try { window.localStorage.setItem(STORAGE.session, savedSession.id) } catch { /* ignore */ }
              lastSessionIdRef.current = savedSession.id
            }
          } catch (error) {
            if (!disposed) setBootError(errorText(error))
          } finally {
            if (!disposed) setBooted(true)
          }
        }
        boot()
        return () => {
          disposed = true
        }
      }, [])

      useEffect(() => {
        const id = session?.id ?? ''
        if (id === '') return
        if (id !== lastSessionIdRef.current) {
          lastSessionIdRef.current = id
          try { window.localStorage.setItem(STORAGE.session, id) } catch { /* ignore */ }
        }
      }, [session?.id])

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
          recognitionGenerationRef.current += 1
          cancelLocalRecordingRef.current = true
          try { recognitionRef.current?.abort?.() } catch { /* ignore */ }
          try {
            if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop()
          } catch { /* ignore */ }
          try {
            mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop())
          } catch { /* ignore */ }
          if (localTimerRef.current) window.clearInterval(localTimerRef.current)
          if (autoListenTimerRef.current) window.clearTimeout(autoListenTimerRef.current)
          if (vadTimerRef.current) window.clearTimeout(vadTimerRef.current)
          try { ttsSourceRef.current?.stop?.() } catch { /* ignore */ }
          try { vadSourceRef.current?.disconnect?.() } catch { /* ignore */ }
          try { void ttsContextRef.current?.close?.() } catch { /* ignore */ }
          if (ttsSupported) {
            try { window.speechSynthesis.cancel() } catch { /* ignore */ }
          }
        }
      }, [ttsSupported])

      const ensureTtsContext = useCallback(() => {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return null
        if (!ttsContextRef.current || ttsContextRef.current.state === 'closed') {
          ttsContextRef.current = new Ctor()
        }
        return ttsContextRef.current
      }, [])

      const unlockTtsAudio = useCallback(() => {
        try {
          const context = ensureTtsContext()
          if (context && context.state === 'suspended') {
            void context.resume().catch(() => {})
          }
        } catch {
          // The first real synthesis attempt will report a useful error.
        }
      }, [ensureTtsContext])

      const stopSpeaking = useCallback(() => {
        speechSeqRef.current += 1
        const source = ttsSourceRef.current
        ttsSourceRef.current = null
        if (source) {
          try { source.stop() } catch { /* already ended */ }
        }
        if (ttsSupported) {
          try { window.speechSynthesis.cancel() } catch { /* ignore */ }
        }
        setSpeaking(false)
      }, [ttsSupported])

      const speakWithSystemVoice = useCallback((text, seq) => {
        if (!ttsSupported) {
          if (seq === speechSeqRef.current) {
            setSpeaking(false)
            setVoiceError('系统语音不可用，请直接在「语音设置」中改用文字输入。')
          }
          return
        }
        try {
          window.speechSynthesis.cancel()
          const utterance = new window.SpeechSynthesisUtterance(text)
          utterance.lang = 'ja-JP'
          utterance.rate = voiceRate
          const selected = japaneseVoices.find((voice) => voice.voiceURI === voiceURI) ?? japaneseVoices[0]
          if (selected) utterance.voice = selected
          utterance.onstart = () => {
            if (seq === speechSeqRef.current) setSpeaking(true)
          }
          utterance.onend = () => {
            if (seq !== speechSeqRef.current) return
            setSpeaking(false)
            maybeAutoListenRef.current?.(500)
          }
          utterance.onerror = () => {
            if (seq !== speechSeqRef.current) return
            setSpeaking(false)
            setVoiceError('系统语音朗读失败；你仍可以看文字或点「朗读问题」重试。')
          }
          window.speechSynthesis.speak(utterance)
        } catch (error) {
          if (seq === speechSeqRef.current) {
            setSpeaking(false)
            setVoiceError(`系统语音朗读失败：${errorText(error)}`)
          }
        }
      }, [japaneseVoices, ttsSupported, voiceRate, voiceURI])

      const speakJapanese = useCallback((rawText) => {
        const text = asText(rawText).trim()
        if (text === '') return
        stopSpeaking()
        const seq = speechSeqRef.current + 1
        speechSeqRef.current = seq

        if (!naturalTts) {
          speakWithSystemVoice(text, seq)
          return
        }

        // Natural Edge neural voice: synthesize on the host, decode, and play
        // through Web Audio. The context is resumed on the start/replay click,
        // so later turns do not depend on a fresh autoplay gesture.
        const context = ensureTtsContext()
        if (!context) {
          setVoiceError('当前环境不支持高质量音频播放，已切换系统语音。')
          setTtsEngine('system')
          speakWithSystemVoice(text, seq)
          return
        }
        setSpeaking(true)
        void context.resume().then(() => {
          if (context.state !== 'running') throw new Error('浏览器尚未允许播放音频')
          return api('/tts', {
            method: 'POST',
            body: {
              text,
              voice: edgeVoice,
              rate: Math.round((voiceRate - 1) * 100) - 5,
            },
            timeoutMs: 90000,
          })
        }).then(async (response) => {
          if (seq !== speechSeqRef.current) return
          if (typeof response.audioBase64 !== 'string' || response.audioBase64 === '') {
            throw new Error('自然语音返回为空')
          }
          const bytes = base64ToBytes(response.audioBase64)
          const buffer = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
          if (seq !== speechSeqRef.current) return
          const source = context.createBufferSource()
          source.buffer = buffer
          source.connect(context.destination)
          ttsSourceRef.current = source
          source.onended = () => {
            if (seq !== speechSeqRef.current) return
            ttsSourceRef.current = null
            setSpeaking(false)
            maybeAutoListenRef.current?.(500)
          }
          source.start()
        }).catch((error) => {
          if (seq !== speechSeqRef.current) return
          ttsSourceRef.current = null
          setSpeaking(false)
          setVoiceError(`自然语音暂不可用，已切换系统语音：${errorText(error)}`)
          setTtsEngine('system')
          speakWithSystemVoice(text, seq)
        })
      }, [edgeVoice, ensureTtsContext, naturalTts, speakWithSystemVoice, stopSpeaking, voiceRate])

      useEffect(() => {
        if (!voiceMode || !speakQuestions || !voiceUnlockedRef.current || !session || !currentTurn || busy) return
        if (currentTurn.answer) return
        const key = `${session.id}:${currentTurn.n}`
        if (spokeKeyRef.current === key) return
        const text = questionSpeech(session, currentTurn)
        if (text.trim() === '') return
        spokeKeyRef.current = key
        speakJapanese(text)
      }, [busy, currentTurn, session, speakJapanese, speakQuestions, voiceMode])

      const stopListening = useCallback((options = {}) => {
        submitOnEndRef.current = options.submit === true
        if (silenceTimerRef.current) {
          window.clearTimeout(silenceTimerRef.current)
          silenceTimerRef.current = null
        }
        if (listenMaxTimerRef.current) {
          window.clearTimeout(listenMaxTimerRef.current)
          listenMaxTimerRef.current = null
        }
        const recognition = recognitionRef.current
        if (!recognition) return
        try {
          recognition.stop()
        } catch {
          // Some engines throw when stop arrives after end.
        }
      }, [])

      const startListening = useCallback(() => {
        unlockTtsAudio()
        if (!recognitionSupported) {
          setVoiceError('当前浏览器不支持语音识别。可以继续使用文字输入，或在 Chrome / Edge 中打开本页面。')
          return
        }
        if (!session || busyRef.current) return
        const Ctor = speechRecognitionCtor()
        if (!Ctor) return
        stopLocalRecording({ cancel: true })
        stopSpeaking()
        voiceUnlockedRef.current = true
        finalRef.current = ''
        interimRef.current = ''
        setLiveTranscript('')
        setVoiceError('')
        suppressAutoSendRef.current = false
        submitOnEndRef.current = false
        if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current)
        if (listenMaxTimerRef.current) window.clearTimeout(listenMaxTimerRef.current)
        const generation = recognitionGenerationRef.current + 1
        recognitionGenerationRef.current = generation
        const recognition = new Ctor()
        recognition.lang = 'ja-JP'
        recognition.continuous = true
        recognition.interimResults = true
        recognition.maxAlternatives = 1
        recognition.onresult = (event) => {
          if (generation !== recognitionGenerationRef.current) return
          let finalText = ''
          let interimText = ''
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const item = event.results[index]
            const transcript = item?.[0]?.transcript ?? ''
            if (item?.isFinal) finalText += transcript
            else interimText += transcript
          }
          if (finalText !== '') finalRef.current += finalText
          interimRef.current = interimText
          setLiveTranscript(`${finalRef.current}${interimText}`.trim())
          // A short pause ends the answer; continuous recognition itself does
          // not end on pauses in Chromium.
          if (silenceTimerRef.current) window.clearTimeout(silenceTimerRef.current)
          silenceTimerRef.current = window.setTimeout(() => {
            if (generation !== recognitionGenerationRef.current) return
            if (recognitionRef.current !== recognition) return
            stopListening({ submit: true })
          }, 3000)
        }
        recognition.onerror = (event) => {
          if (generation !== recognitionGenerationRef.current) return
          const code = event?.error ?? ''
          if (code === 'aborted') return
          submitOnEndRef.current = false
          if (silenceTimerRef.current) {
            window.clearTimeout(silenceTimerRef.current)
            silenceTimerRef.current = null
          }
          if (listenMaxTimerRef.current) {
            window.clearTimeout(listenMaxTimerRef.current)
            listenMaxTimerRef.current = null
          }
          const messages = {
            'not-allowed': '麦克风权限被拒绝。请点击地址栏的权限图标，允许本页面使用麦克风。',
            'service-not-allowed': '浏览器禁止了语音识别服务，请检查浏览器设置。',
            'no-speech': '没有听到声音，请靠近麦克风再说一次。',
            network: '浏览器语音识别服务暂时不可用（需要联网）。可以改用文字输入。',
            'audio-capture': '没有找到可用的麦克风。请检查系统输入设备。',
            'language-not-supported': '当前浏览器不支持日语识别，请改用文字输入。',
          }
          const canFallbackLocal = localReady
            && speechEngine === 'auto'
            && (code === 'network' || code === 'service-not-allowed' || code === 'language-not-supported')
          if (canFallbackLocal) {
            setSpeechEngine('local')
            setVoiceError('浏览器实时识别不可用，已自动切换到本机 SenseVoice；免提会在稍后自动开始录音，也可以点麦克风。')
            window.setTimeout(() => maybeAutoListenRef.current?.(700), 700)
          } else {
            setVoiceError(messages[code] || `语音识别失败：${code || '未知错误'}`)
          }
          setListening(false)
        }
        recognition.onend = () => {
          if (generation !== recognitionGenerationRef.current) return
          if (silenceTimerRef.current) {
            window.clearTimeout(silenceTimerRef.current)
            silenceTimerRef.current = null
          }
          if (listenMaxTimerRef.current) {
            window.clearTimeout(listenMaxTimerRef.current)
            listenMaxTimerRef.current = null
          }
          recognitionRef.current = null
          setListening(false)
          const finalText = finalRef.current.trim()
          const interimText = interimRef.current.trim()
          const shouldSubmit = submitOnEndRef.current
          submitOnEndRef.current = false
          const suppressed = suppressAutoSendRef.current
          suppressAutoSendRef.current = false
          if (suppressed) {
            setLiveTranscript('')
            return
          }
          if (finalText === '') {
            if (interimText !== '') {
              setLiveTranscript(interimText)
              setAnswerDraft(interimText)
              setVoiceError('只识别到片段，已填入输入框；请补全后发送。')
            }
            return
          }
          setLiveTranscript(finalText)
          setAnswerDraft(finalText)
          if (shouldSubmit && autoSendRef.current && !busyRef.current && sendAnswerRef.current) {
            sendAnswerRef.current(finalText)
          }
        }
        recognitionRef.current = recognition
        try {
          recognition.start()
          setListening(true)
          listenMaxTimerRef.current = window.setTimeout(() => {
            if (generation !== recognitionGenerationRef.current) return
            if (recognitionRef.current !== recognition) return
            setVoiceError('已经听了 60 秒，自动结束本次语音输入。')
            stopListening({ submit: true })
          }, 60000)
        } catch (error) {
          setVoiceError(`无法启动语音识别：${errorText(error)}`)
          setListening(false)
          recognitionRef.current = null
        }
      }, [localReady, recognitionSupported, session, speechEngine, stopSpeaking, unlockTtsAudio])

      const transcribeLocalBlob = useCallback(async (blob) => {
        setLocalTranscribing(true)
        setVoiceError('')
        try {
          const wav = await audioBlobToWav(blob)
          const response = await api('/transcribe', {
            method: 'POST',
            body: { audioBase64: bytesToBase64(wav) },
            timeoutMs: 120000,
          })
          const text = asText(response.text).trim()
          if (text === '') {
            setVoiceError('本机识别没有听清日语，请靠近麦克风再说一次，或改用文字输入。')
            return
          }
          setAnswerDraft(text)
          setLiveTranscript(text)
          if (autoSendRef.current && !busyRef.current && sendAnswerRef.current) {
            sendAnswerRef.current(text)
          }
        } catch (error) {
          setVoiceError(`本机识别失败：${errorText(error)}`)
        } finally {
          setLocalTranscribing(false)
        }
      }, [])

      const stopLocalVad = useCallback(() => {
        if (vadTimerRef.current) {
          window.clearTimeout(vadTimerRef.current)
          vadTimerRef.current = null
        }
        try { vadSourceRef.current?.disconnect?.() } catch { /* ignore */ }
        vadSourceRef.current = null
      }, [])

      const stopLocalRecording = useCallback((options = {}) => {
        const recorder = mediaRecorderRef.current
        stopLocalVad()
        localStartTokenRef.current += 1
        cancelLocalRecordingRef.current = options.cancel === true
        if (localTimerRef.current) {
          window.clearInterval(localTimerRef.current)
          localTimerRef.current = null
        }
        setLocalRecording(false)
        if (recorder && recorder.state !== 'inactive') {
          try {
            recorder.stop()
          } catch {
            try { mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop()) } catch { /* ignore */ }
            mediaRecorderRef.current = null
            mediaStreamRef.current = null
          }
        } else {
          try { mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop()) } catch { /* ignore */ }
          mediaRecorderRef.current = null
          mediaStreamRef.current = null
        }
      }, [stopLocalVad])

      const startLocalVad = useCallback((stream) => {
        stopLocalVad()
        const context = ensureTtsContext()
        if (!context) return
        try {
          const source = context.createMediaStreamSource(stream)
          const analyser = context.createAnalyser()
          analyser.fftSize = 512
          source.connect(analyser)
          vadSourceRef.current = source
          void context.resume().catch(() => {})
          const data = new Float32Array(analyser.fftSize)
          let heardSpeech = false
          let lastVoiceAt = Date.now()
          const startedAt = Date.now()
          const tick = () => {
            if (!aliveRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
              stopLocalVad()
              return
            }
            try {
              analyser.getFloatTimeDomainData(data)
              let sum = 0
              for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index]
              const rms = Math.sqrt(sum / data.length)
              const now = Date.now()
              if (rms > 0.025) {
                heardSpeech = true
                lastVoiceAt = now
              }
              if (heardSpeech && now - lastVoiceAt > 3000) {
                setVoiceError('')
                stopLocalRecording()
                return
              }
              if (!heardSpeech && now - startedAt > 18000) {
                setVoiceError('免提没有听到回答，已结束本次录音。点麦克风或直接输入也可以继续。')
                stopLocalRecording({ cancel: true })
                return
              }
            } catch {
              // An analyser failure should not leave the recorder running.
            }
            vadTimerRef.current = window.setTimeout(tick, 120)
          }
          tick()
        } catch {
          stopLocalVad()
        }
      }, [ensureTtsContext, stopLocalRecording, stopLocalVad])

      const startLocalRecording = useCallback(async () => {
        unlockTtsAudio()
        if (!localReady) {
          setVoiceError('本机日语识别模型未就绪。请先在 DSH 的语音输入设置中完成 SenseVoice 准备，或改用浏览器识别。')
          return
        }
        if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === 'undefined') {
          setVoiceError('当前浏览器不支持录音。请改用浏览器实时识别或文字输入。')
          return
        }
        if (localStartingRef.current) return
        localStartingRef.current = true
        const startToken = localStartTokenRef.current + 1
        localStartTokenRef.current = startToken
        stopSpeaking()
        suppressAutoSendRef.current = true
        recognitionGenerationRef.current += 1
        stopListening({ submit: false })
        recognitionRef.current = null
        setListening(false)
        setVoiceError('')
        setLiveTranscript('')
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          })
          mediaStreamRef.current = stream
          if (!aliveRef.current || startToken !== localStartTokenRef.current) {
            try { stream.getTracks().forEach((track) => track.stop()) } catch { /* ignore */ }
            mediaStreamRef.current = null
            return
          }
          const mimeType = preferredRecordingMime()
          const recorder = mimeType === ''
            ? new window.MediaRecorder(stream)
            : new window.MediaRecorder(stream, { mimeType })
          const recordingToken = localRecordingTokenRef.current + 1
          localRecordingTokenRef.current = recordingToken
          mediaRecorderRef.current = recorder
          audioChunksRef.current = []
          cancelLocalRecordingRef.current = false
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) audioChunksRef.current.push(event.data)
          }
          recorder.onerror = (event) => {
            setVoiceError(`录音失败：${event?.error?.message ?? '未知错误'}`)
            stopLocalRecording({ cancel: true })
          }
          recorder.onstop = () => {
            const cancelled = cancelLocalRecordingRef.current
            cancelLocalRecordingRef.current = false
            try { stream.getTracks().forEach((track) => track.stop()) } catch { /* ignore */ }
            if (recordingToken !== localRecordingTokenRef.current) return
            if (localTimerRef.current) {
              window.clearInterval(localTimerRef.current)
              localTimerRef.current = null
            }
            setLocalRecording(false)
            const chunks = audioChunksRef.current
            audioChunksRef.current = []
            mediaRecorderRef.current = null
            mediaStreamRef.current = null
            if (cancelled) return
            if (chunks.length === 0) {
              setVoiceError('没有录到声音，请检查麦克风后重试。')
              return
            }
            const type = recorder.mimeType || mimeType || 'audio/webm'
            const blob = new Blob(chunks, { type })
            void transcribeLocalBlob(blob)
          }
          recorder.start(250)
          localStartRef.current = Date.now()
          setLocalElapsed(0)
          setLocalRecording(true)
          if (handsFreeRef.current) startLocalVad(stream)
          localTimerRef.current = window.setInterval(() => {
            const seconds = (Date.now() - localStartRef.current) / 1000
            setLocalElapsed(seconds)
            if (seconds >= 75) stopLocalRecording()
          }, 250)
        } catch (error) {
          try { mediaStreamRef.current?.getTracks?.().forEach((track) => track.stop()) } catch { /* ignore */ }
          mediaStreamRef.current = null
          mediaRecorderRef.current = null
          const name = error?.name
          if (name === 'NotAllowedError' || name === 'SecurityError') {
            setVoiceError('麦克风权限被拒绝。请点击地址栏的权限图标，允许本页面使用麦克风。')
          } else if (name === 'NotFoundError') {
            setVoiceError('没有找到可用的麦克风。请检查系统输入设备。')
          } else {
            setVoiceError(`无法开始录音：${errorText(error)}`)
          }
        } finally {
          localStartingRef.current = false
        }
      }, [localReady, startLocalVad, stopListening, stopSpeaking, transcribeLocalBlob, unlockTtsAudio])

      const toggleListening = useCallback(() => {
        if (listening) {
          stopListening({ submit: true })
          return
        }
        if (localStartingRef.current) {
          stopLocalRecording({ cancel: true })
          return
        }
        if (localRecording) {
          stopLocalRecording()
          return
        }
        if (localTranscribing) return
        if (effectiveEngine === 'local') {
          void startLocalRecording()
          return
        }
        if (effectiveEngine === 'browser') {
          startListening()
          return
        }
        setVoiceError(
          localReady
            ? '当前识别引擎不可用，请在下方切换识别引擎。'
            : '没有可用的语音识别：浏览器实时识别不可用，本机模型也未就绪。请使用文字输入。',
        )
      }, [
        effectiveEngine,
        listening,
        localReady,
        localRecording,
        localTranscribing,
        startListening,
        startLocalRecording,
        stopListening,
        stopLocalRecording,
      ])

      useEffect(() => {
        startHandsFreeRef.current = () => {
          if (listeningRef.current || localRecordingRef.current || localTranscribingRef.current || localStartingRef.current) return
          if (effectiveEngine === 'browser') {
            startListening()
            return
          }
          if (effectiveEngine === 'local') {
            void startLocalRecording()
            return
          }
          if (recognitionSupported) startListening()
        }
      }, [effectiveEngine, localReady, recognitionSupported, startListening, startLocalRecording])

      const maybeAutoListen = useCallback((delay = 500) => {
        if (autoListenTimerRef.current) {
          window.clearTimeout(autoListenTimerRef.current)
          autoListenTimerRef.current = null
        }
        if (!handsFreeRef.current || !voiceModeRef.current) return
        const activeSession = sessionRef.current
        const turn = currentTurnRef.current
        if (!activeSession || activeSession.status === 'finished' || !turn || turn.answer || busyRef.current) return
        if (listeningRef.current || localRecordingRef.current || localTranscribingRef.current || localStartingRef.current) return
        if (answerDraftRef.current.trim() !== '' || hintRef.current) return
        if (!startHandsFreeRef.current) return
        autoListenTimerRef.current = window.setTimeout(() => {
          autoListenTimerRef.current = null
          if (!handsFreeRef.current || !voiceModeRef.current) return
          const latestSession = sessionRef.current
          const latestTurn = currentTurnRef.current
          if (!latestSession || latestSession.status === 'finished' || !latestTurn || latestTurn.answer || busyRef.current) return
          if (speakingRef.current) return
          if (listeningRef.current || localRecordingRef.current || localTranscribingRef.current || localStartingRef.current) return
          if (answerDraftRef.current.trim() !== '' || hintRef.current) return
          startHandsFreeRef.current?.()
        }, Math.max(0, delay))
      }, [])

      useEffect(() => {
        maybeAutoListenRef.current = maybeAutoListen
      }, [maybeAutoListen])

      useEffect(() => {
        if (!handsFree || !voiceMode || !session || !currentTurn || currentTurn.answer || busy || hint) return undefined
        if (speakQuestions && (naturalTts || ttsSupported)) return undefined
        if (speaking) return undefined
        const timer = window.setTimeout(() => maybeAutoListen(650), 650)
        return () => window.clearTimeout(timer)
      }, [busy, currentTurn, handsFree, hint, naturalTts, session, speakQuestions, speaking, ttsSupported, voiceMode, maybeAutoListen])

      function toggleHandsFree() {
        const next = !handsFree
        setHandsFree(next)
        if (next) {
          unlockTtsAudio()
          window.setTimeout(() => maybeAutoListen(700), 700)
        } else {
          if (autoListenTimerRef.current) {
            window.clearTimeout(autoListenTimerRef.current)
            autoListenTimerRef.current = null
          }
          if (listening) stopListening({ submit: false })
          if (localRecording) stopLocalRecording({ cancel: true })
        }
      }

      function toggleVoiceMode() {
        const next = !voiceMode
        setVoiceMode(next)
        setVoiceError('')
        if (next) {
          voiceUnlockedRef.current = true
          unlockTtsAudio()
          api('/voice/status', { timeoutMs: 15000 }).then((payload) => {
            setLocalSpeech(payload.voice ?? null)
          }).catch(() => {})
          if (currentTurn && !currentTurn.answer && session) {
            spokeKeyRef.current = `${session.id}:${currentTurn.n}`
            speakJapanese(questionSpeech(session, currentTurn))
          }
        } else {
          suppressAutoSendRef.current = true
          stopListening({ submit: false })
          stopLocalRecording({ cancel: true })
          stopSpeaking()
          setListening(false)
        }
      }

      function replayQuestion() {
        if (!session || !currentTurn) return
        voiceUnlockedRef.current = true
        unlockTtsAudio()
        spokeKeyRef.current = `${session.id}:${currentTurn.n}`
        speakJapanese(questionSpeech(session, currentTurn))
      }

      function updateSetupField(key, value) {
        setSetup((previous) => ({ ...previous, [key]: value }))
      }

      function focusUniversity() {
        universityInputRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        window.setTimeout(() => universityInputRef.current?.focus?.(), 250)
      }

      function scrollToStatement() {
        statementSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      }

      function scrollToGeneration() {
        generationSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      }

      function fillSample() {
        if (busyRef.current) return
        const sample = {
          ...DEFAULT_SETUP,
          university: '早稲田大学',
          faculty: '政治経済学部',
          major: '経済学科',
          officialUrl: 'https://www.waseda.jp/',
        }
        const sampleText = [
          '私は貴学政治経済学部経済学科を志望します。',
          '高校では生徒会の活動を通じて、地域の商店街と連携した企画に取り組みました。',
          'その経験から、地域経済と公共政策の関係を実証的に学びたいと考えるようになりました。',
          '貴学では少人数のゼミで、地域経済や国際経済の課題をデータ分析を用いて研究したいです。',
          '卒業後は日本と中国の経済交流に携わり、地域の課題解決に貢献したいと考えています。',
        ].join('\n')
        setSetup(sample)
        setStatement({
          text: sampleText,
          filename: '示例理由书',
          kind: 'sample',
          warnings: [],
          chars: sampleText.length,
        })
        setResearch(null)
        setResearchSetup(null)
        setError('')
        setNotice('已填入示例大学、专业和理由书，可直接修改后生成面试资料。')
        window.setTimeout(() => statementSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 150)
      }

      async function handleFile(file) {
        if (!file || busyRef.current) return
        if (file.size > 8 * 1024 * 1024) {
          setError('文件超过 8MB 上限，请压缩或改用文本粘贴。')
          if (fileInputRef.current) fileInputRef.current.value = ''
          return
        }
        setBusy('upload')
        busyRef.current = 'upload'
        setError('')
        setNotice('')
        try {
          const base64 = await fileToBase64(file)
          const response = await api('/statement', {
            method: 'POST',
            body: { filename: file.name, base64 },
            timeoutMs: 40000,
          })
          setStatement({
            text: response.text ?? '',
            filename: response.filename || file.name,
            kind: response.kind || '',
            warnings: Array.isArray(response.warnings) ? response.warnings : [],
            chars: response.chars ?? (response.text ?? '').length,
          })
          setResearch(null)
          setResearchSetup(null)
          setNotice(response.text ? '理由书已载入，可以直接开始生成面试资料。' : '文件已读取，但没有提取到正文；请手动粘贴。')
        } catch (error) {
          setError(errorText(error))
        } finally {
          setBusy(null)
          busyRef.current = null
          if (fileInputRef.current) fileInputRef.current.value = ''
        }
      }

      function onFileInput(event) {
        const file = event.target.files?.[0]
        if (file) handleFile(file)
      }

      function onDrop(event) {
        event.preventDefault()
        setDragOver(false)
        const file = event.dataTransfer?.files?.[0]
        if (file) handleFile(file)
      }

      function clearStatement() {
        setStatement({ ...EMPTY_STATEMENT })
        setResearch(null)
        setResearchSetup(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }

      async function generateResearch(refresh = false) {
        if (busyRef.current) return
        if (asText(setup.university).trim() === '') {
          setError('请先填写目标大学。')
          return
        }
        if (health?.web?.fetch === false) {
          setError('网页抓取服务不可用，请先在 DSH 中配置网页抓取提供方。')
          return
        }
        if (health?.web?.search === false && asText(setup.officialUrl).trim() === '') {
          setError('网页搜索服务未配置，请填写目标大学的官网 URL 后重试。')
          return
        }
        setBusy('research')
        busyRef.current = 'research'
        setError('')
        setNotice('')
        try {
          const response = await api('/research', {
            method: 'POST',
            body: {
              setup,
              statement: statement.text,
              model: modelSelection,
              refresh,
            },
            timeoutMs: 300000,
          })
          const nextSetup = response.officialUrl && asText(setup.officialUrl).trim() === ''
            ? { ...setup, officialUrl: response.officialUrl }
            : setup
          setResearch(response.research)
          setResearchSetup(nextSetup)
          if (nextSetup !== setup) setSetup(nextSetup)
          if (response.model?.provider && response.model?.model) {
            setModelSelection({ provider: response.model.provider, model: response.model.model })
          }
          setNotice(response.cached ? '已使用上次的调研缓存（资料未变化）。' : '官网资料与题库已生成。')
          setTab('chat')
        } catch (error) {
          setError(errorText(error))
        } finally {
          setBusy(null)
          busyRef.current = null
        }
      }

      async function startInterview() {
        if (!research || busyRef.current) return
        unlockTtsAudio()
        setBusy('start')
        busyRef.current = 'start'
        setError('')
        setNotice('')
        try {
          const response = await api('/session/start', {
            method: 'POST',
            body: {
              setup,
              statement: statement.text,
              statementFilename: statement.filename,
              statementKind: statement.kind,
              statementWarnings: statement.warnings,
              research,
              model: modelSelection,
            },
            timeoutMs: 160000,
          })
          setSession(response.session)
          if (response.session?.model?.provider && response.session?.model?.model) {
            setModelSelection({ provider: response.session.model.provider, model: response.session.model.model })
          }
          setTab('chat')
          setHint(null)
          setAnswerDraft('')
          setLiveTranscript('')
          voiceUnlockedRef.current = true
          setNotice('面试开始。若开启了语音模式，面试官会直接朗读问题。')
        } catch (error) {
          setError(errorText(error))
        } finally {
          setBusy(null)
          busyRef.current = null
        }
      }

      async function sendAnswer(override) {
        const text = asText(override ?? answerDraft).trim()
        if (!session || text === '' || busyRef.current) return
        unlockTtsAudio()
        suppressAutoSendRef.current = true
        stopListening({ submit: false })
        stopLocalRecording({ cancel: true })
        stopSpeaking()
        setListening(false)
        setBusy('answer')
        busyRef.current = 'answer'
        setError('')
        setNotice('')
        try {
          const response = await api('/session/answer', {
            method: 'POST',
            body: {
              sessionId: session.id,
              turnN: session.turns?.[session.turns.length - 1]?.n,
              answer: text,
            },
            timeoutMs: 160000,
          })
          setSession(response.session)
          setAnswerDraft('')
          setLiveTranscript('')
          setHint(null)
          setTab('chat')
          window.setTimeout(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
          }, 50)
        } catch (error) {
          setError(errorText(error))
        } finally {
          setBusy(null)
          busyRef.current = null
        }
      }
      sendAnswerRef.current = sendAnswer

      async function askHint() {
        if (!session || busyRef.current) return
        suppressAutoSendRef.current = true
        if (listening) stopListening({ submit: false })
        if (localRecording) stopLocalRecording({ cancel: true })
        setBusy('hint')
        busyRef.current = 'hint'
        setError('')
        try {
          const response = await api('/session/hint', {
            method: 'POST',
            body: { sessionId: session.id },
            timeoutMs: 100000,
          })
          setHint(response.hint)
        } catch (error) {
          setError(errorText(error))
        } finally {
          setBusy(null)
          busyRef.current = null
        }
      }

      async function finishInterview() {
        if (!session || busyRef.current) return
        suppressAutoSendRef.current = true
        stopListening({ submit: false })
        stopLocalRecording({ cancel: true })
        stopSpeaking()
        setListening(false)
        if (answeredCount === 0) {
          setError('至少回答一题后再生成面试报告。')
          return
        }
        if (answeredCount >= 1 && !window.confirm(`已回答 ${answeredCount} 题，现在结束面试并生成报告吗？`)) return
        setBusy('finish')
        busyRef.current = 'finish'
        setError('')
        try {
          const response = await api('/session/finish', {
            method: 'POST',
            body: { sessionId: session.id },
            timeoutMs: 160000,
          })
          setSession(response.session)
          setTab('chat')
          setHint(null)
        } catch (error) {
          setError(errorText(error))
        } finally {
          setBusy(null)
          busyRef.current = null
        }
      }

      function resetToNew(keepResearch = true) {
        if (busyRef.current || localTranscribing) return
        suppressAutoSendRef.current = true
        stopListening({ submit: false })
        stopLocalRecording({ cancel: true })
        stopSpeaking()
        setListening(false)
        if (session && session.status !== 'finished') {
          const ok = window.confirm('当前面试还没有结束，确定新建面试吗？本次对话会保留在记录中。')
          if (!ok) return
        }
        setSession(null)
        setHint(null)
        setAnswerDraft('')
        setLiveTranscript('')
        setError('')
        setNotice('')
        setTab('chat')
        lastSessionIdRef.current = ''
        try { window.localStorage.setItem(STORAGE.session, 'none') } catch { /* ignore */ }
        if (!keepResearch) {
          setResearch(null)
          setResearchSetup(null)
        }
      }

      function restartWithSameResearch() {
        if (busyRef.current) return
        if (!research) {
          resetToNew(false)
          return
        }
        suppressAutoSendRef.current = true
        stopListening({ submit: false })
        stopLocalRecording({ cancel: true })
        setSession(null)
        setHint(null)
        setAnswerDraft('')
        setLiveTranscript('')
        setError('')
        setNotice('')
        setTab('chat')
        lastSessionIdRef.current = ''
        try { window.localStorage.setItem(STORAGE.session, 'none') } catch { /* ignore */ }
        startInterview()
      }

      function exportTranscript() {
        if (!session) return
        const lines = [
          `# 面试道场记录：${session.setup?.university || '目标大学'}`,
          '',
          `- 学部/研究科：${session.setup?.faculty || '未填写'}`,
          `- 课程：${session.setup?.program || '未填写'}`,
          `- 面试形式：${session.setup?.format || '未填写'}`,
          `- 日语水平：${session.setup?.jlpt || '未填写'}`,
          `- 时间：${session.createdAt || ''}`,
          '',
        ]
        const sources = new Map((session.research?.sources ?? []).map((source) => [source.id, source]))
        if (session.opening?.openingJp) {
          lines.push('## 开场', '', session.opening.openingJp, '', session.opening.openingZh || '', '')
        }
        for (const turn of (session.turns ?? []).filter((entry) => entry.answer)) {
          lines.push(`## 第 ${turn.n} 问`, '', turn.question?.jp || '', '', turn.question?.zh || '', '')
          if (turn.question?.intentZh) lines.push(`面试官意图：${turn.question.intentZh}`, '')
          if (turn.question?.sourceNote) lines.push(`出题依据：${turn.question.sourceNote}`, '')
          if (turn.question?.sourceIds?.length) {
            const refs = turn.question.sourceIds
              .map((id) => sources.get(id))
              .filter(Boolean)
              .map((source) => `[${source.id}] ${source.title || source.url}（${source.url}）`)
            if (refs.length > 0) lines.push(`来源：${refs.join('；')}`, '')
          }
          if (turn.analysis?.structureZh?.length) {
            lines.push('回答结构：')
            for (const item of turn.analysis.structureZh) lines.push(`- ${item}`)
            lines.push('')
          }
          if (turn.analysis?.vocabulary?.length) {
            lines.push('重难词汇：')
            for (const item of turn.analysis.vocabulary) {
              lines.push(`- ${item.word}${item.reading ? `（${item.reading}）` : ''}：${item.meaningZh || ''}`)
            }
            lines.push('')
          }
          if (turn.analysis?.grammar?.length) {
            lines.push('语法与表达：')
            for (const item of turn.analysis.grammar) {
              lines.push(`- ${item.point}：${item.explanationZh || ''}${item.exampleJp ? `（${item.exampleJp}）` : ''}`)
            }
            lines.push('')
          }
          if (turn.analysis?.tipsZh?.length) lines.push(`回答提示：${turn.analysis.tipsZh.join('；')}`, '')
          if (turn.analysis?.culturalNoteZh) lines.push(`文化与礼仪：${turn.analysis.culturalNoteZh}`, '')
          if (turn.analysis?.modelAnswerJp) {
            lines.push('参考回答：', '', turn.analysis.modelAnswerJp, '', turn.analysis.modelAnswerZh || '', '')
          }
          if (turn.answer) {
            lines.push('### 你的回答', '', turn.answer, '')
            if (turn.evaluation) {
              lines.push(`评分：${turn.evaluation.score}／100`, '', turn.evaluation.verdictZh || '', '')
              if (turn.evaluation.strengthsZh?.length) lines.push(`优点：${turn.evaluation.strengthsZh.join('；')}`, '')
              if (turn.evaluation.improvementsZh?.length) lines.push(`改进：${turn.evaluation.improvementsZh.join('；')}`, '')
              if (turn.evaluation.languageNotesZh?.length) lines.push(`语言建议：${turn.evaluation.languageNotesZh.join('；')}`, '')
              if (turn.evaluation.contentNotesZh?.length) lines.push(`内容建议：${turn.evaluation.contentNotesZh.join('；')}`, '')
              if (turn.evaluation.correctedJp) lines.push('日语修正：', '', turn.evaluation.correctedJp, '')
            }
          }
        }
        if (session.finalReport) {
          lines.push('## 面试报告', '', `总分：${session.finalReport.overallScore}／100`, '', session.finalReport.summaryZh || '', '')
          if (session.finalReport.strengthsZh?.length) lines.push(`优点：${session.finalReport.strengthsZh.join('；')}`, '')
          if (session.finalReport.improvementsZh?.length) lines.push(`改进：${session.finalReport.improvementsZh.join('；')}`, '')
          if (session.finalReport.universityFitZh) lines.push(`大学匹配度：${session.finalReport.universityFitZh}`, '')
          if (session.finalReport.languageNotesZh?.length) lines.push(`语言总结：${session.finalReport.languageNotesZh.join('；')}`, '')
          if (session.finalReport.nextStepsZh?.length) lines.push(`下一步：${session.finalReport.nextStepsZh.join('；')}`, '')
          if (session.finalReport.keyVocabulary?.length) {
            lines.push('重点词汇：', '')
            for (const item of session.finalReport.keyVocabulary) {
              lines.push(`- ${item.word}${item.reading ? `（${item.reading}）` : ''}：${item.meaningZh || ''}`)
            }
          }
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `interview-dojo-${(session.setup?.university || 'session').replace(/[\\/:*?"<>|]/g, '_')}.md`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }

      async function archiveSession(options = {}) {
        if (!session || busyRef.current) return null
        let bundle
        try {
          bundle = buildArchiveDocument(session, research)
        } catch (error) {
          setError(`生成存档失败：${errorText(error)}`)
          return null
        }
        let saved = null
        try {
          const response = await api('/archive', {
            method: 'POST',
            body: {
              sessionId: session.id,
              baseName: bundle.baseName,
              markdown: bundle.markdown,
              html: bundle.html,
            },
            timeoutMs: 30000,
          })
          saved = response.archive ?? null
          if (saved) setLastArchive({ ...saved, sessionId: session.id })
        } catch (error) {
          setNotice(`文档已下载，但本机存档失败：${errorText(error)}`)
        }
        const docName = saved?.doc || `${bundle.baseName}.doc`
        const markdownName = saved?.markdown || `${bundle.baseName}.md`
        if (options.downloadWord !== false) {
          downloadArchiveFile(bundle.html, docName, 'application/msword;charset=utf-8')
        }
        if (options.downloadMarkdown === true) {
          downloadArchiveFile(bundle.markdown, markdownName, 'text/markdown;charset=utf-8')
        }
        if (saved) {
          setNotice(`已存档：${saved.doc}，目录：${saved.directory}`)
        }
        return { archive: saved, bundle }
      }

      function archiveWord() {
        void archiveSession({ downloadWord: true })
      }

      function archiveMarkdown() {
        void archiveSession({ downloadWord: false, downloadMarkdown: true })
      }

      async function clearPractice(options = {}) {
        if (busyRef.current || localTranscribing) return false
        if (options.confirm !== false) {
          const message = session
            ? '将清空当前大学、理由书、题库和面试记录，并回到空白的新练习。已保存到 archives/ 的存档不会被删除；如需保留本次面试，请先点「存档」。确定清空吗？'
            : '将清空目标大学、专业、理由书和题库，回到空白的新练习。确定清空吗？'
          const ok = window.confirm(message)
          if (!ok) return false
        }
        suppressAutoSendRef.current = true
        stopListening({ submit: false })
        stopLocalRecording({ cancel: true })
        stopSpeaking()
        setListening(false)
        setHint(null)
        setAnswerDraft('')
        setLiveTranscript('')
        setError('')
        setVoiceError('')
        setBusy(null)
        busyRef.current = null
        const id = session?.id
        if (id && options.deleteRemote !== false) {
          try {
            await api(`/session/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 20000 })
          } catch {
            // The UI tombstone still prevents this session from being restored.
          }
        }
        try {
          window.localStorage.removeItem(STORAGE.setup)
          window.localStorage.removeItem(STORAGE.statement)
          window.localStorage.setItem(STORAGE.session, 'none')
        } catch {
          // Storage can be unavailable in private windows.
        }
        setSetup({ ...DEFAULT_SETUP })
        setStatement({ ...EMPTY_STATEMENT })
        setResearch(null)
        setResearchSetup(null)
        setSession(null)
        setTab('chat')
        lastSessionIdRef.current = ''
        setNotice(lastArchive ? `已清空当前练习，开始新练习。上次存档仍在：${lastArchive.directory}` : '已清空当前练习，开始新练习。')
        return true
      }

      async function archiveAndNew() {
        if (!session || busyRef.current) return
        const result = await archiveSession({ downloadWord: true })
        if (!result) return
        const cleared = await clearPractice({ confirm: false })
        if (cleared) {
          setNotice(result.archive ? `已存档并新建练习。存档目录：${result.archive.directory}` : '文档已下载，并已开始新练习；本机存档目录写入失败。')
        }
      }

      function retryBoot() {
        window.location.reload()
      }

      // ------------------------------------------------------------------
      // Render: boot
      // ------------------------------------------------------------------

      const sessionContext = session
        ? [session.setup?.university, session.setup?.major || session.setup?.faculty].filter(Boolean).join(' · ')
        : ''
      const header = h('header', { className: 'idojo-header' },
        h('div', { className: 'idojo-brand-mark' }, h(ToriiIcon, { size: 21 })),
        h('div', { className: 'idojo-header-copy' },
          h('h1', { className: 'idojo-title' }, '面试道场'),
          h('p', { className: 'idojo-subtitle' }, sessionContext || '日本留学面试 · 实时语音模拟'),
        ),
        h('div', { className: 'idojo-header-actions' },
          h('span', { className: 'idojo-live-badge' }, h('span', { className: 'idojo-live-dot' }), 'VOICE'),
          session ? h(React.Fragment, null,
            h('button', {
              type: 'button',
              className: 'idojo-btn is-small',
              onClick: archiveWord,
              disabled: Boolean(busy) || localTranscribing,
              title: '把本次面试、解析和知识点存档并下载',
            }, '存档'),
            h('button', {
              type: 'button',
              className: 'idojo-btn is-small is-danger',
              onClick: () => { void clearPractice() },
              disabled: Boolean(busy) || localTranscribing,
              title: '清空当前大学、理由书、题库与面试记录，开始新的练习',
            }, '清空'),
          ) : null,
        ),
      )

      if (view === 'boot') {
        return h('div', { className: 'idojo-root' },
          header,
          h('div', { className: 'idojo-scroll' },
            h('div', { className: 'idojo-narrow' },
              bootError
                ? h(Alert, { tone: 'error', onRetry: retryBoot, retryLabel: '重新加载' },
                  h('strong', null, '插件后端没有响应'),
                  h('div', { className: 'idojo-mt8' }, bootError),
                  h('div', { className: 'idojo-hint idojo-mt8' }, '确认插件已启用；若刚安装，新建会话或重启 DSH 后再打开。'),
                )
                : h('div', { className: 'idojo-card' }, h(Spinner, { label: '正在连接面试道场…' })),
            ),
          ),
        )
      }

      // ------------------------------------------------------------------
      // Render: setup
      // ------------------------------------------------------------------

      const hasModel = Boolean(modelSelection.provider && modelSelection.model)
      const modelOptions = health?.llm?.providers ?? []
      const modelChoiceCount = modelOptions.reduce((total, provider) => total + (provider.models?.length ?? 0), 0)
      const modelValue = `${modelSelection.provider}::${modelSelection.model}`
      const webFetchReady = health?.web?.fetch !== false
      const webSearchReady = health?.web?.search !== false
      const needsOfficialUrl = !webSearchReady && asText(setup.officialUrl).trim() === ''
      const researchBlocked = Boolean(busy) || !webFetchReady || needsOfficialUrl

      const setupView = h('div', { className: 'idojo-scroll' },
        h('div', { className: 'idojo-narrow' },
          h(SetupStepper, {
            step: activeSetupStep,
            setupReady,
            statementReady,
            onStep1: focusUniversity,
            onStep2: scrollToStatement,
            onStep3: scrollToGeneration,
          }),
          h(OnboardingBanner, {
            onStart: focusUniversity,
            onSample: fillSample,
            started: setupStarted || statementReady,
          }),
          lastArchive ? h('div', { className: 'idojo-archive-note' },
            h('strong', null, '上次存档仍在'),
            h('div', { className: 'idojo-small' }, lastArchive.directory),
            h('div', { className: 'idojo-small' }, `Word：${lastArchive.doc} · Markdown：${lastArchive.markdown}`),
          ) : null,
          bootError ? h(Alert, { tone: 'warn' }, bootError) : null,
          error ? h(Alert, { tone: 'error' }, error) : null,
          notice ? h(Alert, { tone: 'success' }, notice) : null,

          h('section', { className: 'idojo-card' },
            h('div', { className: 'idojo-card-head' },
              h('div', { className: 'idojo-section-head' },
                h('span', { className: 'idojo-step-badge' }, '第 1 步'),
                h('div', null,
                  h('h3', { className: 'idojo-card-title' }, '目标大学与专业'),
                  h('p', { className: 'idojo-card-sub' }, '先写清楚你要面试的学校和专业，后面的题库会围绕它生成。'),
                ),
              ),
              asText(setup.university).trim()
                ? h(Badge, { tone: 'success' }, '学校已填')
                : h(Badge, { tone: 'outline' }, '必填'),
            ),
            h('div', { className: 'idojo-field-grid' },
              h(Field, {
                label: h(React.Fragment, null, '目标大学', h('span', { className: 'idojo-required' }, '必填')),
                full: true,
                hint: '写学校常用名即可，例如「早稲田大学」「京都大学」。',
              },
                h('input', {
                  ref: universityInputRef,
                  className: 'idojo-input',
                  value: setup.university,
                  placeholder: '例：早稲田大学 / 京都大学',
                  'aria-required': true,
                  onChange: (event) => updateSetupField('university', event.target.value),
                }),
              ),
              h(Field, { label: '学部 / 研究科', hint: '例：政治経済学部、工学研究科。' },
                h('input', {
                  className: 'idojo-input',
                  value: setup.faculty,
                  placeholder: '例：政治経済学部',
                  onChange: (event) => updateSetupField('faculty', event.target.value),
                }),
              ),
              h(Field, { label: '专业 / 专攻', hint: '例：経済学科、情報理工学専攻。不确定可写大方向。' },
                h('input', {
                  className: 'idojo-input',
                  value: asText(setup.major),
                  placeholder: '例：経済学科',
                  onChange: (event) => updateSetupField('major', event.target.value),
                }),
              ),
              h(Field, { label: '课程' },
                h('select', {
                  className: 'idojo-select',
                  value: setup.program,
                  onChange: (event) => updateSetupField('program', event.target.value),
                },
                  ['学部（本科）', '大学院（修士）', '大学院（博士）', '研究生（预科）', '别科 / 语言课程'].map((option) => h('option', { key: option, value: option }, option)),
                ),
              ),
              h(Field, { label: '面试形式' },
                h('select', {
                  className: 'idojo-select',
                  value: setup.format,
                  onChange: (event) => updateSetupField('format', event.target.value),
                },
                  ['个人面试', '小组面试', '线上视频面试', '电话面试'].map((option) => h('option', { key: option, value: option }, option)),
                ),
              ),
              h(Field, { label: '日语水平' },
                h('select', {
                  className: 'idojo-select',
                  value: setup.jlpt,
                  onChange: (event) => updateSetupField('jlpt', event.target.value),
                },
                  ['N1', 'N2', 'N3', 'N4', 'N5', '未考'].map((option) => h('option', { key: option, value: option }, option)),
                ),
              ),
              h(Field, {
                label: '官网 URL（可选）',
                full: true,
                hint: '留空会自动搜索官网；如果知道网址，填上会更准确。',
              },
                h('input', {
                  className: 'idojo-input',
                  value: setup.officialUrl,
                  placeholder: 'https://www.example.ac.jp/',
                  onChange: (event) => updateSetupField('officialUrl', event.target.value),
                }),
              ),
            ),
            h('div', { className: 'idojo-help-card idojo-mt10' },
              h('h4', null, '不知道怎么填？'),
              h('p', null, '可以点下方「填入示例」先看看完整流程；示例内容都可以修改。专业不确定时，写「経済学」「情報理工学」这样的大方向也可以。'),
            ),
            h('div', { className: 'idojo-actions idojo-mt10' },
              h('button', { type: 'button', className: 'idojo-btn', onClick: fillSample }, '填入示例'),
              h('button', { type: 'button', className: 'idojo-btn is-soft', onClick: scrollToStatement }, '下一步：填写理由书', h(ArrowIcon)),
            ),
          ),

          h('section', { className: 'idojo-card', ref: statementSectionRef },
            h('div', { className: 'idojo-card-head' },
              h('div', { className: 'idojo-section-head' },
                h('span', { className: 'idojo-step-badge' }, '第 2 步'),
                h('div', null,
                  h('h3', { className: 'idojo-card-title' }, '放入入学理由书'),
                  h('p', { className: 'idojo-card-sub' }, '上传文件，或直接把正文粘贴到下面。面试官会围绕里面的经历和计划追问。'),
                ),
              ),
              statement.text ? h(Badge, { tone: 'success' }, `${statement.text.length} 字`) : h(Badge, { tone: 'outline' }, '可跳过'),
            ),
            h('div', {
              className: `idojo-upload is-large${dragOver ? ' is-drag' : ''}`,
              role: 'button',
              tabIndex: 0,
              onClick: () => fileInputRef.current?.click(),
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  fileInputRef.current?.click()
                }
              },
              onDragOver: (event) => {
                event.preventDefault()
                setDragOver(true)
              },
              onDragLeave: () => setDragOver(false),
              onDrop: onDrop,
            },
              h('div', { className: 'idojo-upload-icon' }, h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                h('path', { d: 'M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
                h('path', { d: 'M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
              )),
              h('div', { className: 'idojo-upload-copy' },
                h('div', { className: 'idojo-upload-title' }, busy === 'upload' ? '正在读取文件…' : '点击选择文件，或把文件拖到这里'),
                h('div', { className: 'idojo-upload-sub' }, '支持 .txt / .md / .docx / .pdf，单个文件不超过 8MB。'),
              ),
              h('span', { className: 'idojo-badge is-outline' }, '浏览'),
              h('input', {
                ref: fileInputRef,
                type: 'file',
                accept: '.txt,.md,.markdown,.docx,.pdf',
                className: 'idojo-hidden',
                onChange: onFileInput,
              }),
            ),
            statement.filename ? h('div', { className: 'idojo-file-meta' },
              h(Badge, { tone: 'success' }, '已载入'),
              h('span', null, statement.filename),
              statement.kind ? h('span', null, statement.kind.toUpperCase()) : null,
              h('button', { type: 'button', className: 'idojo-btn is-small', onClick: clearStatement }, '清空'),
            ) : null,
            statement.warnings?.length ? h(Alert, { tone: 'warn' }, h('ul', { className: 'idojo-list' }, statement.warnings.map((warning, index) => h('li', { key: index }, warning)))) : null,
            h('label', { className: 'idojo-label idojo-mt10', htmlFor: 'idojo-statement-text' }, '理由书正文（可以直接粘贴或修改）'),
            h('textarea', {
              id: 'idojo-statement-text',
              className: 'idojo-textarea is-statement idojo-mt8',
              value: statement.text,
              placeholder: '在这里粘贴入学理由书正文。上传文件后，提取出的文字也会出现在这里。',
              onChange: (event) => {
                setStatement((previous) => ({ ...previous, text: event.target.value, chars: event.target.value.length }))
                setResearch(null)
                setResearchSetup(null)
              },
            }),
            h('p', { className: 'idojo-hint idojo-mt8' }, '理由书正文会发送给当前模型用于出题，并保存在本机数据目录和浏览器本地缓存。'),
            h('div', { className: 'idojo-actions idojo-mt10' },
              h('button', { type: 'button', className: 'idojo-btn is-soft', onClick: scrollToGeneration }, '没有理由书也可以，下一步：生成资料', h(ArrowIcon)),
            ),
          ),

          h('section', { className: 'idojo-card', ref: generationSectionRef },
            h('div', { className: 'idojo-card-head' },
              h('div', { className: 'idojo-section-head' },
                h('span', { className: 'idojo-step-badge' }, '第 3 步'),
                h('div', null,
                  h('h3', { className: 'idojo-card-title' }, '生成面试资料与题库'),
                  h('p', { className: 'idojo-card-sub' }, '会先检索官网，再由模型结合理由书出题；生成后可以先检查资料再开始。'),
                ),
              ),
            ),
            h('div', { className: 'idojo-help-card' },
              h('h4', null, '会生成什么？'),
              h('p', null, '大学画像、这所学校最该准备的面试重点、共通题、本校专属题，以及针对理由书的追问。'),
            ),
            !webFetchReady ? h(Alert, { tone: 'warn' }, '网页抓取服务不可用。请先在 DSH 的网页搜索/抓取设置中配置抓取提供方，再生成面试资料。') : null,
            webFetchReady && needsOfficialUrl ? h(Alert, { tone: 'warn' }, '网页搜索服务未配置。请在上方填写目标大学的官网 URL，插件会直接抓取该官网。') : null,
            !hasModel ? h(Alert, { tone: 'warn' }, '未检测到可用模型。请先在 DSH 中配置模型后再生成资料。') : null,
            h('div', { className: 'idojo-actions idojo-mt10' },
              h('button', {
                type: 'button',
                className: 'idojo-btn is-primary',
                onClick: () => generateResearch(false),
                disabled: researchBlocked,
              },
                busy === 'research' ? h('span', { className: 'idojo-spinner' }) : null,
                busy === 'research' ? '正在调研官网并生成题库…' : '生成面试资料与题库',
                busy === 'research' ? null : h(ArrowIcon),
              ),
              modelChoiceCount > 1 ? h('select', {
                className: 'idojo-select',
                value: modelValue,
                onChange: (event) => {
                  const [provider, ...rest] = event.target.value.split('::')
                  setModelSelection({ provider, model: rest.join('::') })
                },
                title: '使用的模型',
                style: { maxWidth: '210px' },
              },
                modelOptions.flatMap((provider) => provider.models.map((model) => h('option', {
                  key: `${provider.id}::${model.id}`,
                  value: `${provider.id}::${model.id}`,
                }, `${provider.name} · ${model.name}`))),
              ) : null,
            ),
            busy === 'research' ? h('p', { className: 'idojo-hint idojo-mt8' }, '会先搜索并保留最多 7 个官网页面，再由模型归纳；通常 20–90 秒，网络慢时可能需要更久。') : null,
            h('p', { className: 'idojo-hint idojo-mt8' }, '生成需要打开网页搜索/抓取并使用模型额度；结果会保存在本机，重新打开可以直接使用。'),
          ),

          h('p', { className: 'idojo-footer-note' },
            '题库为“常见面试题型 + 官网资料 + 理由书”经模型归纳生成，不是学校官方过去问；正式面试请以学校最新募集要项为准。',
            '语音识别可选用浏览器实时识别（可能联网）或本机 SenseVoice（音频不离开电脑）；插件本身不保存录音。',
            '首次使用建议先点「填入示例」走一遍流程。',
          ),
        ),
      )

      // ------------------------------------------------------------------
      // Render: research review
      // ------------------------------------------------------------------

      const reviewView = research ? h('div', { className: 'idojo-scroll' },
        h('div', { className: 'idojo-narrow' },
          error ? h(Alert, { tone: 'error' }, error) : null,
          notice ? h(Alert, { tone: 'success' }, notice) : null,
          stale ? h(Alert, { tone: 'warn' }, '面试设置或理由书已修改，当前资料可能已过期。建议重新生成后再开始面试。') : null,
          h('div', { className: 'idojo-hero' },
            h('div', { className: 'idojo-kicker' }, 'Research ready'),
            h('h2', null, research.universityNameZh || research.universityNameJa || setup.university),
            h('p', null, [research.facultyNameJa || setup.faculty, setup.major, research.universityNameJa].filter(Boolean).join(' · ') || '大学资料已整理'),
          ),
          h('div', { className: 'idojo-actions', style: { marginBottom: '12px' } },
            h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: startInterview, disabled: Boolean(busy) },
              busy === 'start' ? h('span', { className: 'idojo-spinner' }) : null,
              busy === 'start' ? '正在准备面试…' : '开始模拟面试',
            ),
            h('button', { type: 'button', className: 'idojo-btn', onClick: () => resetToNew(false), disabled: Boolean(busy) }, '修改设置'),
            h('button', { type: 'button', className: 'idojo-btn', onClick: () => generateResearch(true), disabled: Boolean(busy) }, busy === 'research' ? '重新调研中…' : '重新调研'),
          ),

          h('div', { className: 'idojo-card' },
            h('h3', { className: 'idojo-card-title' }, '大学画像'),
            research.overviewZh ? h('p', { style: { margin: '4px 0 0' } }, research.overviewZh) : h('p', { className: 'idojo-hint' }, '模型没有总结出概况。'),
            research.admissionPolicyZh ? h('div', { className: 'idojo-section' },
              h('h4', { className: 'idojo-section-title' }, '招生理念 / 求める学生像'),
              h('div', null, research.admissionPolicyZh),
            ) : null,
            research.facultyFeaturesZh?.length ? h('div', { className: 'idojo-section' },
              h('h4', { className: 'idojo-section-title' }, '学部特点'),
              h('div', { className: 'idojo-chips' }, research.facultyFeaturesZh.map((item, index) => h('span', { className: 'idojo-chip', key: index }, item))),
            ) : null,
          ),

          research.uniquePoints?.length ? h('div', { className: 'idojo-card' },
            h('h3', { className: 'idojo-card-title' }, '这所学校为什么特别'),
            h('div', { className: 'idojo-source-list' }, research.uniquePoints.map((point, index) => h('div', { className: 'idojo-source', key: index },
              h('span', { className: 'idojo-source-id' }, index + 1),
              h('div', { className: 'idojo-source-copy' },
                h('div', { className: 'idojo-source-title', style: { whiteSpace: 'normal' } }, point.pointZh),
                point.evidenceJa ? h('div', { className: 'idojo-example' }, `原文：${point.evidenceJa}`) : null,
                point.sourceIds?.length ? h('div', { className: 'idojo-hint idojo-mt8' }, `引用：${point.sourceIds.join('、')}`) : null,
              ),
            ))),
          ) : null,

          research.interviewFocusZh?.length ? h('div', { className: 'idojo-card' },
            h('h3', { className: 'idojo-card-title' }, '这所学校最该准备的面试重点'),
            h('ol', { className: 'idojo-list' }, research.interviewFocusZh.map((item, index) => h('li', { key: index }, item))),
          ) : null,

          h('div', { className: 'idojo-card' },
            h('div', { className: 'idojo-card-head' },
              h('div', null,
                h('h3', { className: 'idojo-card-title' }, '题目池'),
                h('p', { className: 'idojo-card-sub' }, `共 ${research.questions?.length ?? 0} 题，含共通题与本校专属题。`),
              ),
            ),
            h(QuestionBank, { questions: research.questions, sources: research.sources, limit: 8 }),
            research.questions?.length > 8 ? h('p', { className: 'idojo-hint idojo-mt8' }, `还有 ${research.questions.length - 8} 题会在面试中按回答情况使用。`) : null,
          ),

          h('div', { className: 'idojo-card' },
            h('h3', { className: 'idojo-card-title' }, '已抓取的官网资料'),
            h(SourceList, { sources: research.sources }),
            research.diagnostics?.length ? h(Alert, { tone: 'warn' }, h('ul', { className: 'idojo-list' }, research.diagnostics.slice(0, 5).map((item, index) => h('li', { key: index }, item)))) : null,
          ),

          research.disclosure ? h('p', { className: 'idojo-footer-note' }, research.disclosure) : null,
          h('div', { className: 'idojo-actions', style: { marginTop: '2px' } },
            h('button', { type: 'button', className: 'idojo-btn is-primary', onClick: startInterview, disabled: Boolean(busy) }, '开始模拟面试'),
            h('button', { type: 'button', className: 'idojo-btn', onClick: () => resetToNew(false), disabled: Boolean(busy) }, '返回修改'),
          ),
        ),
      ) : null

      // ------------------------------------------------------------------
      // Render: interview
      // ------------------------------------------------------------------

      const materialsView = research ? h('div', { className: 'idojo-narrow' },
        h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '大学画像'),
          research.overviewZh ? h('p', { style: { margin: '4px 0 0' } }, research.overviewZh) : null,
          research.admissionPolicyZh ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '招生理念'),
            h('div', null, research.admissionPolicyZh),
          ) : null,
          research.interviewFocusZh?.length ? h('div', { className: 'idojo-section' },
            h('h4', { className: 'idojo-section-title' }, '面试重点'),
            h('ul', { className: 'idojo-list' }, research.interviewFocusZh.map((item, index) => h('li', { key: index }, item))),
          ) : null,
        ),
        h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '我把你的理由书用在了哪里'),
          session?.statement ? h('div', { className: 'idojo-answer-block' },
            h('div', { className: 'idojo-small', style: { maxHeight: '180px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, session.statement),
          ) : h('p', { className: 'idojo-hint' }, '这次面试没有提供理由书。'),
          h('p', { className: 'idojo-hint idojo-mt8' }, '面试官会围绕这里出现的具体经历、动机和计划追问；如果被问住，可以用“提示”按钮。'),
        ),
        h('div', { className: 'idojo-card' },
          h('h3', { className: 'idojo-card-title' }, '官网资料'),
          h(SourceList, { sources: research.sources }),
          research.disclosure ? h('p', { className: 'idojo-footer-note' }, research.disclosure) : null,
        ),
      ) : h('div', { className: 'idojo-empty' }, '暂无资料。')

      const bankView = research ? h('div', { className: 'idojo-narrow' },
        h('div', { className: 'idojo-card' },
          h('div', { className: 'idojo-card-head' },
            h('div', null,
              h('h3', { className: 'idojo-card-title' }, '面试题库'),
              h('p', { className: 'idojo-card-sub' }, `共 ${research.questions?.length ?? 0} 题。点击每题查看意图与依据。`),
            ),
          ),
          h(QuestionBank, { questions: research.questions, sources: research.sources }),
        ),
        h('p', { className: 'idojo-footer-note' }, '题目由官网资料与常见题型归纳生成，不是官方过去问。面试中会根据你的回答临场追问或改写。'),
      ) : h('div', { className: 'idojo-empty' }, '暂无题库。')

      const interviewMain = session ? h(React.Fragment, null,
        h('div', { className: 'idojo-tabs', role: 'tablist', 'aria-label': '面试道场视图' },
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'chat', className: `idojo-tab${tab === 'chat' ? ' is-active' : ''}`, onClick: () => setTab('chat') }, '对话'),
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'materials', className: `idojo-tab${tab === 'materials' ? ' is-active' : ''}`, onClick: () => setTab('materials') }, '大学资料'),
          h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'bank', className: `idojo-tab${tab === 'bank' ? ' is-active' : ''}`, onClick: () => setTab('bank') }, '题库'),
        ),
        tab === 'chat' ? h(React.Fragment, null,
          h('div', { className: 'idojo-progress' },
            h('span', { className: 'idojo-badge' }, `第 ${session.turns.length} 问`),
            h('span', { className: 'idojo-muted idojo-small' }, `已答 ${answeredCount} 题 · 建议 8 题左右`),
            h('div', { className: 'idojo-progress-bar' }, h('i', { style: { width: `${Math.min(100, (answeredCount / 8) * 100)}%` } })),
          ),
          session.turns.map((turn) => h(TurnCard, {
            key: turn.n,
            session,
            turn,
            isLast: turn.n === session.turns.length,
            busy,
            showJp,
            showZh,
          })),
          hint ? h('div', { className: 'idojo-hint-card' },
            h('div', { className: 'idojo-card-head', style: { marginBottom: '3px' } },
              h('h4', null, '提示'),
              h('button', { type: 'button', className: 'idojo-btn is-small', onClick: () => setHint(null) }, '收起'),
            ),
            hint.hintZh ? h('div', null, hint.hintZh) : null,
            hint.structureZh?.length ? h('ol', { className: 'idojo-list' }, hint.structureZh.map((item, index) => h('li', { key: index }, item))) : null,
            hint.expressions?.length ? h('div', { className: 'idojo-section' },
              h('h4', { className: 'idojo-section-title' }, '可以马上用的表达'),
              hint.expressions.map((item, index) => h('div', { key: index, className: 'idojo-small' }, h('strong', null, item.jp), item.zh ? ` — ${item.zh}` : '')),
            ) : null,
            hint.usableFactsZh?.length ? h('div', { className: 'idojo-section' },
              h('h4', { className: 'idojo-section-title' }, '可以用上的素材'),
              h('ul', { className: 'idojo-list' }, hint.usableFactsZh.map((item, index) => h('li', { key: index }, item))),
            ) : null,
          ) : null,
        ) : tab === 'materials' ? materialsView : bankView,
      ) : null

      const interviewView = h(React.Fragment, null,
        h('div', { className: 'idojo-scroll is-chat', ref: scrollRef },
          h('div', { className: 'idojo-narrow' }, interviewMain),
        ),
        h('div', { className: 'idojo-composer' },
          h(DisplayToggles, {
            showJp,
            showZh,
            onToggleJp: () => setShowJp((value) => !value),
            onToggleZh: () => setShowZh((value) => !value),
          }),
          h('div', { className: 'idojo-composer-top' },
            h('button', {
              type: 'button',
              className: `idojo-voice-switch${voiceMode ? ' is-on' : ''}`,
              onClick: toggleVoiceMode,
              'aria-pressed': voiceMode,
              title: '开启后用日语说话回答，面试官会用日语朗读问题',
            },
              h('span', { className: 'idojo-switch-dot' }, h(MicIcon, { size: 11 })),
              '语音对话',
              voiceMode ? h('span', { className: 'idojo-badge is-success' }, 'ON') : null,
              voiceMode && handsFree ? h('span', { className: 'idojo-badge is-success' }, '免提') : null,
            ),
            h('div', { className: 'idojo-actions' },
              speaking ? h('button', { type: 'button', className: 'idojo-btn is-small', onClick: stopSpeaking }, '停止朗读') : null,
              ttsSupported ? h('button', { type: 'button', className: 'idojo-btn is-small', onClick: replayQuestion, title: '再听一遍当前问题' }, h(VolumeIcon, { size: 13 }), '朗读问题') : null,
              h('button', { type: 'button', className: 'idojo-btn is-small', onClick: askHint, disabled: Boolean(busy) || localTranscribing }, busy === 'hint' ? '提示生成中…' : '提示'),
              h('button', { type: 'button', className: 'idojo-btn is-small is-danger', onClick: finishInterview, disabled: Boolean(busy) || localTranscribing }, busy === 'finish' ? '报告生成中…' : '结束面试'),
            ),
          ),
          error ? h(Alert, { tone: 'error' }, error) : null,
          notice ? h(Alert, { tone: 'success' }, notice) : null,
          voiceError ? h(Alert, { tone: 'warn' }, voiceError) : null,
          voiceMode ? h('div', null,
            h('div', { className: 'idojo-voice-row' },
              h('button', {
                type: 'button',
                className: `idojo-mic${voiceActive ? ' is-listening' : ''}`,
                onClick: toggleListening,
                disabled: Boolean(busy) || localTranscribing,
                title: localTranscribing
                  ? '本机正在识别录音'
                  : localRecording
                    ? '点击结束录音并识别'
                    : listening
                      ? '点击结束语音输入'
                      : effectiveEngine === 'local'
                        ? '点击开始录音，结束后由本机识别'
                        : effectiveEngine === 'browser'
                          ? '点击开始说日语'
                          : '没有可用的语音识别',
                'aria-label': voiceActive ? '结束语音输入' : '开始语音输入',
              }, localTranscribing ? h('span', { className: 'idojo-spinner' }) : h(MicIcon, { size: 20 })),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('textarea', {
                  className: 'idojo-textarea',
                  value: answerDraft,
                  placeholder: localRecording
                    ? '正在录音… 再次点击麦克风结束并识别'
                    : listening
                      ? '正在听你说日语…'
                      : '点击麦克风说日语；识别结果会显示在这里，也可以直接输入修改。',
                  onChange: (event) => setAnswerDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                      event.preventDefault()
                      sendAnswer()
                    }
                  },
                  style: { minHeight: '58px' },
                }),
                h('div', { className: `idojo-live-transcript${voiceActive ? ' is-listening' : ''}`, 'aria-live': 'polite' },
                  speaking
                    ? [h('span', { key: 'sp', className: 'idojo-spinner' }), ' 面试官正在朗读问题…']
                    : localTranscribing
                    ? [h('span', { key: 's', className: 'idojo-spinner' }), ` 本机 ${localProviderName} 正在识别…`]
                    : localRecording
                      ? [h('span', { key: 'w', className: 'idojo-wave' }, h('i'), h('i'), h('i')), ` 录音中 ${localElapsed.toFixed(1)}s · ${handsFree ? '停顿约 3 秒自动结束' : '再次点击结束'}，音频只在本机处理`]
                      : listening
                        ? [h('span', { key: 'w', className: 'idojo-wave' }, h('i'), h('i'), h('i')), liveTranscript || '请用日语回答，停顿后会自动识别…']
                        : liveTranscript
                          ? `识别结果：${liveTranscript}`
                          : effectiveEngine === 'local'
                            ? '本机识别：点击麦克风录音，结束后由 SenseVoice 转写；音频不会离开电脑。'
                            : effectiveEngine === 'browser'
                              ? handsFree && voiceMode
                                ? '免提已开启：面试官说完后会自动开始听，直接用日语回答即可。'
                                : '实时识别：识别语言 日本語（ja-JP）。说话结束后会自动提交。'
                              : '没有可用的语音识别，请使用文字输入。',
                ),
              ),
              h('button', {
                type: 'button',
                className: 'idojo-btn is-primary',
                onClick: () => sendAnswer(),
                disabled: Boolean(busy) || localTranscribing || answerDraft.trim() === '',
                style: { alignSelf: 'stretch', minWidth: '58px' },
              }, busy === 'answer' ? h('span', { className: 'idojo-spinner' }) : '发送'),
            ),
            h('details', { className: 'idojo-voice-settings' },
              h('summary', null, '语音设置 · 识别与朗读说明'),
              h('div', { className: 'idojo-voice-grid' },
                h('label', { className: 'idojo-check-row' }, '识别引擎',
                  h('select', {
                    className: 'idojo-select is-small',
                    value: speechEngine,
                    onChange: (event) => {
                      const next = event.target.value
                      suppressAutoSendRef.current = true
                      if (localRecording) stopLocalRecording({ cancel: true })
                      if (listening) stopListening({ submit: false })
                      setSpeechEngine(next === 'browser' || next === 'local' ? next : 'auto')
                      setVoiceError('')
                    },
                    style: { minWidth: 0 },
                  },
                    h('option', { value: 'auto' }, '自动（推荐）'),
                    h('option', { value: 'browser', disabled: !recognitionSupported }, recognitionSupported ? '浏览器实时识别' : '浏览器实时识别（不可用）'),
                    h('option', { value: 'local', disabled: !localReady }, localReady ? `本机 ${localProviderName}` : '本机识别（未就绪）'),
                  ),
                ),
                h('label', { className: 'idojo-check-row' }, h('input', { type: 'checkbox', checked: handsFree, onChange: toggleHandsFree }), '免提对话（面试官说完自动开始听）'),
                h('label', { className: 'idojo-check-row' }, h('input', { type: 'checkbox', checked: speakQuestions, onChange: (event) => setSpeakQuestions(event.target.checked) }), '自动朗读问题'),
                h('label', { className: 'idojo-check-row' }, h('input', { type: 'checkbox', checked: autoSend, onChange: (event) => setAutoSend(event.target.checked) }), '识别完成后自动发送'),
                h('label', { className: 'idojo-check-row' }, '朗读引擎', h('select', {
                  className: 'idojo-select is-small',
                  value: ttsEngine,
                  onChange: (event) => {
                    stopSpeaking()
                    setTtsEngine(event.target.value === 'system' ? 'system' : 'edge')
                    setVoiceError('')
                  },
                  style: { minWidth: 0 },
                },
                  h('option', { value: 'edge', disabled: !edgeReady }, edgeReady ? '自然语音（Edge 在线）' : '自然语音（未安装）'),
                  h('option', { value: 'system' }, '系统语音（离线）'),
                )),
                ttsEngine === 'edge' && edgeReady ? h('label', { className: 'idojo-check-row' }, '自然音色', h('select', {
                  className: 'idojo-select is-small',
                  value: edgeVoice,
                  onChange: (event) => setEdgeVoice(event.target.value),
                  style: { minWidth: 0 },
                },
                  edgeVoices.map((voice) => h('option', { key: voice.id, value: voice.id }, voice.name)),
                )) : null,
                h('label', { className: 'idojo-check-row' }, '语速', h('select', {
                  className: 'idojo-select is-small',
                  value: String(voiceRate),
                  onChange: (event) => setVoiceRate(Number(event.target.value)),
                }, [0.8, 0.9, 1, 1.1, 1.2].map((rate) => h('option', { key: rate, value: String(rate) }, `${rate.toFixed(1)}×`)))),
                ttsEngine === 'system' && japaneseVoices.length > 0 ? h('label', { className: 'idojo-check-row' }, '系统音色', h('select', {
                  className: 'idojo-select is-small',
                  value: voiceURI,
                  onChange: (event) => setVoiceURI(event.target.value),
                  style: { minWidth: 0 },
                },
                  h('option', { value: '' }, '自动（日语）'),
                  japaneseVoices.map((voice) => h('option', { key: voice.voiceURI, value: voice.voiceURI }, voice.name)),
                )) : null,
              ),
              h('p', { className: 'idojo-hint idojo-mt8' },
                effectiveEngine === 'browser'
                  ? '当前：浏览器实时识别。'
                  : effectiveEngine === 'local'
                    ? `当前：本机 ${localProviderName} 录音识别（音频只在本机处理）。`
                    : '当前：没有可用的语音识别。',
                recognitionSupported ? ' 浏览器识别可用。' : ' 浏览器识别不可用。',
                localReady
                  ? ` 本机识别已就绪（${localSpeech?.provider?.name ?? 'SenseVoice'}）。`
                  : ` 本机识别未就绪${localSpeech?.reason ? `：${localSpeech.reason}` : '。'}`,
                naturalTts ? ' 自然语音可用。' : ttsSupported ? ' 系统语音可用。' : ' 朗读不可用。',
              ),
              h('p', { className: 'idojo-hint idojo-mt8' },
                naturalTts
                  ? '自然语音使用 Microsoft Edge 神经语音（需要联网），默认七海女声；网络失败会自动回退系统语音。'
                  : edgeReady
                    ? '系统语音音色取决于本机语音包；切换到「自然语音（Edge 在线）」可明显改善机械感。'
                    : '自然语音组件未安装或不可用，当前使用系统语音；可在插件目录安装可选依赖 @andresaya/edge-tts 后重载。',
                ' 免提开启时，面试官朗读结束后会自动开始听你的回答，停顿约 3 秒自动结束。',
              ),
              h('p', { className: 'idojo-hint idojo-mt8' },
                '浏览器实时识别可能联网，音频可能由浏览器厂商的语音服务处理；本机识别不会把音频发到外部。',
                ' 若浏览器识别报网络错误，会自动切换到本机识别。',
              ),
            ),
          ) : h('div', { className: 'idojo-voice-row' },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('textarea', {
                className: 'idojo-textarea',
                value: answerDraft,
                placeholder: '用日语写下你的回答…（Enter 发送，Shift+Enter 换行）',
                onChange: (event) => setAnswerDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    sendAnswer()
                  }
                },
                style: { minHeight: '66px' },
              }),
              h('div', { className: 'idojo-hint idojo-mt8' }, '想练习真实场景？打开上方的「语音对话」，用日语直接回答。'),
            ),
            h('button', {
              type: 'button',
              className: 'idojo-btn is-primary',
              onClick: () => sendAnswer(),
              disabled: Boolean(busy) || answerDraft.trim() === '',
              style: { alignSelf: 'stretch', minWidth: '58px' },
            }, busy === 'answer' ? h('span', { className: 'idojo-spinner' }) : '发送'),
          ),
        ),
      )

      if (view === 'interview') {
        return h('div', { className: 'idojo-root' }, header, interviewView)
      }

      if (view === 'report') {
        return h('div', { className: 'idojo-root' },
          header,
          h('div', { className: 'idojo-scroll' },
            h(ReportView, {
              session,
              onRestart: restartWithSameResearch,
              onClear: () => { void clearPractice() },
              onArchive: archiveWord,
              onArchiveMarkdown: archiveMarkdown,
              onArchiveNew: () => { void archiveAndNew() },
              lastArchive,
              showJp,
              showZh,
              onToggleJp: () => setShowJp((value) => !value),
              onToggleZh: () => setShowZh((value) => !value),
            }),
          ),
        )
      }

      if (view === 'review') {
        return h('div', { className: 'idojo-root' }, header, reviewView)
      }

      return h('div', { className: 'idojo-root' }, header, setupView)
    }

    // ------------------------------------------------------------------
    // Entry points
    // ------------------------------------------------------------------

    function openPanel(ctx) {
      const controller = ctx.get?.('sidebarRight')
      if (controller?.openTab) {
        controller.openTab(PANEL_KIND)
        return
      }
      console.warn('[interview-dojo] 右侧栏服务不可用，无法打开面试道场')
    }

    function GuideIcon() {
      return h(ToriiIcon, { size: 16 })
    }

    function DojoPill(props) {
      const ctx = props?.ctx ?? runtimeContext
      return h('button', {
        type: 'button',
        className: 'idojo-pill',
        title: '打开面试道场：日本留学面试实时语音模拟',
        onClick: () => {
          if (ctx) openPanel(ctx)
        },
      }, h(MicIcon, { size: 13 }), h('span', null, '面试道场'))
    }

    function apply(ctx) {
      runtimeContext = ctx
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-interview-dojo'
      style.textContent = STYLE
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-interview-dojo: styles')

      const warn = (label, error) => {
        console.warn(`[interview-dojo] ${label} registration failed`, error)
      }
      const safeSlot = (name, register, label) => {
        try {
          ctx.slots.inject(name, () => {
            try {
              return register()
            } catch (error) {
              warn(label, error)
              return () => {}
            }
          })
        } catch (error) {
          warn(label, error)
        }
      }

      try {
        ctx.inject(['sidebarRightTabs'], (owner) => {
          try {
            const tabs = owner.get('sidebarRightTabs')
            if (!tabs || typeof tabs.register !== 'function') {
              console.warn('[interview-dojo] 没有 sidebarRightTabs 服务，右侧栏标签未注册')
              return
            }
            const typeDisposer = tabs.register({
              id: PANEL_ID,
              kind: PANEL_KIND,
              priority: 'extension',
              title: () => '面试道场',
              guide: [{
                id: PANEL_KIND,
                order: 430,
                title: () => '面试道场',
                description: () => '官网调研 · 理由书追问 · 实时语音面试',
                icon: GuideIcon,
              }],
            })
            owner.effect(() => typeDisposer, 'dsh-interview-dojo: sidebar tab type')

            owner.slots.inject('sidebar.right.pane.tab', () => {
              try {
                return owner.slots.register({
                  name: 'sidebar.right.pane.tab',
                  key: PANEL_ID,
                  order: 100,
                }, SafeDojoPanel)
              } catch (error) {
                warn('sidebar pane body', error)
                return () => {}
              }
            })
          } catch (error) {
            warn('sidebar tab', error)
          }
        })
      } catch (error) {
        warn('sidebar tab', error)
      }

      // A second, full-width entry in the conversation surface. This makes the
      // plugin discoverable even when the right sidebar is collapsed or its
      // pane body has not mounted.
      safeSlot('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'interview-dojo',
        order: 25,
        label: () => '面试道场',
      }, SafeDojoPanel), 'conversation view')

      safeSlot('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'dsh-interview-dojo',
        order: 12,
      }, DojoPill), 'composer pill')

      // Give the Plugins page a useful card instead of an empty configuration
      // pane. These keys are safe no-ops when the host does not render them.
      safeSlot('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: 'dsh-interview-dojo',
      }, InterviewSettingsCard), 'settings item')
      safeSlot('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-interview-dojo',
      }, InterviewSettingsCard), 'bundle config')

      // Also expose a dedicated help page in Settings for users who look for
      // the plugin there instead of the conversation surface.
      safeSlot('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'interview-dojo',
        order: 80,
        label: () => '面试道场',
      }, InterviewSettingsCard), 'settings section')
    }

    return {
      name: 'interview-dojo',
      inject: ['slots'],
      apply,
      __test: { buildArchiveDocument, archiveMarkdownToHtml },
    }
  },
})
