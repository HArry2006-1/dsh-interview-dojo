import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} exists in client.js`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  let inString = false
  let quote = ''
  let escaped = false
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) inString = false
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = true
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${name} has an unterminated body`)
}

test('client-side WAV encoder writes canonical 16 kHz mono PCM16', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const code = `${extractFunction(source, 'encodeWavPcm16')}\nreturn encodeWavPcm16`
  const encodeWavPcm16 = new Function(code)()
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
  const bytes = encodeWavPcm16(samples, 16000)
  assert.equal(bytes.length, 44 + samples.length * 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset, length) => Buffer.from(bytes.slice(offset, offset + length)).toString('ascii')
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(view.getUint32(4, true), 36 + samples.length * 2)
  assert.equal(text(8, 4), 'WAVE')
  assert.equal(text(12, 4), 'fmt ')
  assert.equal(view.getUint32(16, true), 16)
  assert.equal(view.getUint16(20, true), 1)
  assert.equal(view.getUint16(22, true), 1)
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(28, true), 32000)
  assert.equal(view.getUint16(32, true), 2)
  assert.equal(view.getUint16(34, true), 16)
  assert.equal(text(36, 4), 'data')
  assert.equal(view.getUint32(40, true), samples.length * 2)
  assert.equal(view.getInt16(44, true), 0)
  assert.equal(view.getInt16(46, true), 16383)
  assert.equal(view.getInt16(48, true), -16384)
  assert.equal(view.getInt16(50, true), 32767)
  assert.equal(view.getInt16(52, true), -32768)
})
