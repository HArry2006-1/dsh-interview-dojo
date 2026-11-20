/**
 * Text extraction and parsing helpers for the Interview Dojo plugin.
 *
 * Everything in this module is pure and Node-only. It deliberately avoids
 * importing any DSH package so it can be unit tested outside the Harness.
 */

import { inflateRawSync, inflateSync } from 'node:zlib'

export const STATEMENT_MAX_BYTES = 8 * 1024 * 1024
export const STATEMENT_MAX_CHARS = 24000

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'text', 'csv'])

function extensionOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename ?? '').trim())
  return match === null ? '' : match[1].toLowerCase()
}

function bufferStartsWith(buffer, bytes) {
  if (buffer.length < bytes.length) return false
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[index] !== bytes[index]) return false
  }
  return true
}

function printableRatio(text) {
  if (text.length === 0) return 0
  let printable = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      printable += 1
    }
  }
  return printable / Array.from(text).length
}

function cleanupText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Decode a BOM-aware text buffer. Falls back to Shift_JIS only when UTF-8 looks broken. */
export function decodeTextBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(3))
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2)
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1]
      swapped[index - 1] = buffer[index]
    }
    return new TextDecoder('utf-16le', { fatal: false }).decode(swapped)
  }

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (!utf8.includes('\uFFFD')) return utf8

  try {
    return new TextDecoder('shift_jis', { fatal: false }).decode(buffer)
  } catch {
    return utf8
  }
}

function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, decimal) => {
      try {
        return String.fromCodePoint(Number.parseInt(decimal, 10))
      } catch {
        return ''
      }
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

export function decodeEntities(text) {
  return decodeXmlEntities(text)
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Extract readable text from an HTML document without a DOM dependency. */
export function htmlToText(html) {
  let text = String(html ?? '')
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<(script|style|noscript|svg|iframe|canvas|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  text = text.replace(/<(br|hr)\b[^>]*>/gi, '\n')
  text = text.replace(/<\/(p|div|section|article|header|footer|main|aside|h[1-6]|li|tr|table|ul|ol|dl|dt|dd|form|blockquote)\s*>/gi, '\n')
  text = text.replace(/<(td|th)\b[^>]*>/gi, ' ')
  text = text.replace(/<[^>]+>/g, ' ')
  return cleanupText(decodeXmlEntities(text))
}

export function extractHtmlMeta(html) {
  const source = String(html ?? '')
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)
  const descriptionMatch = /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i.exec(source)
    ?? /<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["'][^>]*>/i.exec(source)
  const ogDescription = /<meta\b[^>]*property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/i.exec(source)
  return {
    title: cleanupText(decodeXmlEntities(titleMatch?.[1] ?? '')).slice(0, 200),
    description: cleanupText(decodeXmlEntities(descriptionMatch?.[1] ?? ogDescription?.[1] ?? '')).slice(0, 500),
  }
}

/** Extract anchors with their visible text, resolved against a base URL. */
export function extractLinks(html, baseUrl) {
  const source = String(html ?? '')
  const links = []
  const seen = new Set()
  const pattern = /<\s*a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi
  let match
  while ((match = pattern.exec(source)) !== null) {
    const href = decodeXmlEntities(match[1]).trim()
    if (href === '' || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) continue
    let url
    try {
      url = new URL(href, baseUrl)
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    url.hash = ''
    const key = url.toString()
    if (seen.has(key)) continue
    seen.add(key)
    links.push({
      url: key,
      text: cleanupText(decodeXmlEntities(match[2].replace(/<[^>]+>/g, ' '))).slice(0, 160),
    })
  }
  return links
}

// ---------------------------------------------------------------------------
// DOCX (minimal ZIP reader)
// ---------------------------------------------------------------------------

function findZipEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function readZipEntries(buffer) {
  const eocd = findZipEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('文件不是有效的 DOCX（找不到 ZIP 目录）')
  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 DOCX，请另存为普通 DOCX 后重试')
  }
  let cursor = directoryOffset
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) break
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntry(buffer, entry) {
  const local = entry.localOffset
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error('DOCX 压缩包损坏（本地文件头无效）')
  }
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) throw new Error('DOCX 压缩包损坏（数据越界）')
  const data = buffer.subarray(start, end)
  if (entry.uncompressedSize > 24 * 1024 * 1024) {
    throw new Error('DOCX 解压后过大，已停止读取')
  }
  if (entry.method === 0) return data
  if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: 24 * 1024 * 1024 })
  throw new Error(`暂不支持 DOCX 的压缩方式 ${entry.method}`)
}

