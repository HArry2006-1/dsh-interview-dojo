/**
 * Official-site discovery and bounded crawling through ctx.web.
 *
 * The crawler stays on one host, fetches a handful of pages, and never sends
 * the statement or any secret to the web providers. The extracted pages are
 * then handed to the configured LLM for synthesis by the host.
 */

import { extractHtmlMeta, extractLinks, htmlToText } from './extract.js'

const MAX_PAGES = 7
const MAX_PAGE_CHARS = 7000
const FETCH_TIMEOUT_MS = 25000

const BLOCKED_HOSTS = [
  'youtube.com', 'youtu.be', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'wikipedia.org', 'zhihu.com', 'baidu.com', 'google.com', 'bing.com',
  'yahoo.co.jp', 'amazon.co.jp', 'note.com', 'qiita.com', 'github.com',
]

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isBlockedHost(host) {
  return BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
}

function safeUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') return undefined
  let text = input.trim()
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function scoreContentUrl(url, label = '') {
  const target = `${url} ${label}`.toLowerCase()
  let score = 0
  if (/入試|入学|募集|アドミッション|admission|prospectus/.test(target)) score += 10
  if (/留学生|国際|international|グローバル|global/.test(target)) score += 8
  if (/学部|研究科|教育|カリキュラム|faculty|curriculum|研究/.test(target)) score += 6
  if (/大学紹介|概要|特色|about|outline|mission|理念|ポリシー|policy/.test(target)) score += 4
  if (/キャンパス|学生生活|campus|student life/.test(target)) score += 2
  if (/\.pdf(?:$|\?)/.test(target)) score -= 9
  if (/privacy|個人情報|site\s*policy|アクセス|access|採用|recruit|ログイン|login/.test(target)) score -= 5
  return score
}

function hostnameMatches(host, university) {
  if (!host || !university) return false
  const romanized = university
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  if (romanized.length >= 4 && host.replace(/[^a-z0-9]/g, '').includes(romanized)) return true
  return false
}

function chooseOfficialSeed(results, university) {
  const candidates = results
    .map((source) => ({ ...source, host: hostOf(source.url) }))
    .filter((source) => source.host !== '' && !isBlockedHost(source.host))
  if (candidates.length === 0) return undefined

  const universityWords = String(university ?? '')
    .replace(/[（）()]/g, ' ')
    .split(/[\s・,，]+/)
    .filter((word) => word.length >= 2)
  const mentionsUniversity = (source) => {
    const text = `${source.title ?? ''} ${source.snippet ?? ''}`
    return universityWords.some((word) => text.includes(word)) || hostnameMatches(source.host, university)
  }

  const ranked = candidates
    .map((source) => {
      let score = 0
      if (source.host.endsWith('.ac.jp')) score += 30
      else if (source.host.endsWith('.jp')) score += 10
      else if (source.host.endsWith('.edu')) score += 8
      if (mentionsUniversity(source)) score += 20
      if (/入試|入学|募集|留学生|admission|international/i.test(`${source.url} ${source.title ?? ''}`)) score += 8
      return { ...source, score }
    })
    .sort((left, right) => right.score - left.score)
  return ranked[0]
}

async function searchOfficial(ctx, setup, signal, diagnostics) {
  if (typeof ctx.web?.search !== 'function') {
    diagnostics.push('网页搜索服务不可用，仅能直接抓取填写的官网 URL。')
    return []
  }
  const university = String(setup.university ?? '').trim()
  const faculty = String(setup.faculty ?? '').trim()
  const queries = [
    `${university} 外国人留学生 入試 面接`,
    `${university} アドミッションポリシー ${faculty || '学部'}`,
    `${university} 留学生 募集要項 出願`,
  ].filter((query) => query.trim() !== '')
  const results = []
  const searchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000)
  const settled = await Promise.allSettled(
    queries.map((query) => ctx.web.search({ query, maxResults: 8 }, searchSignal)),
  )
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') {
      for (const source of entry.value?.sources ?? []) {
        if (typeof source?.url === 'string') results.push({ ...source, query: queries[index] })
      }
    } else {
      diagnostics.push(`搜索失败（${queries[index]}）：${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`)
    }
  })
  // Deduplicate by URL, preserving the first (highest-ranked) hit.
  const seen = new Set()
  return results.filter((source) => {
    const url = safeUrl(source.url)
    if (url === undefined || seen.has(url)) return false
    seen.add(url)
    return true
  })
}

async function fetchPage(ctx, url, signal) {
  if (typeof ctx.web?.fetch !== 'function') throw new Error('网页抓取服务不可用')
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    : AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const result = await ctx.web.fetch({ url }, effectiveSignal)
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`HTTP ${result.statusCode}`)
  }
  const html = result.body?.kind === 'html' ? result.body.content : result.body?.content ?? ''
  if (typeof html !== 'string' || html.trim() === '') throw new Error('页面为空')
  const meta = extractHtmlMeta(html)
  const text = htmlToText(html).slice(0, MAX_PAGE_CHARS)
  if (text.length < 80) throw new Error('页面没有足够的可读正文')
  return {
    url: result.url || url,
    title: meta.title || meta.description || hostOf(result.url || url),
    description: meta.description,
    html,
    text,
    chars: text.length,
    truncated: result.truncated === true,
  }
}

