const fs = require('fs')
const fsp = fs.promises
const http = require('http')
const os = require('os')
const path = require('path')
const { execFile, execFileSync, spawn } = require('child_process')

const port = Number(process.env.PORT || 8080)
const repoRoot = process.env.REPO_ROOT || '/data/repos'
const snapshotApiBase = (process.env.SNAPSHOT_API_BASE || 'http://snapshot-adapter:8080').replace(/\/$/, '')
const gitUsername = process.env.GIT_USERNAME || 'git'
const authMode = process.env.AUTH_MODE || 'token'
const gitToken = process.env.GIT_TOKEN || ''
const adapterToken = process.env.ADAPTER_TOKEN || ''
const internalHookToken = process.env.INTERNAL_HOOK_TOKEN || ''
const githubToken = process.env.GITHUB_TOKEN || ''
const githubTokens = new Map()
const gitHttpBackend = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend')
const bootstrapLocks = new Map()
const pushLocks = new Map()

// The editor page can be served from any host or port, so the allowed origin is
// configured rather than hardcoded. Unset CORS_ORIGINS reflects the caller's
// Origin, which makes :2333, :2334, plain HTTP and HTTPS all work unchanged.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
function cors(res) {
  const origin = (res.req && res.req.headers && res.req.headers.origin) || ''
  const wildcard = corsOrigins.includes('*')
  const allow = wildcard ? '*' : (corsOrigins.length ? (corsOrigins.includes(origin) ? origin : corsOrigins[0]) : (origin || '*'))
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}
function json(res, status, body) { const payload = JSON.stringify(body); cors(res); res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Length', Buffer.byteLength(payload)); res.end(payload) }
function safeRelativePath(value) { return Boolean(value && !value.startsWith('/') && !path.posix.normalize(value).startsWith('../') && !value.split('/').includes('..')) }
function runGit(args, cwd) { return new Promise((resolve, reject) => execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout))) }
async function fetchJson(url) { const response = await fetch(url, { headers: { Authorization: `Bearer ${adapterToken}` } }); if (!response.ok) throw new Error(`Snapshot API returned ${response.status} for ${url}`); return response.json() }
async function installPushHook(repoPath) {
  await runGit(['config', 'http.receivepack', 'true'], repoPath)
  await fsp.writeFile(path.join(repoPath, 'hooks', 'pre-receive'), `#!/bin/sh\nexec node /app/push-hook.js "${path.basename(repoPath, '.git')}" "${internalHookToken}" "${repoPath}"\n`, { mode: 0o755 })
}

async function bootstrapRepository(projectId) {
  const repoPath = path.join(repoRoot, `${projectId}.git`)
  try {
    await fsp.access(path.join(repoPath, 'HEAD'))
    await installPushHook(repoPath)
    return repoPath
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (bootstrapLocks.has(projectId)) return bootstrapLocks.get(projectId)
  const pending = (async () => {
    const doc = await fetchJson(`${snapshotApiBase}/api/v0/docs/${projectId}`)
    const snapshot = await fetchJson(`${snapshotApiBase}/api/v0/docs/${projectId}/snapshots/${doc.latestVerId}`)
    const workTree = await fsp.mkdtemp(path.join(os.tmpdir(), `sharelatex-${projectId}-`))
    try {
      await runGit(['init', '-b', 'main', workTree]); await runGit(['config', 'user.name', 'ShareLaTeX Git Bridge'], workTree); await runGit(['config', 'user.email', 'git-bridge@localhost'], workTree)
      for (const [contents, relativePath] of snapshot.srcs || []) { if (!safeRelativePath(relativePath)) throw new Error(`Unsafe snapshot path: ${relativePath}`); const target = path.join(workTree, ...relativePath.split('/')); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, contents) }
      // Attachments are uploaded binaries (images, PDFs, fonts). They arrive
      // base64 encoded and must be written byte for byte, never as text.
      for (const att of snapshot.atts || []) { if (!att || !safeRelativePath(att.path)) throw new Error(`Unsafe attachment path: ${att?.path}`); const target = path.join(workTree, ...att.path.split('/')); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, Buffer.from(att.content || '', 'base64')) }
      await runGit(['add', '--all'], workTree); await runGit(['commit', '--allow-empty', '-m', `Import ShareLaTeX version ${doc.latestVerId}`], workTree); await fsp.mkdir(repoRoot, { recursive: true }); await runGit(['clone', '--bare', workTree, repoPath]); await installPushHook(repoPath); return repoPath
    } finally { await fsp.rm(workTree, { recursive: true, force: true }) }
  })()
  bootstrapLocks.set(projectId, pending)
  try { return await pending } finally { bootstrapLocks.delete(projectId) }
}

