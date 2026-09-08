// Tessera share download page
// Resolves a shared file URL and downloads it directly from Sia hosts.
import {
  initSia, AppKey, Builder, fromHex, registerSdk,
  formatBytes,
} from '@tessera/shared'

// ── service account (same as proxy, bootstraps SDK connection) ──
const SVC_APP_ID = '1483449cb22e73c9936cc4153bf071c4008c0787faf078d35bf95f702b326f23'
const SVC_APP_KEY = '6be4f21d5a4da5ab422077cb8188885e947f10aced92cded35c5aa9afad9d42c'

// ── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id)
const el = {
  icon: $('icon'), title: $('title'), meta: $('meta'),
  btn: $('btnDownload'), spinner: $('spinner'),
  progressWrap: $('progressWrap'), progressFill: $('progressFill'),
  progressLabel: $('progressLabel'), error: $('error'),
}

// ── helpers ───────────────────────────────────────────────────
function fileIcon(ext) {
  const m = {
    pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',
    png:'🖼',jpg:'🖼',jpeg:'🖼',gif:'🖼',svg:'🖼',webp:'🖼',
    mp4:'🎬',mov:'🎬',avi:'🎬',mp3:'🎵',wav:'🎵',flac:'🎵',
    zip:'📦',rar:'📦','7z':'📦',tar:'📦',gz:'📦',
  }
  return m[ext] || '📄'
}

function setProgress(percent, label) {
  el.progressWrap.style.display = 'block'
  el.progressFill.style.width = percent + '%'
  el.progressLabel.textContent = label || ''
}

function showError(msg) {
  el.error.textContent = msg
  el.btn.disabled = true
  el.spinner.style.display = 'none'
  el.btn.textContent = 'Download failed'
  console.error(msg)
}

/**
 * Connect an SDK instance using either the service account
 * or the user's existing saved credentials (if they're logged in
 * to Tessera in this browser).
 */
async function connectSdk() {
  // Try user's own credentials first (they share the same contracts)
  const savedAid = localStorage.getItem('tessera.aid')
  const savedAkey = localStorage.getItem('tessera.akey')
  if (savedAid && savedAkey) {
    try {
      const key = new AppKey(fromHex(savedAkey))
      const builder = new Builder('https://index.dithr.dev', {
        appId: savedAid,
        name: 'Tessera Share',
        description: 'Tessera share download',
        serviceUrl: 'https://index.dithr.dev',
      })
      const sdk = await builder.connected(key)
      if (sdk) return sdk
    } catch (e) {
      console.warn('User credentials failed, falling back to service account:', e.message)
    }
  }

  // Fall back to service account (pre-funded contracts for host access)
  const key = new AppKey(fromHex(SVC_APP_KEY))
  const builder = new Builder('https://index.dithr.dev', {
    appId: SVC_APP_ID,
    name: 'Tessera Share',
    description: 'Tessera share download',
    serviceUrl: 'https://index.dithr.dev',
  })
  const sdk = await builder.connected(key)
  if (!sdk) throw new Error('Could not connect to the Tessera network. Please try again later.')
  return sdk
}

// ── main ──────────────────────────────────────────────────────
async function main() {
  // Parse share URL from query string
  const params = new URLSearchParams(window.location.search)
  const shareUrl = params.get('share')
  if (!shareUrl) {
    showError('No share link provided. This page is for downloading shared Tessera files.')
    el.meta.textContent = 'Append ?share=<link> to download a shared file.'
    return
  }

  try {
    // 1. Init WASM SDK + WebTransport shim + fetch interceptor
    el.meta.textContent = 'Loading Tessera network\u2026'
    await initSia()

    // 2. Connect SDK
    el.meta.textContent = 'Connecting to network\u2026'
    const sdk = await connectSdk()
    registerSdk(sdk)

    // 3. Resolve shared object
    el.meta.textContent = 'Resolving shared file\u2026'
    let obj
    try {
      obj = await sdk.sharedObject(shareUrl)
    } catch (e) {
      showError('Could not resolve share link. It may have expired or be invalid.')
      return
    }

    if (!obj) {
      showError('Shared file not found. The link may have expired.')
      return
    }

    // 4. Extract file info from metadata
    let fileName = 'download'
    let mimeType = 'application/octet-stream'
    try {
      const metaBytes = obj.metadata()
      if (metaBytes && metaBytes.length) {
        const m = JSON.parse(new TextDecoder().decode(metaBytes))
        if (m.name) fileName = m.name
        if (m.mime) mimeType = m.mime
      }
    } catch (_) {}

    const fileSize = Number(obj.size())
    const ext = (fileName.split('.').pop() || '').toLowerCase()

    // Update UI
    el.icon.textContent = fileIcon(ext)
    el.title.textContent = fileName
    el.meta.textContent = formatBytes(fileSize) + ' \u00b7 Shared via Tessera'
    el.btn.textContent = 'Download'
    el.btn.disabled = false
    el.spinner.style.display = 'none'

    // 5. Wait for user click, then download
    el.btn.addEventListener('click', async () => {
      el.btn.disabled = true
      el.btn.textContent = 'Downloading\u2026'
      el.spinner.style.display = 'inline-block'
      el.error.textContent = ''

      try {
        setProgress(5, 'Connecting to Sia hosts\u2026')

        const stream = sdk.download(obj)
        const reader = stream.getReader()
        const chunks = []
        let downloaded = 0
        const startTime = Date.now()

        setProgress(10, 'Downloading from Sia hosts\u2026')

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          downloaded += value.length
          const pct = fileSize > 0
            ? Math.min(95, 10 + Math.round((downloaded / fileSize) * 85))
            : Math.min(95, 10 + Math.round((downloaded / (1024 * 1024)) * 5))
          const elapsed = Math.round((Date.now() - startTime) / 1000)
          setProgress(pct,
            formatBytes(downloaded) + ' / ' + (fileSize ? formatBytes(fileSize) : '?') +
            ' \u00b7 ' + elapsed + 's')
        }

        setProgress(98, 'Saving file\u2026')

        // Assemble blob and trigger browser download
        const blob = new Blob(chunks, { type: mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        setProgress(100, 'Download complete!')
        el.btn.textContent = '\u2705 Downloaded'
        el.spinner.style.display = 'none'
        el.meta.textContent = fileName + ' \u00b7 ' + formatBytes(fileSize)

      } catch (e) {
        el.spinner.style.display = 'none'
        showError('Download failed: ' + (e.message || 'Unknown error'))
      }
    })

  } catch (e) {
    showError('Failed to initialize: ' + (e.message || 'Unknown error'))
  }
}

main()