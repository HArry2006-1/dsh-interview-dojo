import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createSessionRecord,
  dataPaths,
  deleteSession,
  ensureDataDirs,
  readSession,
  saveArchive,
  saveSession,
} from '../lib/store.js'

test('archives a practice document and deletes the current session', async (t) => {
  const base = join(tmpdir(), `dsh-interview-dojo-archive-${process.pid}-${Date.now()}`)
  const paths = dataPaths(base)
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  })
  await ensureDataDirs(paths)

  const archive = await saveArchive(paths, {
    baseName: '早稲田大学/経済学科',
    markdown: '# 面试道场存档\n\n- 目标大学：早稲田大学\n',
    html: '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>面试道场存档</h1></body></html>',
  })
  assert.match(archive.markdown, /\.md$/)
  assert.match(archive.doc, /\.doc$/)
  assert.equal(archive.directory, paths.archivesDir)
  const markdown = await fs.readFile(join(paths.archivesDir, archive.markdown), 'utf8')
  assert.match(markdown, /早稲田大学/)
  assert.match(archive.markdown, /早稲田大学/)

  const session = createSessionRecord({ setup: { university: '早稲田大学' }, turns: [] })
  await saveSession(paths, session)
  assert.ok(await readSession(paths, session.id))
  assert.equal(await deleteSession(paths, session.id), true)
  assert.equal(await readSession(paths, session.id), undefined)
})
