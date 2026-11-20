/**
 * Small wrapper around the Harness LLM service.
 *
 * This module intentionally imports no DSH package. A linked local bundle can
 * be installed without resolving the Harness package graph, and the public
 * `ctx.llm.stream` protocol is enough to assemble text here.
 */

import { parseJsonLoose } from './extract.js'

function failureReason(finish) {
  if (finish === undefined || finish === null) return '模型未返回结果'
  if (finish.kind === 'aborted') return '生成已取消'
  if (finish.kind === 'max-tokens') return '输出达到长度上限，未生成完整内容'
  if (finish.kind === 'error') {
    const failure = finish.failure ?? {}
    return failure.message || failure.code || '模型调用失败'
  }
  return '模型未返回文本'
}

function selectionOf(ctx, requested) {
  if (requested && typeof requested.provider === 'string' && typeof requested.model === 'string') {
    const provider = requested.provider.trim()
    const model = requested.model.trim()
    if (provider !== '' && model !== '') return { provider, model }
  }
  try {
    const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
      return { provider: current.provider, model: current.model }
    }
  } catch {
    // Fall through to the caller's catalog.
  }
  return undefined
}

export function currentSelection(ctx) {
  return selectionOf(ctx, undefined)
}

async function supportsReasoningOff(ctx, provider, model) {
  const llm = ctx.llm
  if (typeof llm?.resolveModelInfo !== 'function') return false
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info?.reasoning?.efforts?.some((effort) => effort.id === 'off') ?? false
  } catch {
    return false
  }
}

export async function listModelCatalog(ctx, requested) {
  const llm = ctx.llm
  if (!llm || typeof llm.stream !== 'function') {
    return { providers: [], current: undefined, error: 'LLM 服务不可用' }
  }
  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch {
    providers = []
  }
  const catalog = []
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id : ''
    if (id === '') continue
    let models = []
    try {
      const list = await llm.listModels?.(id)
      models = (Array.isArray(list) ? list : [])
        .map((model) => ({
          id: typeof model?.id === 'string' ? model.id : '',
          name: typeof model?.name === 'string' && model.name !== '' ? model.name : model?.id,
        }))
        .filter((model) => model.id !== '')
    } catch {
      models = []
    }
    if (models.length > 0) catalog.push({ id, name: provider.name || id, models })
  }
  const current = selectionOf(ctx, requested)
  if (current && !catalog.some((provider) => provider.id === current.provider)) {
    catalog.unshift({
      id: current.provider,
      name: current.provider,
      models: [{ id: current.model, name: current.model }],
    })
  }
  if (current && catalog.length > 0) {
    const provider = catalog.find((entry) => entry.id === current.provider)
    if (provider && !provider.models.some((model) => model.id === current.model)) {
      provider.models.unshift({ id: current.model, name: current.model })
    }
  }
  return { providers: catalog, current }
}

export function resolveSelection(ctx, requested) {
  return selectionOf(ctx, requested) ?? { provider: undefined, model: undefined }
}

/**
 * Collect one text completion from the public streaming protocol.
 * Text deltas are the model's visible output; reasoning deltas are ignored.
 */
async function streamText(input) {
  const { ctx, selection, system, prompt, signal } = input
  if (!selection?.provider || !selection?.model) {
    throw new Error('当前对话没有可用的模型，请先在 DSH 中配置模型')
  }
  const llm = ctx.llm
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')

  const supportsOff = input.supportsOff ?? await supportsReasoningOff(ctx, selection.provider, selection.model)
  const timeoutMs = input.timeoutMs ?? 120000
  const timeout = AbortSignal.timeout(timeoutMs)
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const message = {
    role: 'user',
    content: [{ type: 'text', text: prompt }],
  }
  let text = ''
  let blockText = ''
  let finish
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      sessionId: 'dsh-interview-dojo',
      messages: [message],
      system,
      temperature: input.temperature ?? 0.6,
      maxTokens: input.maxTokens ?? 5000,
      ...(supportsOff ? { reasoningEffort: 'off' } : {}),
      signal: effectiveSignal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      } else if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
        blockText += chunk.block.text
      } else if (chunk?.type === 'finish') {
        finish = chunk.reason
      }
    }
  } catch (error) {
    if (signal?.aborted) throw new Error('请求已取消')
    throw error instanceof Error ? error : new Error(String(error))
  }
  if (text === '') text = blockText
  text = text.trim()
  if (text === '') throw new Error(failureReason(finish))
  return { text, finish, supportsOff }
}

/**
 * Stream one text-only JSON completion through ctx.llm.
 * @param {object} input
 * @param {any} input.ctx - plugin context.
 * @param {{provider: string, model: string}} input.selection
 * @param {string} input.system
 * @param {string} input.prompt
 * @param {number} [input.maxTokens]
 * @param {number} [input.temperature]
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs]
 */
export async function callJson(input) {
  const first = await streamText(input)
  try {
    return { data: parseJsonLoose(first.text), text: first.text }
  } catch (firstError) {
    // One cheap repair attempt makes the JSON contract robust on models that
    // prepend an explanation or omit a brace.
    const repair = await streamText({
      ctx: input.ctx,
      selection: input.selection,
      system: 'You convert an invalid JSON response into one valid JSON object. Output JSON only.',
      prompt: `次のテキストから、最初のJSONオブジェクトだけを有効なJSONとして復元してください。キーや値を勝手に削除しないでください。\n\n${first.text.slice(0, 16000)}`,
      maxTokens: 5000,
      temperature: 0,
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? 120000,
      supportsOff: first.supportsOff,
    })
    try {
      return { data: parseJsonLoose(repair.text), text: first.text, repaired: true }
    } catch {
      throw firstError instanceof Error
        ? new Error(`模型返回的 JSON 无法解析：${firstError.message}`)
        : new Error('模型返回的 JSON 无法解析')
    }
  }
}