function parseProject(pathname) { const match = pathname.match(/^\/([0-9a-f]{24})(?:\.git)?(?:\/.*)?$/); return match && match[1] }
function parseBasicAuth(req) { const value = req.headers.authorization || ''; if (!value.startsWith('Basic ')) return null; const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8'); const split = decoded.indexOf(':'); return split < 0 ? null : { username: decoded.slice(0, split), password: decoded.slice(split + 1) } }
function requireGitAuth(req, res) {
  if (authMode === 'trusted') return true
  const credentials = parseBasicAuth(req)
  if (credentials?.username === gitUsername && credentials.password === gitToken) return true
  res.setHeader('WWW-Authenticate', 'Basic realm="ShareLaTeX Git Bridge"')
  json(res, 401, { status: 401, message: 'Use username git and a Git token as the password' })
  return false
}
function gitTree(repoPath, commit, gitEnv) { return new Promise((resolve, reject) => execFile('git', ['ls-tree', '-r', '-z', '--name-only', commit], { cwd: repoPath, env: { ...process.env, ...gitEnv }, encoding: 'buffer' }, (error, stdout, stderr) => error ? reject(new Error(stderr.toString())) : resolve(stdout.toString().split('\0').filter(Boolean)))) }
function gitFile(repoPath, commit, relativePath, gitEnv) { return new Promise((resolve, reject) => execFile('git', ['show', `${commit}:${relativePath}`], { cwd: repoPath, env: { ...process.env, ...gitEnv }, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr.toString())) : resolve(stdout))) }
async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8') }

