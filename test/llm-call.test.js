import assert from 'node:assert/strict'
import test from 'node:test'

import { callJson, resolveSelection } from '../lib/llm-call.js'

function makeCtx(chunksPerCall) {
  const calls = []
  let index = 0
  const ctx = {
    llm: {
      stream: async function* stream(options) {
        calls.push(options)
        const chunks = chunksPerCall[Math.min(index, chunksPerCall.length - 1)]
        index += 1
        for (const chunk of chunks) yield chunk
      },
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
      return undefined
    },
  }
  return { ctx, calls }
}

test('callJson assembles text deltas without importing a DSH package', async () => {
  const { ctx, calls } = makeCtx([[
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '{"ok":' },
    { type: 'text-delta', index: 0, text: 'true}' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]])
  const result = await callJson({
    ctx,
    selection: { provider: 'fake-provider', model: 'fake-model' },
    system: 'system',
    prompt: 'prompt',
    maxTokens: 1234,
  })
  assert.deepEqual(result.data, { ok: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, 'off')
  assert.equal(calls[0].maxTokens, 1234)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.deepEqual(calls[0].messages[0].content, [{ type: 'text', text: 'prompt' }])
})

test('callJson repairs one invalid JSON response', async () => {
  const { ctx, calls } = makeCtx([
    [
      { type: 'text-delta', index: 0, text: 'Here is the JSON: {"ok": true' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    [
      { type: 'text-delta', index: 0, text: '{"ok": true}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ])
  const result = await callJson({
    ctx,
    selection: { provider: 'fake-provider', model: 'fake-model' },
    system: 'system',
    prompt: 'prompt',
  })
  assert.deepEqual(result.data, { ok: true })
  assert.equal(result.repaired, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].temperature, 0)
})

test('resolveSelection prefers an explicit route and falls back to the default', () => {
  const { ctx } = makeCtx([[]])
  assert.deepEqual(resolveSelection(ctx, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.deepEqual(resolveSelection(ctx, undefined), { provider: 'fake-provider', model: 'fake-model' })
})
