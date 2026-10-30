/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export interface DownloadOptions {
    maxBufferedChunks?: number;
    offset?: number;
    length?: number;
    onShardDownloaded?: (progress: ShardProgress) => void;
}



export interface SealedObject {
    encryptedDataKey: string;
    slabs: Slab[];
    dataSignature: string;
    encryptedMetadataKey?: string;
    encryptedMetadata?: string;
    metadataSignature: string;
    createdAt: string;
    updatedAt: string;
}



export interface Sector {
    root: string;
    hostKey: string;
}

export interface Slab {
    version: number;
    encryptionKey: string;
    minShards: number;
    offset: number;
    length: number;
    sectors: Sector[];
}

export interface PinnedSlab {
    version: number;
    id: string;
    encryptionKey: string;
    minShards: number;
    sectors: Sector[];
}

export interface Host {
    publicKey: string;
    addresses: { protocol: string; address: string }[];
    countryCode: string;
    latitude: number;
    longitude: number;
    goodForUpload: boolean;
}



export interface UploadOptions {
    dataShards?: number;
    parityShards?: number;
    maxBufferedSlabs?: number;
    startOffset?: bigint;
    onShardUploaded?: (progress: ShardProgress) => void;
    onWriteAttemptStart?: (attempt: WriteAttempt) => void;
}

export interface PackedUploadOptions {
    dataShards?: number;
    parityShards?: number;
    maxBufferedSlabs?: number;
    onShardUploaded?: (progress: ShardProgress) => void;
    onWriteAttemptStart?: (attempt: WriteAttempt) => void;
}



interface Sdk {
    download(object: PinnedObject, options?: DownloadOptions): Promise<ReadableStream>;
    upload(object: PinnedObject, source: ReadableStream, options?: UploadOptions): Promise<PinnedObject>;
    uploadPacked(options?: PackedUploadOptions): Promise<PackedUpload>;
}


/**
 * Application info registered with the indexer.
 */
export interface App {
    id: string;
    name: string;
    description: string;
    logoUrl: string | undefined;
    serviceUrl: string | undefined;
}

/**
 * Information about the user\'s account on the indexer.
 */
export interface Account {
    accountKey: string;
    maxPinnedData: number;
    remainingStorage: number;
    pinnedData: number;
    pinnedSize: number;
    ready: boolean;
    app: App;
    lastUsed: Date;
}

/**
 * Progress information about a successfully uploaded or downloaded shard.
 */
export interface ShardProgress {
    hostKey: string;
    shardSize: number;
    shardIndex: number;
    slabIndex: number;
    /**
     * Elapsed time in milliseconds since the start of the shard upload or download.
     */
    elapsedMs: number;
}

/**
 * Query parameters for filtering hosts.
 */
export interface HostQuery {
    country: string | undefined;
    limit: number | undefined;
    offset: number | undefined;
}

/**
 * TS interface for `Builder::new`\'s `app` parameter. Field names must
 * match the Reflect reads in `helpers::make_app_metadata`.
 */
export interface AppMetadata {
    appId: string;
    name: string;
    description: string;
    serviceUrl: string;
    logoUrl: string | undefined;
    callbackUrl: string | undefined;
}

/**
 * TS interface for `Sdk::objectEvents`\'s `cursor` parameter. Field
 * names must match the Reflect reads in `sdk.rs`.
 */
export interface ObjectsCursor {
    id: string;
    after: Date;
}

export interface WriteAttempt {
    hostKey: string;
}

export type SealedObject = SealedObject;


/**
 * An application key used for authentication with the indexer.
 *
 * AppKeys are derived from a BIP-39 recovery phrase during registration.
 * They can be exported as a 32-byte seed and re-imported for future
 * connections. The key must be stored securely — anyone with access
 * can authenticate as the user.
 */
export class AppKey {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Exports the AppKey as a 32-byte seed (Uint8Array).
     */
    export(): Uint8Array;
    /**
     * Imports an AppKey from a 32-byte seed (Uint8Array).
     */
    constructor(seed: Uint8Array);
    /**
     * Returns the ed25519 public key as a string (e.g. "ed25519:abc123...").
     */
    publicKey(): string;
    /**
     * Signs a message and returns the 64-byte ed25519 signature (Uint8Array).
     */
    sign(message: Uint8Array): Uint8Array;
    /**
     * Verifies a signature for a given message.
     * Returns true if the signature is valid.
     */
    verifySignature(message: Uint8Array, signature: Uint8Array): boolean;
}

/**
 * SDK Builder — handles the connection and registration flow with an indexer.
 */
