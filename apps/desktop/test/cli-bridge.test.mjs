// Headless test harness for cli-bridge.mjs — mocks electron's `app`
// so we can exercise the bundled tessera-cli binary end-to-end without
// spinning up a real Electron window.
import Module from 'module'
import path from 'path'

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return path.join(process.cwd(), 'test/fake-electron.cjs')
  return origResolve.call(this, request, ...rest)
}

const cli = await import('./cli-bridge-testable.mjs')

function log(label, v) { console.log('---', label, '---'); console.log(JSON.stringify(v, null, 2)) }

const appId = process.env.TEST_APP_ID
const appKey = process.env.TEST_APP_KEY
cli.writeConfig(appId, appKey)
log('hasConfig', cli.hasConfig())

const folder = process.env.TEST_FOLDER
const prefix = process.env.TEST_PREFIX

log('sync add', await cli.syncAdd(folder, prefix))
log('sync list', await cli.syncList())
log('service status (before)', await cli.serviceStatus())
log('ensureWatcherInstalled', await cli.ensureWatcherInstalled())
log('service status (after)', await cli.serviceStatus())
log('sync conflicts', await cli.syncConflicts())
log('trash list', await cli.trashList())

// Clean up: uninstall watcher + remove sync root so no state leaks.
log('service uninstall', await cli.serviceUninstall())
const list = await cli.syncList()
if (list.ok && list.data && list.data.length) {
  for (const root of list.data) {
    log('sync remove ' + root.id, await cli.syncRemove(root.id))
  }
}
