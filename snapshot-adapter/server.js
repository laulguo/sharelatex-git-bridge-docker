const http = require('http')
const fsp = require('fs').promises
const path = require('path')
const { ObjectId, MongoClient } = require('mongodb')
const crypto = require('crypto')

const port = Number(process.env.PORT || 8080)
const mongoUrl = process.env.MONGO_URL || 'mongodb://mongo/sharelatex'
const databaseName = process.env.MONGO_DATABASE || 'sharelatex'
const adapterToken = process.env.ADAPTER_TOKEN || ''
const gitToken = process.env.GIT_TOKEN || ''
const gitUserId = process.env.GIT_USER_ID || ''
const maxFileSize = Number(process.env.MAX_FILE_SIZE || 50 * 1024 * 1024)
// ShareLaTeX 3.4.0 keeps uploaded binaries as flat files named
// "<project-id>_<file-id>" under the filestore "fs" backend. The add-on mounts
// that directory read/write so attachments can cross the Git boundary.
const userFilesDir = process.env.USER_FILES_DIR || '/data/user_files'
// document-updater owns the live document state: an in-memory copy plus a
// (doclines, DocVersion, docops) triple in Redis. A pull replaces that content,
// so the document has to be evicted through that service's own API first.
const docUpdaterUrl = (process.env.DOC_UPDATER_URL || 'http://sharelatex:3003').replace(/\/$/, '')

let db

// Evict one document from document-updater. Its delete endpoint flushes pending
// editor edits to Mongo and then drops the cached state, so the write that
// follows is the single source of truth and the next open reloads from Mongo.
// Writing Mongo behind its back instead leaves a version gap in Redis, which the
// editor reports as "doc ops range is not loaded in redis" and which silently
// swallows every subsequent edit.
async function evictDocFromDocUpdater(projectId, docId) {
  try {
    const response = await fetch(
      `${docUpdaterUrl}/project/${projectId}/doc/${docId}?ignore_flush_errors=true`,
      { method: 'DELETE' }
    )
    if (!response.ok) console.error(`docupdater evict ${docId} returned ${response.status}`)
  } catch (error) {
    console.error(`docupdater evict ${docId} failed: ${error.message}`)
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(payload))
  res.end(payload)
}

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="snapshot-adapter"')
  json(res, 401, { status: 401, message: 'Unauthorized' })
}

function authorized(req) {
  const userId = req.headers['x-git-user-id'] || gitUserId || null
  if (!adapterToken && !gitToken) return { internal: true, userId }
  const header = req.headers.authorization || ''
  if (adapterToken && header === `Bearer ${adapterToken}`) return { internal: true, userId }
  if (gitToken && header === `Bearer ${gitToken}`) return { internal: false, userId }
  return null
}

function safeRelativePath(value) {
  return Boolean(value && !value.startsWith('/') && !path.posix.normalize(value).startsWith('../') && !value.split('/').includes('..'))
}

function toObjectId(value) {
  return ObjectId.isValid(value) ? new ObjectId(value) : value
}

function userFilePath(projectId, fileId) {
  return path.join(userFilesDir, `${String(projectId)}_${String(fileId)}`)
}

// Binaries cannot round-trip through UTF-8, so anything that fails the
// round-trip (or carries a NUL byte) is treated as an uploaded file rather
// than a text document. This keeps PDFs, images and fonts out of `docs`.
function isBinaryContents(buffer) {
  if (buffer.includes(0)) return true
  return !Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer)
}