function docxXmlToText(xml) {
  let text = String(xml ?? '')
  text = text.replace(/<w:tab\b[^>]*\/>/gi, '\t')
  text = text.replace(/<w:br\b[^>]*\/>/gi, '\n')
  text = text.replace(/<w:cr\b[^>]*\/>/gi, '\n')
  text = text.replace(/<\/w:p\s*>/gi, '\n')
  text = text.replace(/<\/w:tc\s*>/gi, '\t')
  text = text.replace(/<\/w:tr\s*>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  return cleanupText(decodeXmlEntities(text))
}

export function extractDocxText(buffer) {
  if (!bufferStartsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    throw new Error('文件不是有效的 DOCX（签名不符）')
  }
  const entries = readZipEntries(buffer)
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml')
  if (documentEntry === undefined) throw new Error('DOCX 中没有 word/document.xml')
  const xml = readZipEntry(buffer, documentEntry).toString('utf8')
  const text = docxXmlToText(xml)
  if (text === '') throw new Error('DOCX 中未找到可读正文')
  return text
}

// ---------------------------------------------------------------------------
// PDF (best-effort, text-based PDFs only)
// ---------------------------------------------------------------------------

function decodePdfHexString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      out += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
    }
    return out
  }
  let mostlyUtf16 = bytes.length >= 4 && bytes.length % 2 === 0
  if (mostlyUtf16) {
    for (let index = 0; index < bytes.length; index += 2) {
      if (bytes[index] !== 0) {
        mostlyUtf16 = false
        break
      }
    }
  }
  if (mostlyUtf16) {
    let out = ''
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      out += String.fromCharCode((bytes[index] << 8) | bytes[index + 1])
    }
    return out
  }
  return bytes.toString('latin1')
}

function decodePdfLiteralString(raw) {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== '\\') {
      out += char
      continue
    }
    index += 1
    const next = raw[index]
    if (next === undefined) break
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === '(' || next === ')' || next === '\\') out += next
    else if (next === '\n') {}
    else if (next === '\r') {
      if (raw[index + 1] === '\n') index += 1
    } else if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && /[0-7]/.test(raw[index + 1] ?? '')) {
        octal += raw[index + 1]
        index += 1
      }
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff)
    } else {
      out += next
    }
  }
  return out
}

function pdfContentToText(content) {
  const source = String(content ?? '')
  let output = ''
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char === '(') {
      let depth = 1
      let cursor = index + 1
      let raw = ''
      while (cursor < source.length && depth > 0) {
        const current = source[cursor]
        if (current === '\\') {
          raw += current
          cursor += 1
          if (cursor < source.length) {
            raw += source[cursor]
            cursor += 1
          }
          continue
        }
        if (current === '(') depth += 1
        if (current === ')') {
          depth -= 1
          if (depth === 0) break
        }
        raw += current
        cursor += 1
      }
      output += decodePdfLiteralString(raw)
      index = cursor + 1
      continue
    }
    if (char === '<' && source[index + 1] !== '<') {
      const end = source.indexOf('>', index + 1)
      if (end > index) {
        const hex = source.slice(index + 1, end).replace(/\s+/g, '')
        if (/^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0) {
          output += decodePdfHexString(Buffer.from(hex, 'hex'))
          index = end + 1
          continue
        }
      }
    }
    if (char === 'T' && (source[index + 1] === '*' || source[index + 1] === 'd' || source[index + 1] === 'D')) {
      output += '\n'
      index += 2
      continue
    }
    if (char === 'E' && source[index + 1] === 'T') {
      output += '\n'
      index += 2
      continue
    }
    index += 1
  }
  return cleanupText(
    output
      .replace(/\uFFFD/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n'),
  )
}

function extractPdfStreams(buffer) {
  const marker = Buffer.from('stream')
  const endMarker = Buffer.from('endstream')
  const chunks = []
  let cursor = 0
  while (cursor < buffer.length && chunks.length < 300) {
    const start = buffer.indexOf(marker, cursor)
    if (start < 0) break
    let dataStart = start + marker.length
    if (buffer[dataStart] === 0x0d) dataStart += 1
    if (buffer[dataStart] === 0x0a) dataStart += 1
    const end = buffer.indexOf(endMarker, dataStart)
    if (end < 0) break
    const dictionaryStart = Math.max(0, start - 600)
    const dictionary = buffer.subarray(dictionaryStart, start).toString('latin1')
    const data = buffer.subarray(dataStart, end)
    chunks.push({ data, flate: /\/FlateDecode\b/.test(dictionary) })
    cursor = end + endMarker.length
  }
  return chunks
}

