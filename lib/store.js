/** Local persistence for research caches and interview sessions. */

import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function resolveDataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'interview-dojo')
}

export function dataPaths(baseDir = resolveDataDir()) {
  return {
    baseDir,
    researchDir: join(baseDir, 'research'),
    sessionsDir: join(baseDir, 'sessions'),
    ttsDir: join(baseDir, 'tts'),
    archivesDir: join(baseDir, 'archives'),
  }
}

export async function ensureDataDirs(paths) {
  await fs.mkdir(paths.baseDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.researchDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.ttsDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(paths.archivesDir, { recursive: true, mode: 0o700 })
}

async function readJson(file) {
  const raw = await fs.readFile(file, 'utf8')
  return JSON.parse(raw)
}

async function writeJson(file, value) {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function writeTextFile(file, text) {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function archiveBaseName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 72)
  return cleaned === '' ? 'interview-dojo' : cleaned
}

export async function deleteSession(paths, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return false
  const file = join(paths.sessionsDir, `${id}.json`)
  try {
    await fs.rm(file, { force: true })
    return true
  } catch {
    return false
  }
}

export async function pruneArchives(paths, keep = 200) {
  try {
    const names = await fs.readdir(paths.archivesDir)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.md') && !name.endsWith('.doc')) continue
      const file = join(paths.archivesDir, name)
      const info = await fs.stat(file)
      files.push({ file, mtimeMs: info.mtimeMs })
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs)
    await Promise.all(files.slice(keep).map((entry) => fs.rm(entry.file, { force: true })))
  } catch {
    // Retention is best effort.
  }
}

/**
 * Persist a complete practice archive as both Markdown and a Word-compatible
 * HTML document. The browser also downloads these files; this copy survives a
 * later "clear and start new" action.
 */
export async function saveArchive(paths, input) {
  const markdown = typeof input?.markdown === 'string' ? input.markdown : ''
  const html = typeof input?.html === 'string' ? input.html : ''
  if (markdown === '' || html === '') throw new Error('存档内容为空')
  if (markdown.length > 4 * 1024 * 1024 || html.length > 6 * 1024 * 1024) {
    throw new Error('存档内容过大')
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = `${stamp}-${archiveBaseName(input?.baseName)}`
  const markdownFile = `${base}.md`
  const docFile = `${base}.doc`
  await fs.mkdir(paths.archivesDir, { recursive: true, mode: 0o700 })
  await writeTextFile(join(paths.archivesDir, markdownFile), markdown)
  await writeTextFile(join(paths.archivesDir, docFile), html)
  await pruneArchives(paths)
  return {
    markdown: markdownFile,
    doc: docFile,
    directory: paths.archivesDir,
  }
}

export function researchCacheKey(input) {
  return createHash('sha256')
    .update(JSON.stringify({
      university: input.university ?? '',
      faculty: input.faculty ?? '',
      major: input.major ?? '',
      program: input.program ?? '',
      format: input.format ?? '',
      jlpt: input.jlpt ?? '',
      officialUrl: input.officialUrl ?? '',
      statement: input.statement ?? '',
      model: input.model ?? null,
    }))
    .digest('hex')
}

export async function readResearchCache(paths, key) {
  try {
    return await readJson(join(paths.researchDir, `${key}.json`))
  } catch {
    return undefined
  }
}

export async function pruneResearch(paths, keep = 60) {
  try {
    const names = await fs.readdir(paths.researchDir)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(paths.researchDir, name)
      const info = await fs.stat(file)
      files.push({ file, mtimeMs: info.mtimeMs })
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs)
    await Promise.all(files.slice(keep).map((entry) => fs.rm(entry.file, { force: true })))
  } catch {
    // Retention is best effort.
  }
}

export async function writeResearchCache(paths, key, value) {
  await writeJson(join(paths.researchDir, `${key}.json`), value)
  await pruneResearch(paths)
}

export function createSessionRecord(value) {
  const now = new Date().toISOString()
  const session = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: 'active',
    ...value,
  }
  return session
}

export async function saveSession(paths, session) {
  if (typeof session?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(session.id)) {
    throw new Error('无效的会话 ID')
  }
  session.updatedAt = new Date().toISOString()
  await writeJson(join(paths.sessionsDir, `${session.id}.json`), session)
  return session
}

export async function readSession(paths, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return undefined
  try {
    return await readJson(join(paths.sessionsDir, `${id}.json`))
  } catch {
    return undefined
  }
}

export async function latestSession(paths) {
  let names = []
  try {
    names = await fs.readdir(paths.sessionsDir)
  } catch {
    return undefined
  }
  const files = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(paths.sessionsDir, name)
    try {
      const info = await fs.stat(file)
      if (info.isFile()) files.push({ file, mtimeMs: info.mtimeMs })
    } catch {
      // Ignore a file removed while listing.
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const entry of files) {
    try {
      return await readJson(entry.file)
    } catch {
      // A corrupt session must not block older valid ones.
    }
  }
  return undefined
}

/** Remove the oldest session files, keeping the newest `keep` records. */
export async function pruneSessions(paths, keep = 40) {
  try {
    const names = await fs.readdir(paths.sessionsDir)
    const files = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(paths.sessionsDir, name)
      const info = await fs.stat(file)
      files.push({ file, mtimeMs: info.mtimeMs })
    }
    files.sort((left, right) => right.mtimeMs - left.mtimeMs)
    await Promise.all(files.slice(keep).map((entry) => fs.rm(entry.file, { force: true })))
  } catch {
    // Retention is best effort; never fail a user action for it.
  }
}
