#!/usr/bin/env node
// Start the CORS proxy + Vite dev server together.
// For desktop, also launches Electron after Vite is ready.
// Usage: node scripts/start-dev.js [web|desktop]

import { spawn, execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const app = process.argv[2] || 'web'

const proxyPath = path.join(root, 'packages', 'proxy', 'index.js')

// Kill anything already on port 3099
try { execSync('fuser -k 3099/tcp 2>/dev/null', { stdio: 'ignore' }) } catch (_) {}
await new Promise(r => setTimeout(r, 500))

console.log('Starting CORS proxy on :3099 ...')

const proxy = spawn('node', [proxyPath], {
  stdio: 'inherit',
  env: { ...process.env, TESSERA_PORT: '3099' },
})

await new Promise(r => setTimeout(r, 1500))

console.log('Starting Vite on :5173 ...')

const vite = spawn('npx', ['-w', 'apps/' + app, 'vite', '--host'], {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env },
})

await new Promise(r => setTimeout(r, 3000))

// Desktop: launch Electron
if (app === 'desktop') {
  let electronPath = path.join(root, 'apps', 'desktop', 'node_modules', '.bin', 'electron')
  try { fs.statSync(electronPath) } catch (_) {
    electronPath = path.join(root, 'node_modules', '.bin', 'electron')
  }
  console.log('Launching Electron from ' + electronPath + ' ...')
  const electron = spawn(electronPath, [path.join(root, 'apps', 'desktop', 'electron', 'main.js')], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:5173' },
  })

  electron.on('close', (code) => {
    proxy.kill()
    vite.kill()
    process.exit(code || 0)
  })

  process.on('SIGINT', () => {
    electron.kill()
    proxy.kill()
    vite.kill()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    electron.kill()
    proxy.kill()
    vite.kill()
    process.exit(0)
  })
} else {
  process.on('SIGINT', () => {
    proxy.kill()
    vite.kill()
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    proxy.kill()
    vite.kill()
    process.exit(0)
  })
}