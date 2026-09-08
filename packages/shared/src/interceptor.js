// Fetch interceptor + WebTransport→WebSocket bridge for Tessera.
//
// Indexer requests (index.dithr.dev) go through the CORS proxy on :3099.
// WebTransport connections to sia hosts are tunnelled through a WebSocket
// relay that speaks raw siamux TCP to the host.
//
// In the Electron desktop app the relay is a local server started by main.js.
// In the web app the relay is the proxy's /__tunnel__ WebSocket endpoint.

import { proxyOrigin } from './utils.js'

const INDEXER_HOST = 'index.dithr.dev'

// ── Fetch interceptor for indexer requests ───────────────
// Always uses the proxy on port 3099.

export function installFetchInterceptor() {
  if (window.___tfi___) return
  window.___tfi___ = true

  const _R = window.Request

  window.Request = function (input, init) {
    let url = typeof input === 'string' ? input : input instanceof _R ? input.url : ''
    // Only proxy indexer URLs; skip already-proxied URLs and localhost
    if (url.includes(INDEXER_HOST) && !url.includes('/__proxy__') && !url.includes('localhost')) {
      const proxyUrl = proxyOrigin() + '/__proxy__?url=' + encodeURIComponent(url)
      if (typeof input === 'string') return new _R(proxyUrl, init)
      const opts = { method: input.method, headers: input.headers, mode: input.mode, credentials: input.credentials }
      if (input.body) { opts.body = input.body; opts.duplex = 'half' }
      return new _R(proxyUrl, opts)
    }
    return new _R(input, init)
  }

  const _f = window.fetch.bind(window)
  window.fetch = function (input, init) {
    let url = typeof input === 'string' ? input : input instanceof _R ? input.url : ''
    if (url.includes(INDEXER_HOST) && !url.includes('/__proxy__') && !url.includes('localhost'))
      return _f(proxyOrigin() + '/__proxy__?url=' + encodeURIComponent(url), init)
    return _f(input, init)
  }
}

// ── Get tunnel WebSocket base URL ────────────────────────

async function getTunnelBaseUrl() {
  // Desktop: use the local tunnel server started by main.js
  if (window.tesseraDesktop && window.tesseraDesktop.isDesktop) {
    try {
      const port = await window.tesseraDesktop.getTunnelPort()
      if (port) return 'ws://127.0.0.1:' + port
    } catch (_) { /* fall through to proxy */ }
  }
  // Web: use the proxy's WebSocket tunnel endpoint (same origin in prod)
  return proxyOrigin().replace(/^http/, 'ws')
}

// ── WebTransport → WebSocket bridge ──────────────────────
//
// Replaces window.WebTransport for sia host connections.  Each WebTransport
// becomes a WebSocket that is relayed to raw siamux TCP by the tunnel server.
// In desktop mode the tunnel server runs locally (direct TCP access).
// In web mode it's the proxy's /__tunnel__ endpoint.

