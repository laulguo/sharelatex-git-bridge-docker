const http = require('http')
const projectId = process.argv[2]
const token = process.argv[3]
const repoPath = process.argv[4]
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const updates = Buffer.concat(chunks).toString().trim().split(/\r?\n/).filter(Boolean)
  if (updates.length !== 1) { console.error('Only one ref update is supported'); process.exit(1) }
  const [oldId, newId, ref] = updates[0].split(/\s+/)
  const body = JSON.stringify({ repoPath, oldId, newId, ref, gitEnv: { GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY || '', GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES || '' } })
  const request = http.request({ hostname: '127.0.0.1', port: 8080, path: '/internal/push', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-project-id': projectId, 'x-bridge-internal': token } }, response => { const result = []; response.on('data', chunk => result.push(chunk)); response.on('end', () => { const text = Buffer.concat(result).toString(); if (response.statusCode < 200 || response.statusCode >= 300) { console.error(text || 'Push rejected'); process.exit(1) } process.exit(0) }) })
  request.on('error', error => { console.error(error.message); process.exit(1) }); request.end(body)
})
