// Desktop dev script — starts Vite then launches Electron
//
// Usage: node scripts/dev.js

import { spawn } from 'child_process'
import { createServer } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

async function main() {
  // 1. Start Vite dev server
  const server = await createServer({
    configFile: path.join(root, 'vite.config.js'),
    root,
  })
  await server.listen()
  server.printUrls()

  const address = server.config.server.host || 'localhost'
  const port = server.config.server.port || 5173
  const url = `http://${address}:${port}`

  console.log(`\n  ➜  Vite dev server running at ${url}`)
  console.log('  ➜  Launching Electron...\n')

  // 2. Launch Electron
  const electronPath = path.join(root, 'node_modules', '.bin', 'electron')
  const electron = spawn(electronPath, [path.join(root, 'electron', 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  })

  electron.on('close', (code) => {
    server.close()
    process.exit(code || 0)
  })

  // Cleanup on Ctrl+C
  process.on('SIGINT', () => {
    electron.kill()
    server.close()
    process.exit(0)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})