/** Normalizers for model-generated interview material. */

function asString(value, fallback = '') {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null || value === '') return []
  return [value]
}

function asStringArray(value, limit = 12) {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === 'string' || typeof entry === 'number') return asString(entry)
      if (entry && typeof entry === 'object') {
        return asString(entry.text ?? entry.value ?? entry.zh ?? entry.jp ?? entry.point ?? entry.title)
      }
      return ''
    })
    .filter(Boolean)
    .slice(0, limit)
}

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    if (/^(true|yes|1|是|学校|固有)$/i.test(value.trim())) return true
    if (/^(false|no|0|否|通用)$/i.test(value.trim())) return false
  }
  return fallback
}

function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function pick(object, keys, fallback = '') {
  for (const key of keys) {
    if (object && typeof object === 'object' && object[key] !== undefined) {
      const value = asString(object[key])
      if (value !== '') return value
    }
  }
  return fallback
}

function pickArray(object, keys) {
  for (const key of keys) {
    if (object && typeof object === 'object' && object[key] !== undefined) {
      const value = object[key]
      if (Array.isArray(value) && value.length > 0) return value
    }
  }
  return []
}

export function normalizeSourceIds(value, allowedIds) {
  const ids = asArray(value)
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim()
      if (entry && typeof entry === 'object') return asString(entry.id ?? entry.sourceId ?? entry.source_id)
      return ''
    })
    .map((id) => id.replace(/^\[|\]$/g, '').replace(/^S/i, 'S').toUpperCase())
    .filter(Boolean)
  const unique = [...new Set(ids)]
  if (!Array.isArray(allowedIds)) return unique
  return unique.filter((id) => allowedIds.includes(id))
}

export function normalizeVocabulary(value) {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === 'string') {
        return { word: entry, reading: '', meaningZh: '', level: '', exampleJp: '' }
      }
      if (!entry || typeof entry !== 'object') return null
      const word = pick(entry, ['word', 'jp', 'japanese', 'term', '語彙'])
      if (word === '') return null
      return {
        word,
        reading: pick(entry, ['reading', 'kana', 'furigana', 'よみ']),
        meaningZh: pick(entry, ['meaningZh', 'meaning_zh', 'meaning', 'zh', '中文']),
        level: pick(entry, ['level', 'jlpt', 'difficulty']),
        exampleJp: pick(entry, ['exampleJp', 'example_jp', 'example', '例文']),
      }
    })
    .filter(Boolean)
    .slice(0, 18)
}

export function normalizeGrammar(value) {
  return asArray(value)
    .map((entry) => {
      if (typeof entry === 'string') return { point: entry, explanationZh: '', exampleJp: '' }
      if (!entry || typeof entry !== 'object') return null
      const point = pick(entry, ['point', 'grammar', 'pattern', '文型'])
      if (point === '') return null
      return {
        point,
        explanationZh: pick(entry, ['explanationZh', 'explanation_zh', 'explanation', 'meaning', '说明']),
        exampleJp: pick(entry, ['exampleJp', 'example_jp', 'example', '例文']),
      }
    })
    .filter(Boolean)
    .slice(0, 10)
}

export function normalizeQuestion(value, index = 0, fallbackPhase = '') {
  const raw = value && typeof value === 'object' ? value : {}
  const jp = pick(raw, ['jp', 'questionJp', 'question_jp', 'question', 'japanese', '質問'])
  const zh = pick(raw, ['zh', 'questionZh', 'question_zh', 'translation', 'chinese', '中国語訳'])
  return {
    id: pick(raw, ['id', 'questionId', 'question_id']) || `q${index + 1}`,
    category: pick(raw, ['category', 'type', 'kind', '分类'], '一般'),
    phase: pick(raw, ['phase', 'stage', '段階'], fallbackPhase),
    difficulty: clamp(raw.difficulty ?? raw.level, 1, 5, 3),
    jp: jp || '（質問文の生成に失敗しました。もう一度お試しください。）',
    zh: zh || '（问题中文翻译生成失败，请重试。）',
    intentZh: pick(raw, ['intentZh', 'intent_zh', 'intent', '意図']),
    followUp: asBool(raw.followUp ?? raw.follow_up, false),
    schoolSpecific: asBool(raw.schoolSpecific ?? raw.school_specific ?? raw.universitySpecific, false),
    sourceIds: normalizeSourceIds(raw.sourceIds ?? raw.source_ids ?? raw.sources),
    sourceNote: pick(raw, ['sourceNote', 'source_note', 'evidenceNote', '依据']),
  }
}