// ShareLaTeX stores the git blob hash in `fileRefs[].hash` (see
// services/web/app/src/Features/FileStore/FileHashManager.js), so this must
// hash "blob <length>\0" plus the bytes, not the bare bytes.
function gitBlobHash(buffer) {
  return crypto.createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

function collectFileRefs(folder, prefix, output) {
  if (!folder || typeof folder !== 'object') return
  const currentPrefix = prefix && folder.name !== 'rootFolder'
    ? `${prefix}/${folder.name}`
    : prefix

  for (const ref of folder.fileRefs || []) {
    if (ref && ref._id) {
      output.set(currentPrefix ? `${currentPrefix}/${ref.name}` : ref.name, ref)
    }
  }
  for (const child of folder.folders || []) {
    collectFileRefs(child, currentPrefix, output)
  }
}

function projectIdFrom(pathname) {
  const value = pathname.split('/')[4]
  if (!value || !ObjectId.isValid(value)) return null
  return new ObjectId(value)
}

function collectDocs(folder, prefix, output) {
  if (!folder || typeof folder !== 'object') return
  const currentPrefix = prefix && folder.name !== 'rootFolder'
    ? `${prefix}/${folder.name}`
    : prefix

  for (const doc of folder.docs || []) {
    if (doc && doc._id) {
      output.set(String(doc._id), currentPrefix ? `${currentPrefix}/${doc.name}` : doc.name)
    }
  }
  for (const child of folder.folders || []) {
    collectDocs(child, currentPrefix, output)
  }
}

async function findProject(id) {
  return db.collection('projects').findOne({ _id: id })
}

async function getDoc(req, res, projectId) {
  const project = await findProject(projectId)
  if (!project) return json(res, 404, { status: 404, message: 'Project not found' })

  const latest = await db.collection('docs')
    .find({ project_id: projectId })
    .sort({ rev: -1 })
    .limit(1)
    .next()
  const latestVersion = Number(project.version || latest?.rev || 0)
  const user = project.lastUpdatedByUser || {}
  return json(res, 200, {
    latestVerId: latestVersion,
    latestVerAt: project.lastUpdated || null,
    latestVerBy: {
      email: user.email || '',
      name: user.name || '',
    },
  })
}

async function getSavedVersions(req, res, projectId) {
  const project = await findProject(projectId)
  if (!project) return json(res, 404, { status: 404, message: 'Project not found' })
  return json(res, 200, [])
}

async function getSnapshot(req, res, projectId, requestedVersion) {
  const project = await findProject(projectId)
  if (!project) return json(res, 404, { status: 404, message: 'Project not found' })

  const docs = new Map()
  collectDocs({ folders: project.rootFolder || [] }, '', docs)
  const rows = await db.collection('docs').find({ project_id: projectId }).toArray()
  const srcs = rows.map(doc => [
    (doc.lines || []).join('\n'),
    docs.get(String(doc._id)) || String(doc._id),
  ])
  const latestVersion = Number(project.version || rows.reduce((max, doc) => Math.max(max, Number(doc.rev || 0)), 0))
  if (Number(requestedVersion) !== latestVersion && !(latestVersion === 0 && Number(requestedVersion) === 0)) {
    return json(res, 404, { status: 404, message: 'Version not found' })
  }

  // Uploaded binaries live in the filestore, not in `docs`. Without this the
  // snapshot silently drops every image, PDF and font the project references.
  const fileRefs = new Map()
  for (const folder of project.rootFolder || []) collectFileRefs(folder, '', fileRefs)
  const atts = []
  for (const [relativePath, ref] of fileRefs) {
    try {
      const contents = await fsp.readFile(userFilePath(projectId, ref._id))
      atts.push({ path: relativePath, content: contents.toString('base64'), hash: ref.hash || gitBlobHash(contents) })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return json(res, 200, { srcs, atts })
}

function flattenFolder(folder, prefix, result) {
  if (!folder) return
  const current = prefix && folder.name !== 'rootFolder' ? `${prefix}/${folder.name}` : prefix
  for (const doc of folder.docs || []) result.set(current ? `${current}/${doc.name}` : doc.name, doc)
  for (const child of folder.folders || []) flattenFolder(child, current, result)
}

function folderForPath(rootFolder, relativePath) {
  const parts = relativePath.split('/')
  const name = parts.pop()
  let folder = rootFolder.find(item => item.name === 'rootFolder')
  if (!folder) {
    folder = { _id: new ObjectId(), name: 'rootFolder', docs: [], fileRefs: [], folders: [] }
    rootFolder.push(folder)
  }
  for (const part of parts) {
    let child = (folder.folders || []).find(item => item.name === part)
    if (!child) {
      child = { _id: new ObjectId(), name: part, docs: [], fileRefs: [], folders: [] }
      folder.folders ||= []
      folder.folders.push(child)
    }
    folder = child
  }
  folder.docs ||= []
  folder.fileRefs ||= []
  return { folder, name }
}

function removePath(rootFolder, relativePath) {
  const parts = relativePath.split('/')
  const name = parts.pop()
  let folder = rootFolder.find(item => item.name === 'rootFolder')
  if (!folder) return null
  for (const part of parts) {
    folder = (folder.folders || []).find(item => item.name === part)
    if (!folder) return null
  }
  const docIndex = (folder.docs || []).findIndex(item => item.name === name)
  if (docIndex >= 0) return { type: 'doc', entry: folder.docs.splice(docIndex, 1)[0] }
  const refIndex = (folder.fileRefs || []).findIndex(item => item.name === name)
  if (refIndex >= 0) return { type: 'file', entry: folder.fileRefs.splice(refIndex, 1)[0] }
  return null
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function writeTextEntry(ctx, relativePath, contents) {
  const { docs, rootFolder, pathMap, fileMap, projectId, version } = ctx
  const lines = contents.toString('utf8').split('\n')
  const asFile = fileMap.get(relativePath)
  if (asFile) {
    await fsp.rm(userFilePath(projectId, asFile._id), { force: true })
    removePath(rootFolder, relativePath)
    fileMap.delete(relativePath)
  }
  const existing = pathMap.get(relativePath)
  if (existing) {
    const existingId = toObjectId(existing._id)
    await evictDocFromDocUpdater(projectId, existingId)
    await docs.updateOne({ _id: existingId }, { $set: { lines, rev: version } })
    return
  }
  const location = folderForPath(rootFolder, relativePath)
  const id = new ObjectId()
  location.folder.docs.push({ _id: id, name: location.name })
  await docs.insertOne({ _id: id, name: location.name, lines, project_id: projectId, ranges: {}, rev: 1 })
  pathMap.set(relativePath, { _id: id, name: location.name })
}

async function writeBinaryEntry(ctx, relativePath, contents) {
  const { docs, rootFolder, pathMap, fileMap, projectId } = ctx
  const asDoc = pathMap.get(relativePath)
  if (asDoc) {
    const asDocId = toObjectId(asDoc._id)
    await evictDocFromDocUpdater(projectId, asDocId)
    await docs.deleteOne({ _id: asDocId })
    removePath(rootFolder, relativePath)
    pathMap.delete(relativePath)
  }
  const existing = fileMap.get(relativePath)
  const fileId = existing && existing._id ? existing._id : new ObjectId()
  const target = userFilePath(projectId, fileId)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, contents)
  const location = folderForPath(rootFolder, relativePath)
  location.folder.fileRefs ||= []
  const ref = {
    name: location.name,
    rev: existing?.rev || 0,
    _id: fileId,
    hash: gitBlobHash(contents),
    created: existing && existing.created ? new Date(existing.created) : new Date(),
  }
  const refIndex = location.folder.fileRefs.findIndex(item => String(item._id) === String(fileId))
  if (refIndex >= 0) location.folder.fileRefs[refIndex] = ref
  else location.folder.fileRefs.push(ref)
  fileMap.set(relativePath, ref)
}

async function pushSnapshot(req, res, projectId, auth) {
  const project = await findProject(projectId)
  if (!project) return json(res, 404, { status: 404, message: 'Project not found' })
  if (!auth.internal && auth.userId) {
    const allowed = [project.owner_ref, ...(project.collaberator_refs || [])].some(id => String(id) === String(auth.userId))
    if (!allowed) return json(res, 403, { status: 403, message: 'Project is not writable by this user' })
  }
  const body = JSON.parse(await readBody(req))
  const expectedVersion = Number(body.latestVerId)
  const currentVersion = Number(project.version || 0)
  if (expectedVersion !== currentVersion) return json(res, 409, { status: 409, message: 'Project is out of date', currentVersion })
  const files = Array.isArray(body.files) ? body.files : []
  if (files.length > 2000) return json(res, 413, { status: 413, message: 'Too many files' })
  // Mutate the document straight out of Mongo instead of deep-cloning it through
  // JSON: a JSON round-trip turns ObjectIds into hex strings and fileRef
  // `created` Dates into strings, and the editor calls file.created.getTime(),
  // which then throws and every compile fails with a 500.
  const rootFolder = project.rootFolder || []
  const pathMap = new Map()
  const fileMap = new Map()
  for (const folder of rootFolder) {
    flattenFolder(folder, '', pathMap)
    collectFileRefs(folder, '', fileMap)
  }
  const docs = db.collection('docs')
  const ctx = { docs, rootFolder, pathMap, fileMap, projectId, version: currentVersion + 1 }
  for (const file of files) {
    if (!safeRelativePath(file.name)) return json(res, 400, { status: 400, message: `Unsafe file path: ${file.name}` })
    if (file.deleted) {
      const docEntry = pathMap.get(file.name)
      if (docEntry) {
        const docEntryId = toObjectId(docEntry._id)
        await evictDocFromDocUpdater(projectId, docEntryId)
        await docs.deleteOne({ _id: docEntryId })
      }
      const fileEntry = fileMap.get(file.name)
      if (fileEntry) await fsp.rm(userFilePath(projectId, fileEntry._id), { force: true })
      removePath(rootFolder, file.name)
      pathMap.delete(file.name)
      fileMap.delete(file.name)
      continue
    }
    const contents = file.contentBase64 ? Buffer.from(file.contentBase64, 'base64') : Buffer.from(file.content || '')
    if (contents.length > maxFileSize) return json(res, 413, { status: 413, message: `File too large: ${file.name}` })
    if (isBinaryContents(contents)) await writeBinaryEntry(ctx, file.name, contents)
    else await writeTextEntry(ctx, file.name, contents)
  }
  const versionId = currentVersion + 1
  await db.collection('projects').updateOne({ _id: projectId }, { $set: { rootFolder, version: versionId, lastUpdated: new Date() } })
  if (body.postbackUrl) {
    try { await fetch(body.postbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId }) }) } catch (error) { console.error('postback failed', error) }
  }
  return json(res, 200, { versionId })
}

