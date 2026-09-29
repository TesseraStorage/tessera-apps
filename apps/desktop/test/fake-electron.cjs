// Fake `electron` module for headless testing of main-process bridges
// outside a real Electron runtime.
const path = require('path')
const os = require('os')

const fakeUserData = path.join(os.tmpdir(), 'tessera-cli-bridge-test-userdata')

exports.app = {
  getPath: (name) => {
    if (name === 'userData') return fakeUserData
    if (name === 'home') return path.join(os.tmpdir(), 'tessera-cli-bridge-test-home')
    return os.tmpdir()
  },
  isPackaged: false,
  getAppPath: () => process.cwd(),
}
