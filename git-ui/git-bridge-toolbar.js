(function () {
  'use strict'

  var projectMatch = window.location.pathname.match(/\/Project\/([0-9a-f]{24})|\/project\/([0-9a-f]{24})/i)
  if (!projectMatch) return
  var projectId = projectMatch[1] || projectMatch[2]
  var bridgeUrl = 'http://' + window.location.hostname + ':18081'
  var repoUrl = bridgeUrl + '/' + projectId + '.git'

  function copy(text, button) {
    navigator.clipboard.writeText(text).then(function () {
      var original = button.textContent
      button.textContent = 'Copied'
      setTimeout(function () { button.textContent = original }, 1200)
    })
  }

  function createPanel() {
    var panel = document.createElement('section')
    panel.className = 'git-bridge-panel'
    panel.setAttribute('aria-label', 'Git integration')
    panel.innerHTML = [
      '<div class="git-bridge-panel-header"><strong>Git</strong><button class="git-bridge-close" type="button" aria-label="Close Git panel">&times;</button></div>',
      '<div class="git-bridge-status"><span class="git-bridge-status-dot"></span><span class="git-bridge-status-text">Checking bridge...</span></div>',
      '<label class="git-bridge-label" for="git-bridge-repo-url">Repository URL</label>',
      '<div class="git-bridge-url-row"><input id="git-bridge-repo-url" readonly value="' + repoUrl + '"><button class="git-bridge-copy" type="button">Copy</button></div>',
      '<p class="git-bridge-help">Use username <code>git</code> and your Git token when Git asks for credentials.</p>',
      '<label class="git-bridge-label" for="git-bridge-github-url">Git remote (manual sync)</label>',
      '<div class="git-bridge-url-row"><input id="git-bridge-github-url" placeholder="https://git.example.com/owner/repository.git"><button class="git-bridge-configure" type="button">Save</button></div>',
      '<div class="git-bridge-sync-row"><button class="git-bridge-pull" type="button">Pull from remote</button><button class="git-bridge-push" type="button">Push to remote</button></div>',
      '<div class="git-bridge-actions"><button class="git-bridge-refresh" type="button">Refresh status</button><a href="' + repoUrl + '" target="_blank" rel="noreferrer">Open URL</a></div>'
    ].join('')
    document.body.appendChild(panel)

    panel.querySelector('.git-bridge-close').addEventListener('click', function () { panel.classList.remove('is-open') })
    panel.querySelector('.git-bridge-copy').addEventListener('click', function () { copy(repoUrl, this) })
    panel.querySelector('.git-bridge-refresh').addEventListener('click', function () { checkStatus(panel) })
    panel.querySelector('.git-bridge-configure').addEventListener('click', function () { githubAction(panel, 'configure') })
    panel.querySelector('.git-bridge-pull').addEventListener('click', function () { githubAction(panel, 'pull') })
    panel.querySelector('.git-bridge-push').addEventListener('click', function () { githubAction(panel, 'push') })
    loadGithubConfig(panel)
    return panel
  }

  function githubEndpoint(action) { return bridgeUrl + '/api/github/' + projectId + (action ? '/' + action : '') }
  function loadGithubConfig(panel) {
    fetch(githubEndpoint('')).then(function (response) { return response.json() }).then(function (body) {
      if (body.remoteUrl) panel.querySelector('#git-bridge-github-url').value = body.remoteUrl
    }).catch(function () {})
  }
  function githubAction(panel, action) {
    var remoteUrl = panel.querySelector('#git-bridge-github-url').value.trim()
    if (action === 'configure' && !remoteUrl) return
    var button = panel.querySelector('.git-bridge-' + action)
    var original = button.textContent
    button.disabled = true
    button.textContent = 'Working...'
    fetch(githubEndpoint(action), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remoteUrl: remoteUrl }) })
      .then(function (response) { return response.json().then(function (body) { if (!response.ok) throw new Error(body.message || 'GitHub sync failed'); return body }) })
      .then(function (body) { button.textContent = body.changed === false ? 'Already current' : 'Done'; loadGithubConfig(panel); if (action === 'pull' && body.changed) setTimeout(function () { window.location.reload() }, 700) })
      .catch(function (error) { button.textContent = error.message })
      .finally(function () { setTimeout(function () { button.disabled = false; button.textContent = original }, 1800) })
  }

  function checkStatus(panel) {
    var text = panel.querySelector('.git-bridge-status-text')
    var dot = panel.querySelector('.git-bridge-status-dot')
    text.textContent = 'Checking bridge...'
    dot.className = 'git-bridge-status-dot is-checking'
    fetch(bridgeUrl + '/health').then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status)
      text.textContent = 'Git bridge ready'
      dot.className = 'git-bridge-status-dot is-ready'
    }).catch(function () {
      text.textContent = 'Git bridge unavailable'
      dot.className = 'git-bridge-status-dot is-error'
    })
  }

  function mount() {
    if (document.querySelector('.git-bridge-launcher')) return
    var panel = createPanel()
    var launcher = document.createElement('button')
    launcher.className = 'git-bridge-launcher'
    launcher.type = 'button'
    launcher.title = 'Open Git integration'
    launcher.setAttribute('aria-label', 'Open Git integration')
    launcher.innerHTML = '<span aria-hidden="true">&#x2387;</span><span>Git</span>'
    launcher.addEventListener('click', function () { panel.classList.toggle('is-open'); if (panel.classList.contains('is-open')) checkStatus(panel) })
    var toolbar = document.querySelector('.toolbar-header .toolbar-right') || document.querySelector('.toolbar-header')
    if (toolbar) toolbar.appendChild(launcher)
    else document.body.appendChild(launcher)
    checkStatus(panel)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount)
  else mount()
  setTimeout(mount, 2000)
})()