export function extractPdfText(buffer) {
  if (!bufferStartsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    throw new Error('文件不是有效的 PDF（签名不符）')
  }
  const warnings = []
  const streams = extractPdfStreams(buffer)
  const parts = []
  let decodedBytes = 0
  let textChars = 0
  for (const stream of streams) {
    if (stream.data.length === 0) continue
    let decoded = stream.data
    if (stream.flate) {
      try {
        decoded = inflateSync(stream.data, { maxOutputLength: 24 * 1024 * 1024 })
      } catch {
        try {
          decoded = inflateRawSync(stream.data, { maxOutputLength: 24 * 1024 * 1024 })
        } catch {
          continue
        }
      }
    }
    decodedBytes += decoded.length
    if (decodedBytes > 40 * 1024 * 1024) {
      warnings.push('PDF 解压内容过大，只读取了前一部分。')
      break
    }
    const content = decoded.toString('latin1')
    if (!/\b(BT|Tj|TJ)\b/.test(content) && !content.includes('(')) continue
    const text = pdfContentToText(content)
    if (text !== '') {
      parts.push(text)
      textChars += text.length
      if (textChars > 1_000_000) break
    }
  }
  const text = cleanupText(parts.join('\n'))
  if (text === '') {
    warnings.push('未能从 PDF 提取文本：可能是扫描件，或使用了需要字体映射的日文 CID 编码。请在下方手动粘贴或修改理由书正文。')
    return { text: '', warnings }
  }
  if (printableRatio(text) < 0.55 || (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(text) && text.length > 20)) {
    warnings.push('PDF 文本可能不完整（部分日文字体使用 CID 编码，无法直接还原）。请检查下方正文，必要时手动修正。')
  }
  return { text: text.slice(0, STATEMENT_MAX_CHARS), warnings }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Extract statement text from an uploaded file.
 * @param {{filename: string, buffer: Buffer}} input
 * @returns {{text: string, kind: string, warnings: string[], chars: number}}
 */
export function extractDocument(input) {
  const filename = String(input?.filename ?? '理由书')
  const buffer = Buffer.isBuffer(input?.buffer) ? input.buffer : Buffer.from(input?.buffer ?? [])
  if (buffer.length === 0) throw new Error('文件为空')
  if (buffer.length > STATEMENT_MAX_BYTES) {
    throw new Error(`文件超过 ${Math.round(STATEMENT_MAX_BYTES / 1024 / 1024)}MB 上限`)
  }
  const extension = extensionOf(filename)
  const isPdf = bufferStartsWith(buffer, [0x25, 0x50, 0x44, 0x46])
  const isZip = bufferStartsWith(buffer, [0x50, 0x4b, 0x03, 0x04])
  let kind = extension
  let text = ''
  const warnings = []

  if (isPdf || extension === 'pdf') {
    kind = 'pdf'
    const result = extractPdfText(buffer)
    text = result.text
    warnings.push(...result.warnings)
  } else if (isZip || extension === 'docx') {
    kind = 'docx'
    text = extractDocxText(buffer)
  } else if (TEXT_EXTENSIONS.has(extension) || (!isPdf && !isZip && extension === '')) {
    kind = extension === '' ? 'text' : extension
    text = cleanupText(decodeTextBuffer(buffer))
  } else if (extension === 'doc') {
    throw new Error('暂不支持旧版 .doc，请在 Word 中另存为 .docx 或直接粘贴正文')
  } else {
    throw new Error(`暂不支持 .${extension || '未知'} 文件，请上传 .txt / .md / .docx / .pdf，或直接粘贴正文`)
  }

  text = cleanupText(text)
  text = text.slice(0, STATEMENT_MAX_CHARS)
  if (text === '') {
    warnings.push('没有提取到文字，请在下方手动粘贴或修改理由书正文。')
  }
  return { text, kind, warnings, chars: text.length }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** Find the first balanced JSON object in a model response and parse it. */
export function parseJsonLoose(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('模型返回为空')
  const unfenced = text
    .replace(/^\uFEFF/, '')
    .replace(/^```(?:json|JSON)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  const starts = []
  const objectStart = unfenced.indexOf('{')
  const arrayStart = unfenced.indexOf('[')
  if (objectStart >= 0) starts.push(objectStart)
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) starts.push(arrayStart)
  starts.sort((a, b) => a - b)

  for (const start of starts) {
    const open = unfenced[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < unfenced.length; index += 1) {
      const char = unfenced[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') {
        inString = true
        continue
      }
      if (char === open) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) {
          const slice = unfenced.slice(start, index + 1)
          const candidate = slice
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/[\u200b-\u200d\uFEFF]/g, '')
          try {
            const parsed = JSON.parse(candidate)
            if (open === '[' && Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'object') {
              return parsed[0]
            }
            return parsed
          } catch {
            break
          }
        }
      }
    }
  }

  // A final tolerant attempt: strip trailing commas and a leading label.
  const fallback = unfenced
    .replace(/^[^{[]*/, '')
    .replace(/[^}\]]*$/, '')
    .replace(/,\s*([}\]])/g, '$1')
  try {
    return JSON.parse(fallback)
  } catch {
    throw new Error('模型没有返回可解析的 JSON，请重试')
  }
}