export function normalizeAnalysis(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    intentZh: pick(raw, ['intentZh', 'intent_zh', 'intent', '面试官意图']),
    structureZh: asStringArray(
      raw.structureZh ?? raw.structure_zh ?? raw.structure ?? raw.回答结构,
      8,
    ),
    vocabulary: normalizeVocabulary(raw.vocabulary ?? raw.vocab ?? raw.words ?? raw.词汇),
    grammar: normalizeGrammar(raw.grammar ?? raw.grammarPoints ?? raw.patterns ?? raw.语法),
    tipsZh: asStringArray(raw.tipsZh ?? raw.tips_zh ?? raw.tips ?? raw.回答提示, 8),
    culturalNoteZh: pick(raw, ['culturalNoteZh', 'cultural_note_zh', 'culturalNote', '文化背景']),
    modelAnswerJp: pick(raw, ['modelAnswerJp', 'model_answer_jp', 'modelAnswer', 'sampleAnswerJp', '参考答案日文']),
    modelAnswerZh: pick(raw, ['modelAnswerZh', 'model_answer_zh', 'modelAnswerCn', '参考答案中文']),
  }
}

export function normalizeEvaluation(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    score: clamp(raw.score ?? raw.total ?? raw.points, 0, 100, 0),
    verdictZh: pick(raw, ['verdictZh', 'verdict_zh', 'verdict', 'summaryZh', '评价']),
    reactionJp: pick(raw, ['reactionJp', 'reaction_jp', 'reaction', '反应日文']),
    reactionZh: pick(raw, ['reactionZh', 'reaction_zh', 'reactionCn', '反应中文']),
    strengthsZh: asStringArray(raw.strengthsZh ?? raw.strengths_zh ?? raw.strengths ?? raw.优点, 6),
    improvementsZh: asStringArray(raw.improvementsZh ?? raw.improvements_zh ?? raw.improvements ?? raw.改进, 6),
    correctedJp: pick(raw, ['correctedJp', 'corrected_jp', 'correction', '修正日文']),
    naturalJp: pick(raw, ['naturalJp', 'natural_jp', 'natural', '自然表达']),
    modelAnswerJp: pick(raw, ['modelAnswerJp', 'model_answer_jp', 'modelAnswer', '参考答案日文']),
    modelAnswerZh: pick(raw, ['modelAnswerZh', 'model_answer_zh', 'modelAnswerCn', '参考答案中文']),
    contentNotesZh: asStringArray(raw.contentNotesZh ?? raw.content_notes_zh ?? raw.contentNotes, 6),
    languageNotesZh: asStringArray(raw.languageNotesZh ?? raw.language_notes_zh ?? raw.languageNotes, 6),
  }
}

export function normalizeResearch(value, sources = [], setup = {}) {
  const raw = value && typeof value === 'object' ? value : {}
  const allowedIds = sources.map((source) => source.id)
  const questions = asArray(raw.questions ?? raw.questionBank ?? raw.questions_list)
    .map((question, index) => normalizeQuestion(question, index))
    .map((question) => ({
      ...question,
      sourceIds: question.sourceIds.filter((id) => allowedIds.includes(id)),
    }))
    .slice(0, 20)
  const uniquePoints = asArray(raw.uniquePoints ?? raw.unique_points ?? raw.schoolFeatures ?? raw.features)
    .map((entry) => {
      if (typeof entry === 'string') return { pointZh: entry, evidenceJa: '', sourceIds: [] }
      if (!entry || typeof entry !== 'object') return null
      const pointZh = pick(entry, ['pointZh', 'point_zh', 'point', 'feature', '特点'])
      if (pointZh === '') return null
      return {
        pointZh,
        evidenceJa: pick(entry, ['evidenceJa', 'evidence_ja', 'evidence', 'quote', '原文']),
        sourceIds: normalizeSourceIds(entry.sourceIds ?? entry.source_ids ?? entry.sources, allowedIds),
      }
    })
    .filter(Boolean)
    .slice(0, 10)

  return {
    universityNameJa: pick(raw, ['universityNameJa', 'university_name_ja', 'universityJa', '大学名日文'], setup.university ?? ''),
    universityNameZh: pick(raw, ['universityNameZh', 'university_name_zh', 'universityZh', '大学名中文'], setup.university ?? ''),
    facultyNameJa: pick(raw, ['facultyNameJa', 'faculty_name_ja', 'facultyJa', '学部名日文'], setup.faculty ?? ''),
    overviewZh: pick(raw, ['overviewZh', 'overview_zh', 'overview', '学校概况']),
    admissionPolicyZh: pick(raw, ['admissionPolicyZh', 'admission_policy_zh', 'admissionPolicy', '招生理念']),
    facultyFeaturesZh: asStringArray(raw.facultyFeaturesZh ?? raw.faculty_features_zh ?? raw.facultyFeatures, 10),
    uniquePoints,
    interviewFocusZh: asStringArray(raw.interviewFocusZh ?? raw.interview_focus_zh ?? raw.interviewFocus, 10),
    questions,
    sources: sources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      chars: source.chars ?? 0,
    })),
    generatedAt: new Date().toISOString(),
    model: setup.model ?? '',
  }
}

