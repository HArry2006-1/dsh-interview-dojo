import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'

import {
  extractDocxText,
  extractLinks,
  extractPdfText,
  htmlToText,
  parseJsonLoose,
} from '../lib/extract.js'
import {
  normalizeAnalysis,
  normalizeQuestion,
  normalizeResearch,
  normalizeTurn,
} from '../lib/schema.js'

function makeZip(files) {
  const localChunks = []
  const centralChunks = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content, 'utf8')
    const compressed = deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, nameBuffer, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + compressed.length
  }
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localChunks, ...centralChunks, eocd])
}

test('decodes a DOCX document.xml', () => {
  const docx = makeZip({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>私の志望理由</w:t></w:r></w:p><w:p><w:r><w:t>貴学で学びたい。</w:t></w:r></w:p></w:body></w:document>',
  })
  const text = extractDocxText(docx)
  assert.match(text, /私の志望理由/)
  assert.match(text, /貴学で学びたい。/)
  assert.match(text, /\n/)
})

test('extracts text from a simple text PDF', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf (Hello interview) Tj ET\nendstream\nendobj\n%%EOF', 'latin1')
  const result = extractPdfText(pdf)
  assert.match(result.text, /Hello interview/)
  assert.deepEqual(result.warnings, [])
})

test('extracts readable HTML and links', () => {
  const html = '<html><head><title>留学生入試</title></head><body><script>bad()</script><h1>募集要項</h1><p>面接では志望理由を聞きます。</p><a href="/admission">入試情報</a><a href="https://other.example/">外部</a></body></html>'
  const text = htmlToText(html)
  assert.match(text, /募集要項/)
  assert.match(text, /面接では志望理由/)
  assert.doesNotMatch(text, /bad\(\)/)
  const links = extractLinks(html, 'https://www.example.ac.jp/')
  assert.equal(links[0].url, 'https://www.example.ac.jp/admission')
  assert.equal(links[0].text, '入試情報')
  assert.equal(links[1].url, 'https://other.example/')
})

test('parses fenced JSON with surrounding commentary', () => {
  const value = parseJsonLoose('好的，下面是结果：\n```json\n{"questions":[{"jp":"自己紹介をお願いします。","zh":"请做自我介绍。"}]}\n```\n希望有帮助。')
  assert.equal(value.questions[0].jp, '自己紹介をお願いします。')
})

test('parses trailing commas cautiously', () => {
  const value = parseJsonLoose('{"a": 1, "b": [1,2,],}')
  assert.deepEqual(value, { a: 1, b: [1, 2] })
})

test('normalizes question and analysis with aliases', () => {
  const question = normalizeQuestion({
    question_jp: 'なぜ日本に留学したいですか。',
    question_zh: '为什么想来日本留学？',
    level: 9,
    school_specific: 'true',
    sources: ['[s1]', 'S2'],
  }, 0)
  assert.equal(question.jp, 'なぜ日本に留学したいですか。')
  assert.equal(question.difficulty, 5)
  assert.equal(question.schoolSpecific, true)
  assert.deepEqual(question.sourceIds, ['S1', 'S2'])

  const analysis = normalizeAnalysis({
    vocabulary: [{ word: '留学', reading: 'りゅうがく', meaning: '留学' }],
    grammar: [{ pattern: '〜たいです', explanation: '想做某事' }],
    modelAnswerJp: '日本の技術を学びたいです。',
  })
  assert.equal(analysis.vocabulary[0].meaningZh, '留学')
  assert.equal(analysis.grammar[0].point, '〜たいです')
})

test('normalizes a research record and preserves allowed source ids', () => {
  const sources = [
    { id: 'S1', title: '入試', url: 'https://example.ac.jp/admission', chars: 100 },
    { id: 'S2', title: '学部', url: 'https://example.ac.jp/faculty', chars: 200 },
  ]
  const research = normalizeResearch({
    universityNameJa: '例大学',
    overviewZh: '概要',
    uniquePoints: [{ pointZh: '少人数教育', evidenceJa: '少人数', sourceIds: ['S2'] }],
    questions: [{ jp: '質問', zh: '问题', sourceIds: ['S1', 'S9'], difficulty: 2 }],
  }, sources, { university: '例大学' })
  assert.equal(research.sources.length, 2)
  assert.equal(research.uniquePoints[0].sourceIds[0], 'S2')
  assert.deepEqual(research.questions[0].sourceIds, ['S1'])
  assert.equal(research.questions[0].id, 'q1')
})

test('normalizes a turn with nested evaluation and question', () => {
  const turn = normalizeTurn({
    evaluation: { score: 88, verdict_zh: '不错', reaction_jp: 'ありがとうございます。' },
    next_question: { jp: '将来は？', zh: '将来呢？', category: '将来计划' },
    analysis: { vocabulary: [] },
  })
  assert.equal(turn.evaluation.score, 88)
  assert.equal(turn.evaluation.reactionJp, 'ありがとうございます。')
  assert.equal(turn.nextQuestion.jp, '将来は？')
})