async function pushCommit(projectId, repoPath, oldId, newId, ref, gitEnv) {
  if (ref !== 'refs/heads/main') throw new Error('Only refs/heads/main is supported')
  if (/^0+$/.test(oldId) || /^0+$/.test(newId)) throw new Error('Creating or deleting the main branch is not supported')
  while (pushLocks.has(projectId)) await pushLocks.get(projectId)
  let release; const pending = new Promise(resolve => { release = resolve }); pushLocks.set(projectId, pending)
  try {
    const newPaths = await gitTree(repoPath, newId, gitEnv); const oldPaths = await gitTree(repoPath, oldId, gitEnv); const newSet = new Set(newPaths); const files = []
    for (const relativePath of newPaths) { if (!safeRelativePath(relativePath)) throw new Error(`Unsafe file path: ${relativePath}`); files.push({ name: relativePath, contentBase64: (await gitFile(repoPath, newId, relativePath, gitEnv)).toString('base64') }) }
    for (const relativePath of oldPaths) if (!newSet.has(relativePath)) files.push({ name: relativePath, deleted: true })
    const doc = await fetchJson(`${snapshotApiBase}/api/v0/docs/${projectId}`)
    const response = await fetch(`${snapshotApiBase}/api/v0/docs/${projectId}/snapshots`, { method: 'POST', headers: { Authorization: `Bearer ${adapterToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ latestVerId: doc.latestVerId, files }) })
    const body = await response.json(); if (!response.ok) throw new Error(body.message || `Snapshot API returned ${response.status}`)
  } finally { release(); pushLocks.delete(projectId) }
}
async function internalPush(req, res, projectId) { if (req.headers['x-bridge-internal'] !== internalHookToken || !/^[0-9a-f]{24}$/.test(projectId)) return json(res, 401, { status: 401, message: 'Unauthorized hook' }); const body = JSON.parse(await readBody(req)); await pushCommit(projectId, body.repoPath, body.oldId, body.newId, body.ref, body.gitEnv || {}); return json(res, 200, { ok: true }) }

function githubConfigPath(projectId) { return path.join(repoRoot, `${projectId}.github.json`) }
function githubTokenPath(projectId) { return path.join(repoRoot, `${projectId}.github-token`) }
function githubSyncStatePath(projectId) { return path.join(repoRoot, `${projectId}.github-sync.json`) }
function validateGithubUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.pathname.endsWith('.git') && Boolean(parsed.hostname) && !parsed.search && !parsed.hash
  } catch { return false }
}
async function readGithubConfig(projectId) { try { return JSON.parse(await fsp.readFile(githubConfigPath(projectId), 'utf8')) } catch { return null } }
async function readGithubSyncState(projectId) { try { return JSON.parse(await fsp.readFile(githubSyncStatePath(projectId), 'utf8')) } catch { return {} } }
async function writeGithubSyncState(projectId, state) { await fsp.writeFile(githubSyncStatePath(projectId), JSON.stringify(state, null, 2)) }
async function readGithubToken(projectId) { if (githubTokens.has(projectId)) return githubTokens.get(projectId); try { return (await fsp.readFile(githubTokenPath(projectId), 'utf8')).trim() } catch { return githubToken } }
async function githubGitArgs(projectId, args) {
  const config = await readGithubConfig(projectId)
  let embeddedCredentials = false
  if (config?.remoteUrl) {
    try { const parsed = new URL(config.remoteUrl); embeddedCredentials = Boolean(parsed.username || parsed.password) } catch {}
  }
  const token = await readGithubToken(projectId)
  return token && !embeddedCredentials ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`git:${token}`).toString('base64')}`, ...args] : args
}

async function githubApi(req, res, projectId, action) {
  if (!/^[0-9a-f]{24}$/.test(projectId)) return json(res, 400, { status: 400, message: 'Invalid project id' })
  const repoPath = await bootstrapRepository(projectId)
  let config = await readGithubConfig(projectId)
  if (req.method === 'GET') return json(res, 200, { configured: Boolean(config), remoteUrl: config?.remoteUrl || null, tokenConfigured: Boolean(await readGithubToken(projectId)) })
  if (action === 'forget' && req.method === 'POST') {
    githubTokens.delete(projectId)
    await fsp.rm(githubTokenPath(projectId), { force: true })
    await fsp.rm(githubConfigPath(projectId), { force: true })
    return json(res, 200, { configured: false, tokenConfigured: false })
  }
  const body = JSON.parse(await readBody(req) || '{}')
  if (action === 'configure') {
    if (!validateGithubUrl(body.remoteUrl)) return json(res, 400, { status: 400, message: 'Use an HTTPS Git URL ending in .git' })
    await runGit(['remote', 'remove', 'github'], repoPath).catch(() => {})
    await runGit(['remote', 'add', 'github', body.remoteUrl], repoPath)
    await fsp.writeFile(githubConfigPath(projectId), JSON.stringify({ remoteUrl: body.remoteUrl }, null, 2))
    if (body.token) {
      githubTokens.set(projectId, body.token)
      await fsp.writeFile(githubTokenPath(projectId), `${body.token}\n`, { mode: 0o600 })
    }
    return json(res, 200, { configured: true, remoteUrl: body.remoteUrl, tokenConfigured: Boolean(await readGithubToken(projectId)) })
  }
  if (!config) return json(res, 400, { status: 400, message: 'Configure a Git remote first' })
  if (action === 'push') {
    await runGit(await githubGitArgs(projectId, ['push', 'github', 'main']), repoPath)
    await writeGithubSyncState(projectId, { lastAppliedCommit: (await runGit(['rev-parse', 'refs/heads/main'], repoPath)).trim() })
    return json(res, 200, { ok: true, action: 'push' })
  }
  if (action === 'pull') {
    await runGit(await githubGitArgs(projectId, ['fetch', 'github', 'main']), repoPath)
    const oldId = (await runGit(['rev-parse', 'refs/heads/main'], repoPath)).trim()
    const newId = (await runGit(['rev-parse', 'refs/remotes/github/main'], repoPath)).trim()
    const syncState = await readGithubSyncState(projectId)
    const needsApply = syncState.lastAppliedCommit !== newId
    if (needsApply) {
      await pushCommit(projectId, repoPath, oldId, newId, 'refs/heads/main', {})
      await writeGithubSyncState(projectId, { lastAppliedCommit: newId })
    }
    if (oldId !== newId) {
      await runGit(['update-ref', 'refs/heads/main', newId], repoPath)
    }
    return json(res, 200, { ok: true, action: 'pull', changed: needsApply, commit: newId })
  }
  return json(res, 404, { status: 404, message: 'Unknown Git remote action' })
}

function serveGit(req, res, projectId) {
  bootstrapRepository(projectId).then(() => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); const prefix = `/${projectId}.git`; const env = { ...process.env, GIT_PROJECT_ROOT: repoRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `${prefix}${url.pathname.slice(prefix.length)}`, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: req.headers['content-length'] || '', REMOTE_ADDR: req.socket.remoteAddress || '' }; const child = spawn(gitHttpBackend, [], { env }); let headerBuffer = Buffer.alloc(0); let headersSent = false
    child.stdout.on('data', chunk => { if (headersSent) return res.write(chunk); headerBuffer = Buffer.concat([headerBuffer, chunk]); const separator = headerBuffer.indexOf(Buffer.from('\r\n\r\n')); const short = headerBuffer.indexOf(Buffer.from('\n\n')); const offset = separator >= 0 ? separator : short; const size = separator >= 0 ? 4 : 2; if (offset < 0) return; for (const line of headerBuffer.subarray(0, offset).toString().split(/\r?\n/)) { const split = line.indexOf(':'); if (split < 0) continue; const name = line.slice(0, split); const value = line.slice(split + 1).trim(); if (name.toLowerCase() === 'status') res.statusCode = Number(value.split(' ')[0]) || 200; else res.setHeader(name, value) }; headersSent = true; if (!res.statusCode) res.statusCode = 200; res.write(headerBuffer.subarray(offset + size)) })
    child.on('close', code => headersSent ? res.end() : json(res, 502, { status: 502, message: `git-http-backend exited with ${code}` })); req.pipe(child.stdin)
  }).catch(error => json(res, 404, { status: 404, message: error.message }))
}

const server = http.createServer((req, res) => { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; return res.end() }; if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true }); if (req.method === 'POST' && url.pathname === '/internal/push') return internalPush(req, res, String(req.headers['x-project-id'] || '')).catch(error => json(res, 400, { status: 400, message: error.message })); const githubMatch = url.pathname.match(/^\/api\/github\/([0-9a-f]{24})(?:\/(configure|pull|push|forget))?$/); if (githubMatch) return githubApi(req, res, githubMatch[1], githubMatch[2] || 'status').catch(error => json(res, 400, { status: 400, message: error.message })); if (!requireGitAuth(req, res)) return; const projectId = parseProject(url.pathname); if (!projectId) return json(res, 404, { status: 404, message: 'Project URL must contain a 24-character project id' }); serveGit(req, res, projectId) })
server.listen(port, '0.0.0.0', () => console.log(`node git bridge listening on ${port}`))
