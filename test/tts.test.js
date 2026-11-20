import assert from 'node:assert/strict'
import test from 'node:test'

import { EDGE_VOICES, edgeTtsAvailable } from '../lib/tts.js'

test('optional Edge neural TTS dependency resolves with Japanese voices', async () => {
  assert.equal(await edgeTtsAvailable(), true)
  assert.ok(EDGE_VOICES.some((voice) => voice.id === 'ja-JP-NanamiNeural'))
  assert.ok(EDGE_VOICES.some((voice) => voice.id === 'ja-JP-KeitaNeural'))
})