export function installWebTransportShim() {
  if (window.___wtpoly___) return
  window.___wtpoly___ = true

  // In Electron desktop mode, the native NAPI SDK in the main process
  // handles all host communication via raw TCP.  The renderer should
  // NOT intercept WebTransport — it would create conflicting connections.
  if (window.tesseraDesktop && window.tesseraDesktop.isDesktop) return

  const OrigWT = window.WebTransport

  class SiamuxTunnel {
    constructor(url, options) {
      this._url = typeof url === 'string' ? url : String(url)
      this._options = options
      this._nextStreamId = 1
      this._streams = new Map()
      this._closed = false
      this._ws = null
      this._readyResolve = null
      this._readyReject = null
      this._closeResolve = null

      this.ready = new Promise((resolve, reject) => {
        this._readyResolve = resolve
        this._readyReject = reject
      })
      this.closed = new Promise((resolve) => {
        this._closeResolve = resolve
      })

      this._connect()
    }

    async _connect() {
      try {
        const u = new URL(this._url)
        const quicHost = u.hostname
        let host = quicHost
        let port = u.port || '9984'

        // Look up the siamux address from the SDK's host cache
        const sdk = window.__tesseraSdk
        if (sdk) {
          try {
            const hosts = await sdk.hosts()
            if (hosts) {
              for (const h of hosts) {
                const addrs = h.addresses || []
                let matches = false
                for (const a of addrs) {
                  if (a.protocol === 'quic' && a.address.includes(quicHost)) {
                    matches = true
                    break
                  }
                }
                if (matches) {
                  for (const a of addrs) {
                    if (a.protocol === 'siamux') {
                      const parts = a.address.split(':')
                      host = parts[0]
                      port = parts[1] || '9984'
                      break
                    }
                  }
                  break
                }
              }
            }
          } catch (_) { /* use quic host as fallback */ }
        }

        // Determine tunnel WebSocket URL
        const base = await getTunnelBaseUrl()
        const wsUrl = base + '/__tunnel__?host=' + encodeURIComponent(host) + '&port=' + port

        this._ws = new WebSocket(wsUrl)
        this._ws.binaryType = 'arraybuffer'

        this._ws.onopen = () => {
          this._readyResolve && this._readyResolve()
        }

        this._ws.onerror = () => {
          if (!this._closed) {
            this._closed = true
            this._readyReject && this._readyReject(new Error('WebSocket connection failed'))
            this._closeResolve && this._closeResolve()
          }
        }

        this._ws.onclose = () => {
          if (!this._closed) {
            this._closed = true
            this._closeResolve && this._closeResolve()
          }
          for (const [, s] of this._streams) {
            try { s._controller && s._controller.close() } catch (_) {}
          }
        }

        this._ws.onmessage = (event) => {
          this._handleMessage(event.data)
        }

      } catch (e) {
        this._closed = true
        this._readyReject && this._readyReject(e)
        this._closeResolve && this._closeResolve()
      }
    }

    _handleMessage(data) {
      const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : data
      if (buf.length < 2) return

      const streamId = (buf[0] << 8) | buf[1]
      const payload = buf.slice(2)

      const stream = this._streams.get(streamId)
      if (stream && stream._controller && payload.length > 0) {
        try { stream._controller.enqueue(payload) } catch (_) {}
      }
    }

    createBidirectionalStream() {
      if (this._closed) return Promise.reject(new Error('WebTransport closed'))

      const streamId = this._nextStreamId++

      let readController = null
      const readable = new ReadableStream({
        type: 'bytes',
        start: (controller) => { readController = controller },
        cancel: () => { this._streams.delete(streamId) },
      })

      const writable = new WritableStream({
        write: (chunk) => {
          if (this._closed || !this._ws || this._ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebTransport closed')
          }
          // Frame: [streamId:2][payload...]
          const header = new Uint8Array(2)
          header[0] = (streamId >> 8) & 0xff
          header[1] = streamId & 0xff
          const framed = new Uint8Array(header.length + chunk.length)
          framed.set(header)
          framed.set(chunk, header.length)
          this._ws.send(framed)
        },
        close: () => {
          this._streams.delete(streamId)
          try { readController && readController.close() } catch (_) {}
        },
        abort: () => {
          this._streams.delete(streamId)
          try { readController && readController.error(new Error('aborted')) } catch (_) {}
        },
      })

      this._streams.set(streamId, { readable, writable, _controller: readController })
      return Promise.resolve({ readable, writable })
    }

    close() {
      if (this._closed) return
      this._closed = true
      try { this._ws && this._ws.close() } catch (_) {}
      this._closeResolve && this._closeResolve()
    }
  }

  window.WebTransport = function (url, options) {
    const urlStr = typeof url === 'string' ? url : String(url)
    // Intercept connections to sia hosts (quic and siamux)
    if (urlStr.includes('sia.host') || urlStr.includes('.siasky.') || urlStr.includes('datagrid42.com')) {
      return new SiamuxTunnel(url, options)
    }
    // Let real WebTransport connections through
    try { return new OrigWT(url, options) } catch (_) {
      return new SiamuxTunnel(url, options)
    }
  }
  window.WebTransport.prototype = OrigWT.prototype
}

// ── Hook: store SDK reference when connected ─────────────
// Called by auth.js after successful connect or reconnect.
// The WebTransport shim uses this to look up siamux addresses.

export function registerSdk(sdk) {
  window.__tesseraSdk = sdk
}