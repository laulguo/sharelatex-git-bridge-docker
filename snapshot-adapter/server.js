const http = require('http')
const { ObjectId, MongoClient } = require('mongodb')
const crypto = require('crypto')
const { createClient } = require('redis')

const port = Number(process.env.PORT || 8080)
const mongoUrl = process.env.MONGO_URL || 'mongodb://mongo/sharelatex'
const databaseName = process.env.MONGO_DATABASE || 'sharelatex'
const adapterToken = process.env.ADAPTER_TOKEN || ''
const gitToken = process.env.GIT_TOKEN || ''
const gitUserId = process.env.GIT_USER_ID || ''
const maxFileSize = Number(process.env.MAX_FILE_SIZE || 50 * 1024 * 1024)
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379'

let db
let redis

async function syncRedisDoc(docId, lines, version) {
  if (!redis) return
  const content = lines.join('\n')
  await redis.set(`doclines:${docId}`, JSON.stringify(lines))
  await redis.set(`DocHash:${docId}`, crypto.createHash('sha1').update(content).digest('hex'))
  await redis.set(`DocVersion:${docId}`, String(version))
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
  return Boolean(value && !value.startsWith('/') && !require('path').posix.normalize(value).startsWith('../') && !value.split('/').includes('..'))
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
  return json(res, 200, { srcs, atts: [] })
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
  return { folder, name }
}

function removePath(rootFolder, relativePath) {
  const parts = relativePath.split('/')
  const name = parts.pop()
  let folder = rootFolder.find(item => item.name === 'rootFolder')
  if (!folder) return
  for (const part of parts) {
    folder = (folder.folders || []).find(item => item.name === part)
    if (!folder) return
  }
  const index = (folder.docs || []).findIndex(item => item.name === name)
  if (index >= 0) folder.docs.splice(index, 1)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
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
  const rootFolder = JSON.parse(JSON.stringify(project.rootFolder || []))
  const pathMap = new Map()
  for (const folder of rootFolder) flattenFolder(folder, '', pathMap)
  const docs = db.collection('docs')
  for (const file of files) {
    if (!safeRelativePath(file.name)) return json(res, 400, { status: 400, message: `Unsafe file path: ${file.name}` })
    if (file.deleted) {
      const existing = pathMap.get(file.name)
      if (existing) await docs.deleteOne({ _id: ObjectId.isValid(existing._id) ? new ObjectId(existing._id) : existing._id })
      removePath(rootFolder, file.name)
      continue
    }
    const contents = file.contentBase64 ? Buffer.from(file.contentBase64, 'base64') : Buffer.from(file.content || '')
    if (contents.length > maxFileSize) return json(res, 413, { status: 413, message: `File too large: ${file.name}` })
    const existing = pathMap.get(file.name)
    if (existing) {
      const existingId = ObjectId.isValid(existing._id) ? new ObjectId(existing._id) : existing._id
      await docs.updateOne({ _id: existingId }, { $set: { lines: contents.toString('utf8').split('\n'), rev: currentVersion + 1 } })
      await syncRedisDoc(existingId.toString(), contents.toString('utf8').split('\n'), currentVersion + 1)
    } else {
      const id = new ObjectId()
      const location = folderForPath(rootFolder, file.name)
      location.folder.docs.push({ _id: id, name: location.name })
      await docs.insertOne({ _id: id, name: location.name, lines: contents.toString('utf8').split('\n'), project_id: projectId, ranges: {}, rev: 1 })
      await syncRedisDoc(id.toString(), contents.toString('utf8').split('\n'), currentVersion + 1)
    }
  }
  const versionId = currentVersion + 1
  await db.collection('projects').updateOne({ _id: projectId }, { $set: { rootFolder, version: versionId, lastUpdated: new Date() } })
  if (body.postbackUrl) {
    try { await fetch(body.postbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId }) }) } catch (error) { console.error('postback failed', error) }
  }
  return json(res, 200, { versionId })
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
  return json(res, 404, { status: 404, message: 'Not found' })
}

async function main() {
  const client = new MongoClient(mongoUrl)
  await client.connect()
  db = client.db(databaseName)
  redis = createClient({ url: redisUrl })
  redis.on('error', error => console.error('redis error', error))
  await redis.connect()
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
