import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('client factory loads and registers the sidebar, conversation, composer, and settings entries', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let loaded
  const registrations = { types: [], slots: [] }
  class FakeComponent {
    constructor(props) {
      this.props = props
    }
    setState() {}
    render() {
      return null
    }
  }
  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial }
    },
    useCallback(fn) {
      return fn
    },
    useMemo(fn) {
      return fn()
    },
    Component: FakeComponent,
    Fragment: Symbol('Fragment'),
  }
  const fakeTabs = {
    register(definition) {
      registrations.types.push(definition)
      return () => {}
    },
  }
  const owner = {
    get(name) {
      return name === 'sidebarRightTabs' ? fakeTabs : undefined
    },
    effect(fn) {
      fn()
      return () => {}
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        registrations.slots.push({
          name: definition.name,
          key: definition.key ?? definition.id,
          component,
        })
        return () => {}
      },
    },
  }
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    inject(services, callback) {
      if (services.includes('sidebarRightTabs')) callback(owner)
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(definition, component) {
        registrations.slots.push({
          name: definition.name,
          key: definition.key ?? definition.id,
          component,
        })
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          loaded = definition
        },
      },
      localStorage: {
        getItem() {
          return null
        },
        setItem() {},
        removeItem() {},
      },
      speechSynthesis: null,
      setTimeout,
      clearTimeout,
      confirm() {
        return true
      },
    },
    document: {
      baseURI: 'http://127.0.0.1:63306/',
      createElement() {
        return { dataset: {}, remove() {} }
      },
      head: { appendChild() {} },
    },
    console,
    URL,
    Blob,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(loaded, 'module loader was called')
  assert.equal(loaded.id, 'dsh-interview-dojo')
  const factory = loaded.factory((specifier) => {
    if (specifier === 'react') return fakeReact
    throw new Error(`unexpected require: ${specifier}`)
  })
  assert.equal(factory.name, 'interview-dojo')
  assert.equal(Array.from(factory.inject).join(','), 'slots')
  factory.apply(ctx)

  assert.equal(registrations.types.length, 1)
  assert.equal(registrations.types[0].kind, 'interview-dojo')
  assert.equal(registrations.types[0].guide.length, 1)
  const names = registrations.slots.map((entry) => entry.name)
  assert.ok(names.includes('sidebar.right.pane.tab'))
  assert.ok(names.includes('conversation.view'))
  assert.ok(names.includes('conversation.input.right'))
  assert.ok(names.includes('settings.plugin.item'))
  assert.ok(names.includes('plugins.bundle.config'))
  assert.ok(names.includes('settings.section'))

  // Regression: the panel used to construct the interview view while
  // `session` was still null, throwing "Cannot read properties of null
  // (reading 'turns')" before the onboarding screen could render.
  const viewSlot = registrations.slots.find((entry) => entry.name === 'conversation.view')
  assert.equal(typeof viewSlot.component, 'function')
  const boundaryElement = viewSlot.component()
  const panelElement = boundaryElement.children.find((child) => child && typeof child.type === 'function')
  assert.ok(panelElement, 'SafeDojoPanel contains the panel element')
  assert.doesNotThrow(() => panelElement.type())

  const bundle = factory.__test.buildArchiveDocument({
    id: 'test-session',
    createdAt: '2026-11-21T00:00:00.000Z',
    status: 'finished',
    setup: { university: '例大学', faculty: '例学部', major: '経済学科', program: '学部（本科）', format: '对面对', jlpt: 'N2' },
    statement: '私は貴学を志望します。',
    turns: [{
      n: 1,
      question: { jp: '志望理由を教えてください。', zh: '请说明志愿理由。', intentZh: '确认动机。' },
      reactionJp: 'はい、お願いします。',
      answer: '貴学で経済を学びたいです。',
      evaluation: { score: 80, verdictZh: '不错。', strengthsZh: ['动机明确'], improvementsZh: ['补充例子'] },
      analysis: {
        structureZh: ['动机', '经历', '计划'],
        vocabulary: [{ word: '志望', reading: 'しぼう', meaningZh: '志愿', level: 'N3', exampleJp: '貴学を志望します。' }],
        grammar: [{ point: '〜たいです', explanationZh: '表达愿望', exampleJp: '学びたいです。' }],
        modelAnswerJp: '貴学で経済を学びたいです。',
        modelAnswerZh: '我想在贵校学习经济。',
      },
    }],
    finalReport: { overallScore: 82, summaryZh: '整体不错。', strengthsZh: ['表达清楚'], improvementsZh: ['增加具体例子'], keyVocabulary: [{ word: '志望', reading: 'しぼう', meaningZh: '志愿' }] },
    research: null,
  }, null)
  assert.match(bundle.markdown, /第 1 问/)
  assert.match(bundle.markdown, /重难词汇汇总/)
  assert.match(bundle.markdown, /面试报告/)
  assert.match(bundle.html, /<h1>/)
  assert.match(bundle.html, /志望理由/)
  assert.doesNotMatch(bundle.html, /<script>/)
})