// Flush every document of a project from document-updater into Mongo, so a
// subsequent snapshot reflects what the editor currently shows. Without this the
// import silently captures text that is one or more edits behind.
async function flushProjectDocs(req, res, projectId) {
  const rows = await db.collection('docs').find({ project_id: projectId }, { projection: { _id: 1 } }).toArray()
  let flushed = 0
  const failures = []
  for (const row of rows) {
    const docId = String(row._id)
    try {
      const response = await fetch(`${docUpdaterUrl}/project/${projectId}/doc/${docId}/flush`, { method: 'POST' })
      if (response.ok) flushed++
      else failures.push(`${docId}:${response.status}`)
    } catch (error) {
      failures.push(`${docId}:${error.message}`)
    }
  }
  return json(res, 200, { flushed, total: rows.length, failures })
}

async function route(req, res) {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true })
  const auth = authorized(req)
  if (!auth) return unauthorized(res)

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'v0' || parts[2] !== 'docs') {
    return json(res, 404, { status: 404, message: 'Not found' })
  }
  const projectId = projectIdFrom(url.pathname)
  if (!projectId) return json(res, 400, { status: 400, message: 'Invalid project id' })

  if (parts.length === 4 && req.method === 'GET') return getDoc(req, res, projectId)
  if (parts.length === 5 && parts[4] === 'saved_vers' && req.method === 'GET') {
    return getSavedVersions(req, res, projectId)
  }
  if (parts.length === 6 && parts[4] === 'snapshots' && req.method === 'GET') {
    return getSnapshot(req, res, projectId, parts[5])
  }
  if (parts.length === 5 && parts[4] === 'snapshots' && req.method === 'POST') {
    return pushSnapshot(req, res, projectId, auth)
  }
  if (parts.length === 5 && parts[4] === 'flush' && req.method === 'POST') {
    return flushProjectDocs(req, res, projectId)
  }
  return json(res, 404, { status: 404, message: 'Not found' })
}

async function main() {
  const client = new MongoClient(mongoUrl)
  await client.connect()
  db = client.db(databaseName)
  const server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      console.error(error)
      json(res, 500, { status: 500, message: 'Internal server error' })
    })
  })
  server.listen(port, '0.0.0.0', () => console.log(`snapshot adapter listening on ${port}`))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