function candidateLinks(html, pageUrl, officialHost) {
  const links = extractLinks(html, pageUrl)
  const seen = new Set()
  return links
    .filter((link) => {
      const host = hostOf(link.url)
      if (host !== officialHost) return false
      if (seen.has(link.url)) return false
      seen.add(link.url)
      return scoreContentUrl(link.url, link.text) >= 4
    })
    .map((link) => ({ ...link, score: scoreContentUrl(link.url, link.text) }))
    .sort((left, right) => right.score - left.score)
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      output[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return output
}

/**
 * Collect bounded official-site material for one university.
 * @returns {Promise<{sources: object[], officialUrl: string, diagnostics: string[], searchNotes: string}>}
 */
export async function collectUniversitySources({ ctx, setup, signal, diagnostics = [] }) {
  const university = String(setup.university ?? '').trim()
  if (university === '') throw new Error('请先填写目标大学')
  if (typeof ctx.web?.fetch !== 'function') throw new Error('网页抓取服务不可用，请先在 DSH 中配置网页抓取')
  if (signal?.aborted) throw new Error('请求已取消')

  const searchResults = await searchOfficial(ctx, setup, signal, diagnostics)
  const provided = safeUrl(setup.officialUrl)
  const seed = provided
    ? { url: provided, title: '用户填写的官网', host: hostOf(provided) }
    : chooseOfficialSeed(searchResults, university)
  if (seed === undefined) {
    throw new Error('未能自动找到学校官网。请填写官网 URL 后重试，或在问题中检查网络/搜索配置。')
  }
  let officialHost = seed.host || hostOf(seed.url)
  const fetched = new Map()
  const errors = []

  async function fetchAndStore(url, reason) {
    const normalized = safeUrl(url)
    if (normalized === undefined) return undefined
    const host = hostOf(normalized)
    if (host !== officialHost) return undefined
    if (fetched.has(normalized)) return fetched.get(normalized)
    if (fetched.size >= MAX_PAGES) return undefined
    try {
      const page = await fetchPage(ctx, normalized, signal)
      if (fetched.size >= MAX_PAGES) return undefined
      const stored = { ...page, reason }
      fetched.set(normalized, stored)
      return stored
    } catch (error) {
      if (signal?.aborted) throw new Error('请求已取消')
      errors.push(`${new URL(normalized).pathname}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  // Start with the provided/search page, then its site root.
  const firstPage = await fetchAndStore(seed.url, '官网入口')
  if (firstPage !== undefined) {
    const redirectedHost = hostOf(firstPage.url)
    if (redirectedHost !== '') officialHost = redirectedHost
  }
  if (firstPage === undefined && provided === undefined) {
    // The search engine may have returned a stale deep link. Try origin once.
    const origin = (() => {
      try {
        return new URL(seed.url).origin
      } catch {
        return undefined
      }
    })()
    if (origin !== undefined) await fetchAndStore(origin, '官网首页')
  }
  const origin = (() => {
    try {
      return new URL(firstPage?.url || seed.url).origin
    } catch {
      return undefined
    }
  })()
  if (origin !== undefined) await fetchAndStore(origin, '官网首页')

  const homepage = [...fetched.values()].find((page) => {
    try {
      return new URL(page.url).pathname === '/'
    } catch {
      return false
    }
  }) ?? firstPage

  // Same-host, high-signal pages from search results.
  const searchCandidates = searchResults
    .filter((source) => hostOf(source.url) === officialHost)
    .map((source) => ({ url: safeUrl(source.url), score: scoreContentUrl(source.url, source.title ?? '') + 2, text: source.title ?? '' }))
    .filter((candidate) => candidate.url !== undefined)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)

  // Links discovered on the landing page/homepage.
  const linkCandidates = []
  for (const page of [firstPage, homepage]) {
    if (!page?.html) continue
    linkCandidates.push(...candidateLinks(page.html, page.url, officialHost))
  }

  const candidates = [...searchCandidates, ...linkCandidates]
    .filter((candidate) => typeof candidate.url === 'string')
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
  const seen = new Set(fetched.keys())
  const next = []
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue
    seen.add(candidate.url)
    next.push(candidate.url)
    if (next.length >= 6) break
  }

  await mapWithConcurrency(next, 2, async (url) => {
    if (signal?.aborted) return undefined
    return fetchAndStore(url, '相关页面')
  })

  if (fetched.size === 0) {
    diagnostics.push(...errors.slice(0, 8))
    throw new Error(`未能抓取到官网正文。请检查官网 URL，或稍后重试。${errors.length ? `（${errors[0]}）` : ''}`)
  }

  const pages = [...fetched.values()]
    .sort((left, right) => {
      const leftRoot = (() => { try { return new URL(left.url).pathname === '/' ? 1 : 0 } catch { return 0 } })()
      const rightRoot = (() => { try { return new URL(right.url).pathname === '/' ? 1 : 0 } catch { return 0 } })()
      if (leftRoot !== rightRoot) return rightRoot - leftRoot
      return scoreContentUrl(right.url, right.title) - scoreContentUrl(left.url, left.title)
    })
    .slice(0, MAX_PAGES)
    .map((page, index) => ({
      id: `S${index + 1}`,
      title: page.title || hostOf(page.url),
      url: page.url,
      text: page.text,
      chars: page.chars,
      reason: page.reason,
    }))

  const searchNotes = [
    `官网域名：${officialHost}`,
    `已抓取 ${pages.length} 个页面：${pages.map((page) => page.title).join(' / ')}`,
    searchResults.length ? `搜索命中 ${searchResults.length} 条，优先使用官网域名内的页面。` : '未使用搜索结果（直接抓取用户提供的官网）。',
    errors.length ? `部分页面抓取失败：${errors.slice(0, 4).join('；')}` : '',
  ].filter(Boolean).join('\n')

  return {
    sources: pages,
    officialUrl: origin || seed.url,
    diagnostics: [...diagnostics, ...errors.slice(0, 6)],
    searchNotes,
  }
}
