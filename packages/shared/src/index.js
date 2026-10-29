// @tessera/shared — public API

export { initSia, getIndexerUrl, Builder, AppKey, PinnedObject, generateRecoveryPhrase, registerSdk } from './sdk.js'
export { beginConnection, waitForApproval, completeRegistration, tryReconnect, clearCredentials, getSaved, beginRecovery, completeRecovery, fetchRecoveryCredential, recoverWithConnectKey } from './auth.js'
export { listFiles, computeTotals, uploadFile, uploadFilesPacked, downloadToDisk, deleteFile, createShareURL, getObject, getAccount, waitForReady, waitForConnected, initRelay, computeAllFolderPaths, existingBasenamesInFolder, resolveCollisionName, validateRenameName, renameObjectPath } from './files.js'
export { getState, patchState, subscribe, selectedFile, showToast, setBusy, setScreen } from './store.js'
export { formatBytes, esc, fmtDate, fmtDateTime, toHex, fromHex, $, proxyOrigin } from './utils.js'
export { mountApp } from './ui.js'
export { installFetchInterceptor, installWebTransportShim } from './interceptor.js'
export { withTransferReadiness, isHostShortageError, TransferReadinessError, readinessMessage, packedShortageError, parseBalanceUSD, READINESS_WAITING_TEXT } from './readiness.js'