export function normalizeOpening(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    openingJp: pick(raw, ['openingJp', 'opening_jp', 'opening', '开场日文']),
    openingZh: pick(raw, ['openingZh', 'opening_zh', 'openingCn', '开场中文']),
    question: normalizeQuestion(raw.question ?? raw.nextQuestion ?? raw.firstQuestion, 0, '導入'),
    analysis: normalizeAnalysis(raw.analysis),
  }
}

export function normalizeTurn(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const evaluation = normalizeEvaluation(raw.evaluation ?? raw.feedback)
  return {
    evaluation,
    nextQuestion: normalizeQuestion(raw.nextQuestion ?? raw.next_question ?? raw.question, 0),
    analysis: normalizeAnalysis(raw.analysis),
    reactionJp: pick(raw, ['reactionJp', 'reaction_jp', 'reaction']) || evaluation.reactionJp,
    reactionZh: pick(raw, ['reactionZh', 'reaction_zh', 'reactionCn']) || evaluation.reactionZh,
    phase: pick(raw, ['phase', 'stage', '段階']),
    closing: asBool(raw.closing, false),
  }
}

export function normalizeHint(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    hintZh: pick(raw, ['hintZh', 'hint_zh', 'hint', '提示']),
    structureZh: asStringArray(raw.structureZh ?? raw.structure_zh ?? raw.structure, 8),
    expressions: asArray(raw.expressions ?? raw.phrases ?? raw.usefulPhrases)
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const jp = pick(entry, ['jp', 'japanese', 'phrase'])
        if (jp === '') return null
        return { jp, zh: pick(entry, ['zh', 'chinese', 'meaningZh', 'meaning']) }
      })
      .filter(Boolean)
      .slice(0, 8),
    usableFactsZh: asStringArray(raw.usableFactsZh ?? raw.usable_facts_zh ?? raw.facts, 8),
  }
}

export function normalizeReport(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    overallScore: clamp(raw.overallScore ?? raw.score, 0, 100, 0),
    summaryZh: pick(raw, ['summaryZh', 'summary_zh', 'summary', '总评']),
    strengthsZh: asStringArray(raw.strengthsZh ?? raw.strengths_zh ?? raw.strengths, 10),
    improvementsZh: asStringArray(raw.improvementsZh ?? raw.improvements_zh ?? raw.improvements, 10),
    universityFitZh: pick(raw, ['universityFitZh', 'university_fit_zh', 'universityFit', '与大学匹配度']),
    languageNotesZh: asStringArray(raw.languageNotesZh ?? raw.language_notes_zh ?? raw.languageNotes, 10),
    nextStepsZh: asStringArray(raw.nextStepsZh ?? raw.next_steps_zh ?? raw.nextSteps, 10),
    keyVocabulary: normalizeVocabulary(raw.keyVocabulary ?? raw.key_vocabulary ?? raw.vocabulary),
  }
}

export function normalizeSessionSnapshot(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    id: asString(raw.id),
    createdAt: asString(raw.createdAt),
    updatedAt: asString(raw.updatedAt),
    status: raw.status === 'finished' ? 'finished' : 'active',
    setup: raw.setup && typeof raw.setup === 'object' ? raw.setup : {},
    statement: asString(raw.statement),
    statementFilename: asString(raw.statementFilename),
    statementKind: asString(raw.statementKind),
    statementWarnings: asStringArray(raw.statementWarnings, 6),
    research: raw.research && typeof raw.research === 'object' ? raw.research : null,
    opening: raw.opening && typeof raw.opening === 'object' ? raw.opening : null,
    turns: asArray(raw.turns)
      .filter((turn) => turn && typeof turn === 'object')
      .map((turn) => ({
        n: clamp(turn.n, 1, 999, 1),
        question: normalizeQuestion(turn.question, 0),
        analysis: normalizeAnalysis(turn.analysis),
        reactionJp: asString(turn.reactionJp),
        reactionZh: asString(turn.reactionZh),
        answer: asString(turn.answer),
        answeredAt: asString(turn.answeredAt),
        evaluation: turn.evaluation ? normalizeEvaluation(turn.evaluation) : null,
      })),
    finalReport: raw.finalReport ? normalizeReport(raw.finalReport) : null,
    model: raw.model && typeof raw.model === 'object' ? raw.model : null,
  }
}
