// ESM resolve hook for the desktop bridge tests.
//
// cli-bridge.mjs imports `{ app } from 'electron'` at module load. Under
// `node --test` there is no Electron runtime, and the old Module._resolveFilename
// hook cannot redirect an ESM bare-specifier import (Node resolves it to the
// real `electron` package first, whose CJS surface has no `app` named export).
// A real loader hook is what actually substitutes the fake.
export async function resolve(specifier, context, next) {
  if (specifier === 'electron') {
    return {
      url: new URL('./fake-electron.cjs', import.meta.url).href,
      shortCircuit: true,
    }
  }
  return next(specifier, context)
}