export class Builder {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Attempts to connect using an existing AppKey.
     * Returns a Sdk if the key is valid, or undefined if not registered.
     */
    connected(app_key: AppKey): Promise<Sdk | undefined>;
    constructor(indexer_url: string, app: AppMetadata);
    /**
     * Completes registration and returns a Sdk instance.
     */
    register(mnemonic: string): Promise<Sdk>;
    /**
     * Requests connection approval from the indexer.
     */
    requestConnection(): Promise<void>;
    /**
     * Returns the approval URL the user must visit.
     */
    responseUrl(): string;
    /**
     * Waits for the user to approve the connection request.
     */
    waitForApproval(): Promise<void>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * An object event from the indexer.
 */
export class ObjectEvent {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly deleted: boolean;
    readonly id: string;
    /**
     * Returns the object associated with this event, if it exists.
     */
    readonly object: PinnedObject | undefined;
    /**
     * Returns the time the event occurred.
     */
    readonly updatedAt: Date;
}

/**
 * A packed upload handle for efficiently uploading multiple objects
 * together. Objects are packed into shared slabs to avoid wasting storage.
 *
 * ```js
 * const packed = sdk.uploadPacked();
 * await packed.add(file1.stream());
 * await packed.add(file2.stream());
 * const objects = await packed.finalize();
 * for (const obj of objects) await sdk.pinObject(obj);
 * ```
 */
export class PackedUpload {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Adds a new object to the upload. The data is read until EOF and packed into
     * the current slab. Returns the number of bytes consumed; call
     * [finalize](Self::finalize) once all objects have been added to get the
     * resulting objects.
     *
     * If the reader errors part-way, it's safe to continue calling
     * [add](Self::add); no object is registered for the failed call. Or call
     * [finalize](Self::finalize) to collect the objects added so far. Bytes
     * read before the error remain in the current slab as padding and stay
     * counted in [length](Self::length) and [remaining](Self::remaining).
     *
     * ```js
     * const packed = sdk.uploadPacked();
     * await packed.add(file.stream());
     * await packed.add(blob.stream());
     * const objects = await packed.finalize();
     * ```
     */
    add(stream: ReadableStream): Promise<number>;
    /**
     * Cancels the packed upload. Immediately interrupts any in-flight `add`
     * and aborts all pending slab uploads.
     */
    cancel(): void;
    /**
     * Finalizes the packed upload and returns the resulting objects.
     * Each object must be pinned separately with `sdk.pinObject()`.
     */
    finalize(): Promise<PinnedObject[]>;
    /**
     * Total bytes added so far across all objects.
     */
    length(): number;
    /**
     * Optimal size of each slab in bytes.
     */
    optimalDataSize(): number;
    /**
     * Bytes remaining until the current slab is full. Adding objects that
     * fit within this size avoids starting a new slab and minimizes padding.
     */
    remaining(): number;
    /**
     * Number of slabs in the upload.
     */
    slabs(): number;
}

/**
 * An object stored on the Sia network. JS holds this as an opaque handle
 * and passes it back to Rust for operations like pin, download, share, and
 * metadata updates. The internal state (encryption keys, slab data) cannot
 * be serialized to JS.
 */
export class PinnedObject {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns the creation time.
     */
    createdAt(): Date;
    /**
     * Returns the encoded (on-network) size after erasure coding.
     */
    encodedSize(): number;
    /**
     * Returns the object's ID as a hex string.
     */
    id(): string;
    /**
     * Returns the object's metadata as raw bytes.
     */
    metadata(): Uint8Array;
    /**
     * Creates a new empty object.
     */
    constructor();
    /**
     * Opens a previously sealed object.
     */
    static open(app_key: AppKey, sealed_obj: SealedObject): PinnedObject;
    /**
     * Seals the object for offline storage.
     */
    seal(app_key: AppKey): SealedObject;
    /**
     * Returns the total size of the object in bytes.
     */
    size(): number;
    /**
     * Returns the slabs that make up the object.
     */
    slabs(): Slab[];
    /**
     * Updates the object's metadata.
     */
    updateMetadata(metadata: Uint8Array): void;
    /**
     * Returns the last updated time.
     */
    updatedAt(): Date;
}

/**
 * The main Sia storage SDK. Provides methods for uploading, downloading,
 * and managing objects on the Sia storage network via an indexer.
 */
export class Sdk {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Returns account information from the indexer.
     */
    account(): Promise<Account>;
    /**
     * Returns the AppKey used by this SDK instance.
     */
    appKey(): AppKey;
    /**
     * Deletes an object from the indexer by its hex ID.
     */
    deleteObject(key_hex: string): Promise<void>;
    /**
     * Downloads an object and returns a `ReadableStream` of `Uint8Array` chunks.
     *
     * ```js
     * // as a blob
     * const stream = sdk.download(obj);
     * const blob = await new Response(stream).blob();
     *
     * // as a stream
     * for await (const chunk of sdk.download(obj)) {
     *   console.log('got', chunk.length, 'bytes');
     * }
     * ```
     */
    download(object: PinnedObject, options?: any | null): Promise<ReadableStream>;
    /**
     * Returns a list of usable hosts, optionally filtered by a HostQuery.
     */
    hosts(query?: HostQuery | null): Promise<Host[]>;
    /**
     * Returns the exact host list from this write job's own one `GET
     * /hosts` (fetched at `upload()`/`uploadPacked()` start), already
     * held in RAM. This is a cache read, not a network call -- calling
     * it does NOT issue a second `/hosts` fetch. Empty until the first
     * write job in this `Sdk` instance's lifetime has started fetching
     * its plate.
     *
     * TESSERA FORK (sonnet-packet-tessera-web-attempt-arcs-2-2026-09-29).
     */
    lastWritePlate(): Host[];
    /**
     * Retrieves an object from the indexer by its hex ID.
     * Returns a `PinnedObject` handle for use with download, share, seal, etc.
     */
    object(key_hex: string): Promise<PinnedObject>;
    /**
     * Returns object events for syncing local state with the indexer.
     */
    objectEvents(cursor: ObjectsCursor | null | undefined, limit: number): Promise<ObjectEvent[]>;
    /**
     * Pins an object to the indexer so it persists beyond temporary storage.
     */
    pinObject(object: PinnedObject): Promise<void>;
    /**
     * Prunes unused slabs from the indexer.
     */
    pruneSlabs(): Promise<void>;
    /**
     * Generates a signed share URL for an object. Anyone with the URL can
     * download and decrypt the object until `validUntil`.
     */
    shareObject(object: PinnedObject, valid_until: Date): string;
    /**
     * Resolves a share URL (sia://...) and returns the shared object.
     * The encryption key is extracted from the URL fragment (never sent
     * to the indexer).
     */
    sharedObject(share_url: string): Promise<PinnedObject>;
    /**
     * Retrieves a pinned slab from the indexer by its hex ID.
     */
    slab(slab_id: string): Promise<PinnedSlab>;
    /**
     * Updates an object's metadata on the indexer.
     */
    updateObjectMetadata(object: PinnedObject): Promise<void>;
    /**
     * Uploads data from a `ReadableStream` to the Sia network.
     *
     * Pass an existing `PinnedObject` to append new slabs to it, or `null`
     * for a new upload. Appending changes the object's ID — the caller must
     * re-pin and update any references to the old ID.
     *
     * ```js
     * const obj = await sdk.upload(new PinnedObject(), file.stream());
     * await sdk.pinObject(obj);
     * ```
     */
    upload(object: PinnedObject, source: ReadableStream, options?: any | null): Promise<PinnedObject>;
    /**
     * Starts a packed upload for efficiently uploading multiple small objects.
     * Objects smaller than the slab size (~40 MiB) are packed into shared slabs
     * to avoid wasting storage. Call `add(data)` for each object, then
     * `finalize()` to get the resulting `PinnedObject` handles.
     */
    uploadPacked(options?: any | null): Promise<PackedUpload>;
}

/**
 * Calculates the encoded size of data after erasure coding.
 */
export function encodedSize(data_size: number, data_shards: number, parity_shards: number): number;

/**
 * Generates a new BIP-39 12-word recovery phrase.
 */
export function generateRecoveryPhrase(): string;

/**
 * Set up panic hook and tokio runtime for browser use.
 *
 * Call `setLogger` to receive log messages.
 */
export function init(): void;

/**
 * Sets a logging callback to receive log messages from the SDK.
 *
 * The callback receives formatted log messages as strings.
 * `level` should be one of: "off", "error", "warn", "info", "debug", "trace".
 */
export function setLogger(callback: (message: string) => void, level: "off" | "error" | "warn" | "info" | "debug" | "trace"): void;

/**
 * Validates a BIP-39 recovery phrase.
 */
export function validateRecoveryPhrase(phrase: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_appkey_free: (a: number, b: number) => void;
    readonly __wbg_builder_free: (a: number, b: number) => void;
    readonly __wbg_objectevent_free: (a: number, b: number) => void;
    readonly __wbg_packedupload_free: (a: number, b: number) => void;
    readonly __wbg_pinnedobject_free: (a: number, b: number) => void;
    readonly __wbg_sdk_free: (a: number, b: number) => void;
    readonly appkey_export: (a: number) => [number, number];
    readonly appkey_new: (a: number, b: number) => [number, number, number];
    readonly appkey_publicKey: (a: number) => [number, number];
    readonly appkey_sign: (a: number, b: number, c: number) => [number, number];
    readonly appkey_verifySignature: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly builder_connected: (a: number, b: number) => any;
    readonly builder_new: (a: number, b: number, c: any) => [number, number, number];
    readonly builder_register: (a: number, b: number, c: number) => any;
    readonly builder_requestConnection: (a: number) => any;
    readonly builder_responseUrl: (a: number) => [number, number, number, number];
    readonly builder_waitForApproval: (a: number) => any;
    readonly encodedSize: (a: number, b: number, c: number) => number;
    readonly generateRecoveryPhrase: () => [number, number];
    readonly init: () => void;
    readonly objectevent_deleted: (a: number) => number;
    readonly objectevent_id: (a: number) => [number, number];
    readonly objectevent_object: (a: number) => number;
    readonly objectevent_updatedAt: (a: number) => any;
    readonly packedupload_add: (a: number, b: any) => any;
    readonly packedupload_cancel: (a: number) => void;
    readonly packedupload_finalize: (a: number) => any;
    readonly packedupload_length: (a: number) => number;
    readonly packedupload_optimalDataSize: (a: number) => number;
    readonly packedupload_remaining: (a: number) => number;
    readonly packedupload_slabs: (a: number) => number;
    readonly pinnedobject_createdAt: (a: number) => any;
    readonly pinnedobject_encodedSize: (a: number) => number;
    readonly pinnedobject_id: (a: number) => [number, number];
    readonly pinnedobject_metadata: (a: number) => [number, number];
    readonly pinnedobject_new: () => number;
    readonly pinnedobject_open: (a: number, b: any) => [number, number, number];
    readonly pinnedobject_seal: (a: number, b: number) => any;
    readonly pinnedobject_size: (a: number) => number;
    readonly pinnedobject_slabs: (a: number) => [number, number, number];
    readonly pinnedobject_updateMetadata: (a: number, b: number, c: number) => void;
    readonly pinnedobject_updatedAt: (a: number) => any;
    readonly sdk_account: (a: number) => any;
    readonly sdk_appKey: (a: number) => number;
    readonly sdk_deleteObject: (a: number, b: number, c: number) => any;
    readonly sdk_download: (a: number, b: number, c: number) => any;
    readonly sdk_hosts: (a: number, b: number) => any;
    readonly sdk_lastWritePlate: (a: number) => [number, number, number];
    readonly sdk_object: (a: number, b: number, c: number) => any;
    readonly sdk_objectEvents: (a: number, b: any, c: number) => any;
    readonly sdk_pinObject: (a: number, b: number) => any;
    readonly sdk_pruneSlabs: (a: number) => any;
    readonly sdk_shareObject: (a: number, b: number, c: any) => [number, number, number, number];
    readonly sdk_sharedObject: (a: number, b: number, c: number) => any;
    readonly sdk_slab: (a: number, b: number, c: number) => any;
    readonly sdk_updateObjectMetadata: (a: number, b: number) => any;
    readonly sdk_upload: (a: number, b: number, c: any, d: number) => any;
    readonly sdk_uploadPacked: (a: number, b: number) => any;
    readonly setLogger: (a: any, b: any) => void;
    readonly validateRecoveryPhrase: (a: number, b: number) => [number, number];
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke___wasm_bindgen_baa1b51bcdcd1a91___sys__Undefined__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_baa1b51bcdcd1a91___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke___wasm_bindgen_baa1b51bcdcd1a91___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_baa1b51bcdcd1a91___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke___wasm_bindgen_baa1b51bcdcd1a91___sys__Undefined__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_baa1b51bcdcd1a91___JsError___true__3: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke___wasm_bindgen_baa1b51bcdcd1a91___sys__Undefined__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_baa1b51bcdcd1a91___JsError___true__4: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke___js_sys_7950a63e25495cc6___Function_fn_wasm_bindgen_baa1b51bcdcd1a91___JsValue_____wasm_bindgen_baa1b51bcdcd1a91___sys__Undefined___js_sys_7950a63e25495cc6___Function_fn_wasm_bindgen_baa1b51bcdcd1a91___JsValue_____wasm_bindgen_baa1b51bcdcd1a91___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke___wasm_bindgen_baa1b51bcdcd1a91___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_baa1b51bcdcd1a91___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
