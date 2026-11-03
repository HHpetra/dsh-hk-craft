'use strict'

/**
 * Drag-routing adapter for a split pane host.
 *
 * Pure hit and takeover decisions live next to the injection that hands one
 * drop to one session. The document listener (`pane-file-drop-events.js`) is
 * the only caller that touches the DOM; this module stays free of it so the
 * decisions can be table-tested.
 *
 * Upstream assumptions are recorded in
 * `docs/upstream-contracts.md#document-file-drop-and-per-pane-routing`.
 * This is a consumer of the pane snapshot (ADR-0017): it owns no register and
 * reports nothing back through `snapshotPatch()`.
 */

const { relativizeToCwd, workspaceTitleOf, formatFileMention } = require('./file-drop-format.js')

/**
 * Whether a browser-declared MIME selects the image draft path.
 *
 * The four types match `isImageMediaType` in `@deepseek-ai/dsh-client-ui-conversation`
 * 0.2.1-rc.5. Every other type, including `image/jpg` and `image/svg+xml`,
 * uploads as a file or becomes a reference chip.
 *
 * @param {string} value the browser's declared MIME type
 * @returns {boolean}
 */
function isImageMediaType(value) {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

/**
 * @param {unknown} types `dataTransfer.types` (array or DOMStringList)
 * @returns {boolean}
 */
function typesIncludeFiles(types) {
  if (types == null) return false
  try {
    if (typeof types.includes === 'function' && types.includes('Files')) return true
    if (typeof types.contains === 'function') return types.contains('Files') === true
  } catch (_error) {
    return false
  }
  return false
}

/**
 * A drag whose payload includes files. Session, tab and text drags do not.
 *
 * @param {{dataTransfer?: {types?: unknown}}|null|undefined} event
 * @returns {boolean}
 */
function isFileDrag(event) {
  return typesIncludeFiles(event?.dataTransfer?.types)
}

/**
 * @param {unknown} target an event target, which may be a text node
 * @returns {unknown|null}
 */
function elementOf(target) {
  if (target == null || typeof target !== 'object') return null
  if (typeof target.closest === 'function') return target
  const parent = target.parentElement
  if (parent != null && typeof parent.closest === 'function') return parent
  return null
}

const PANE_SELECTOR = '[data-hkcraft-pane]'

/**
 * The pane element under a drag target, when the pointer is inside one.
 *
 * @param {unknown} target
 * @returns {any|null}
 */
function paneElementFrom(target) {
  const element = elementOf(target)
  if (element == null) return null
  const pane = element.closest(PANE_SELECTOR)
  return pane == null ? null : pane
}

/**
 * The pane id under a drag target. Separators, the tab strip and the sidebars
 * are outside `[data-hkcraft-pane]`, so they miss.
 *
 * @param {unknown} target
 * @returns {string|null}
 */
function paneIdFromTarget(target) {
  const pane = paneElementFrom(target)
  if (pane == null || typeof pane.getAttribute !== 'function') return null
  const id = pane.getAttribute('data-hkcraft-pane')
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Every pane currently loaded, across visible and hidden workspaces.
 *
 * The active tree is also published as `snapshot.panes`. Counting it together
 * with `layouts` would count that workspace twice, so pane ids are unique.
 * The unscoped tree is absent from `layouts` and is read from `panes`.
 *
 * @param {any} snapshot controller snapshot
 * @returns {Map<string, any>}
 */
function loadedPanes(snapshot) {
  /** @type {Map<string, any>} */
  const panes = new Map()
  const take = (record) => {
    if (record == null || typeof record !== 'object') return
    for (const [paneId, pane] of Object.entries(record)) {
      if (panes.has(paneId)) continue
      if (pane == null || typeof pane !== 'object') continue
      panes.set(paneId, pane)
    }
  }
  const layouts = snapshot?.layouts
  if (layouts != null && typeof layouts === 'object') {
    for (const layout of Object.values(layouts)) take(layout?.panes)
  }
  take(snapshot?.panes)
  return panes
}

/**
 * @param {any} snapshot
 * @returns {number}
 */
function loadedPaneCount(snapshot) {
  return loadedPanes(snapshot).size
}

/**
 * Take over a file drag only when more than one pane is loaded. A single pane
 * keeps dsh's own document listeners.
 *
 * @param {{dataTransfer?: {types?: unknown}}|null|undefined} event
 * @param {any} snapshot
 * @returns {boolean}
 */
function takeoverFileDrag(event, snapshot) {
  return isFileDrag(event) && loadedPaneCount(snapshot) > 1
}

/**
 * @param {any} snapshot
 * @param {string|null|undefined} paneId
 * @returns {string|null}
 */
function sessionIdForPane(snapshot, paneId) {
  if (typeof paneId !== 'string' || paneId === '') return null
  const sessionId = loadedPanes(snapshot).get(paneId)?.sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
}

/**
 * Decide one file drag against a pane snapshot.
 *
 * `takeover` stays true when the pointer misses every pane: the drop must be
 * swallowed so the hidden composers never see it, and nothing is injected.
 *
 * @param {{dataTransfer?: {types?: unknown}, target?: unknown}|null|undefined} event
 * @param {any} snapshot
 * @returns {{takeover: boolean, paneId: string|null, sessionId: string|null}}
 */
function routeFileDrag(event, snapshot) {
  if (!takeoverFileDrag(event, snapshot)) {
    return { takeover: false, paneId: null, sessionId: null }
  }
  const paneId = paneIdFromTarget(event?.target)
  return {
    takeover: true,
    paneId,
    sessionId: paneId == null ? null : sessionIdForPane(snapshot, paneId),
  }
}

/**
 * Members of a drop that are directories.
 *
 * The `File` a directory drop yields is indistinguishable from an empty file,
 * so the entry API is the only source of that fact. Browsers without it
 * report no directories. Same walk as `droppedDirectories` in
 * `@deepseek-ai/dsh-client-ui-attachment` 0.2.1-rc.5.
 *
 * @param {{items?: ArrayLike<any>}|null|undefined} dataTransfer
 * @param {readonly unknown[]} files files in `dataTransfer.files` order
 * @returns {Set<unknown>}
 */
function droppedDirectories(dataTransfer, files) {
  /** @type {Set<unknown>} */
  const directories = new Set()
  const items = dataTransfer?.items
  if (items == null || typeof items.length !== 'number') return directories
  let fileIndex = 0
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item?.kind !== 'file') continue
    const file = files[fileIndex]
    fileIndex += 1
    if (typeof item.webkitGetAsEntry !== 'function') continue
    let entry
    try {
      entry = item.webkitGetAsEntry()
    } catch (_error) {
      continue
    }
    if (entry?.isDirectory !== true) continue
    if (file !== undefined) directories.add(file)
  }
  return directories
}

/**
 * Copy a `FileList` (or an array) into an array, preserving order.
 *
 * @param {{files?: ArrayLike<unknown>}|null|undefined} dataTransfer
 * @returns {unknown[]}
 */
function filesOf(dataTransfer) {
  const list = dataTransfer?.files
  if (list == null || typeof list.length !== 'number') return []
  /** @type {unknown[]} */
  const files = []
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index]
    if (file != null) files.push(file)
  }
  return files
}

/**
 * @param {unknown} hostPaths an explicit bridge, `null` to force none, or `undefined` to read the shell global
 * @returns {{pathFor: (file: unknown) => string}|undefined}
 */
function resolveBridge(hostPaths) {
  let bridge = hostPaths
  if (hostPaths === undefined) {
    try {
      bridge = globalThis.__DSH_HOST_PATHS__
    } catch (_error) {
      bridge = undefined
    }
  }
  if (bridge == null || typeof bridge !== 'object') return undefined
  if (typeof bridge.pathFor !== 'function') return undefined
  return bridge
}

/**
 * @param {{items?: ArrayLike<any>}|null|undefined} dataTransfer
 * @returns {boolean}
 */
function dragHasDirectory(dataTransfer) {
  const items = dataTransfer?.items
  if (items == null || typeof items.length !== 'number') return false
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item?.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue
    try {
      if (item.webkitGetAsEntry()?.isDirectory === true) return true
    } catch (_error) {
      // A browser that refuses the entry API during dragover reports no directory.
    }
  }
  return false
}

/**
 * The enabled hidden file input inside a pane, when the composer mounted one.
 *
 * @param {any} paneRoot
 * @returns {any|null}
 */
function enabledFileInput(paneRoot) {
  if (paneRoot == null || typeof paneRoot.querySelector !== 'function') return null
  let input
  try {
    input = paneRoot.querySelector('input[type="file"]')
  } catch (_error) {
    return null
  }
  if (input == null || input.disabled === true) return null
  return input
}

/**
 * How a drop on this session can be accepted, plus the scope faces when the
 * shell can take references and drafts.
 *
 * `accept` — `canPickFiles()` allowed it (or the shell has no such query) and
 * both `addFiles` and `createDrafts` are present.
 * `reject` — `canPickFiles()` refused; the drop is discarded.
 * `fallback` — the scope services are missing or threw; try the hidden file input.
 *
 * @param {any} sessions
 * @param {string|null|undefined} sessionId
 * @returns {{route: 'accept', shell: any, conversation: any}|{route: 'reject'|'fallback'}}
 */
function openIntake(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return { route: 'reject' }
  let shell
  let conversation
  try {
    const scoped = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined
    shell = scoped?.get?.('input')
    conversation = scoped?.get?.('conversation')
  } catch (_error) {
    return { route: 'fallback' }
  }
  if (typeof shell?.canPickFiles === 'function') {
    try {
      if (shell.canPickFiles() !== true) return { route: 'reject' }
    } catch (_error) {
      return { route: 'fallback' }
    }
  }
  if (typeof shell?.addFiles === 'function' && typeof conversation?.createDrafts === 'function') {
    return { route: 'accept', shell, conversation }
  }
  return { route: 'fallback' }
}

/**
 * @param {any} sessions
 * @param {string|null|undefined} sessionId
 * @returns {'accept'|'reject'|'fallback'}
 */
function intakeRoute(sessions, sessionId) {
  return openIntake(sessions, sessionId).route
}

/**
 * Whether the pointer pane should show the accept highlight.
 *
 * A directory drag with no host-path bridge is refused up front: the composer
 * rejects that whole batch, and the highlight says so before the drop.
 *
 * @param {any} sessions
 * @param {string|null|undefined} sessionId
 * @param {any} paneRoot
 * @param {{items?: ArrayLike<any>}|null|undefined} [dataTransfer]
 * @param {unknown} [hostPaths]
 * @returns {boolean}
 */
function willAcceptDrop(sessions, sessionId, paneRoot, dataTransfer, hostPaths) {
  if (dragHasDirectory(dataTransfer) && resolveBridge(hostPaths) == null) return false
  const route = intakeRoute(sessions, sessionId)
  if (route === 'accept') return true
  if (route === 'reject') return false
  return enabledFileInput(paneRoot) != null
}

/**
 * @param {any} sessions
 * @param {string} sessionId
 * @returns {string|undefined}
 */
function cwdOf(sessions, sessionId) {
  try {
    const cwd = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
    return typeof cwd === 'string' ? cwd : undefined
  } catch (_error) {
    return undefined
  }
}

/**
 * @param {{pathFor: (file: unknown) => unknown}|undefined} bridge
 * @param {unknown} file
 * @returns {string}
 */
function pathOf(bridge, file) {
  if (bridge == null) return ''
  const path = bridge.pathFor(file)
  return typeof path === 'string' ? path : ''
}

/**
 * Classify one drop the way the composer's `addFiles` does.
 *
 * A directory without a usable path, or a path the mention grammar refuses,
 * fails the whole batch. Nothing is partially inserted.
 *
 * @param {readonly any[]} files
 * @param {Set<unknown>} directories
 * @param {{pathFor: (file: unknown) => unknown}|undefined} bridge
 * @param {string|undefined} cwd
 * @returns {{ok: true, uploads: any[], references: any[]}|{ok: false, reason: string}}
 */
function planIntake(files, directories, bridge, cwd) {
  /** @type {any[]} */
  const uploads = []
  /** @type {any[]} */
  const references = []
  for (const file of files) {
    const directory = directories.has(file)
    if (bridge == null && directory) return { ok: false, reason: 'directory' }
    const path = pathOf(bridge, file)
    if (directory && path === '') return { ok: false, reason: 'path' }
    const mediaType = typeof file?.type === 'string' ? file.type : ''
    if (path === '' || (!directory && isImageMediaType(mediaType))) {
      uploads.push(file)
      continue
    }
    const relative = relativizeToCwd(path, cwd)
    const mention = formatFileMention(
      { path: directory ? `${relative}/` : relative, kind: 'file' },
      false,
    )
    if (mention === undefined) return { ok: false, reason: 'mention' }
    const titled = workspaceTitleOf(path)
    const name = typeof file?.name === 'string' ? file.name : ''
    const label = titled || name
    references.push({
      source: 'reference',
      ref: mention,
      label: directory ? `${label}/` : label,
      appearance: directory ? 'folder' : 'file',
      clipboardText: mention,
    })
  }
  return { ok: true, uploads, references }
}

/**
 * Place ordinary files onto the composer's hidden file input and fire `change`.
 *
 * @param {any} input
 * @param {readonly unknown[]} files
 * @returns {boolean}
 */
function placeFilesOnInput(input, files) {
  const Transfer = globalThis.DataTransfer
  const EventCtor = globalThis.Event
  if (typeof Transfer !== 'function' || typeof EventCtor !== 'function') return false
  const transfer = new Transfer()
  if (transfer.items == null || typeof transfer.items.add !== 'function') return false
  for (const file of files) transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new EventCtor('change', { bubbles: true }))
  return true
}

/**
 * @param {any} conversation
 * @param {readonly any[]} drafts
 */
function releaseDrafts(conversation, drafts) {
  if (typeof conversation?.releaseDraftAttachments !== 'function') return
  try {
    conversation.releaseDraftAttachments(drafts)
  } catch (_error) {
    // The drop is already being abandoned; a failed release stays silent.
  }
}

/**
 * @param {any} paneRoot
 * @param {readonly any[]} files
 * @param {Set<unknown>} directories
 * @param {((input: any, files: readonly any[]) => boolean)|undefined} placeFiles
 * @returns {{outcome: 'input', files: any[]}|{outcome: 'discarded'}}
 */
function fallbackFileInput(paneRoot, files, directories, placeFiles) {
  const regular = files.filter((file) => !directories.has(file))
  if (regular.length === 0) return { outcome: 'discarded' }
  const input = enabledFileInput(paneRoot)
  if (input == null) return { outcome: 'discarded' }
  const place = typeof placeFiles === 'function' ? placeFiles : placeFilesOnInput
  try {
    if (place(input, regular) === true) return { outcome: 'input', files: regular }
  } catch (_error) {
    return { outcome: 'discarded' }
  }
  return { outcome: 'discarded' }
}

/**
 * Give one drop to one session.
 *
 * Pathful non-images and folders become reference chips. Images and path-less
 * files become draft uploads. `addFiles` returning anything other than `true`
 * releases those drafts and adds nothing. A missing scope, a missing method
 * or a throw falls back to the pane's hidden file input (files only); if that
 * cannot run, the drop is discarded.
 *
 * @param {{
 *   sessions: any,
 *   sessionId: string|null|undefined,
 *   files: readonly any[],
 *   directories?: Set<unknown>,
 *   paneRoot?: any,
 *   hostPaths?: unknown,
 *   placeFiles?: (input: any, files: readonly any[]) => boolean,
 * }} input
 * @returns {{outcome: string, reason?: string, references?: any[], draftIds?: any[], files?: any[]}}
 */
function deliverPaneFiles(input) {
  const files = Array.isArray(input?.files) ? input.files : []
  const directories = input?.directories instanceof Set ? input.directories : new Set()
  if (files.length === 0) return { outcome: 'ignored' }

  const opened = openIntake(input.sessions, input.sessionId)
  if (opened.route === 'reject') return { outcome: 'rejected', reason: 'busy' }
  if (opened.route === 'fallback') {
    return fallbackFileInput(input.paneRoot, files, directories, input.placeFiles)
  }

  const conversation = opened.conversation
  const shell = opened.shell
  const bridge = resolveBridge(input.hostPaths)
  const cwd = cwdOf(input.sessions, input.sessionId)

  let plan
  try {
    plan = planIntake(files, directories, bridge, cwd)
  } catch (_error) {
    return fallbackFileInput(input.paneRoot, files, directories, input.placeFiles)
  }
  if (plan.ok === false) return { outcome: 'rejected', reason: plan.reason }

  let drafts
  try {
    drafts = conversation.createDrafts(input.sessionId, plan.uploads)
    if (!Array.isArray(drafts)) throw new Error('createDrafts')
  } catch (_error) {
    return fallbackFileInput(input.paneRoot, files, directories, input.placeFiles)
  }

  let accepted
  try {
    accepted = shell.addFiles(
      plan.references,
      drafts.map((draft) => draft?.id),
    )
  } catch (_error) {
    releaseDrafts(conversation, drafts)
    return fallbackFileInput(input.paneRoot, files, directories, input.placeFiles)
  }
  if (accepted !== true) {
    releaseDrafts(conversation, drafts)
    return { outcome: 'rejected', reason: 'refused' }
  }
  return {
    outcome: 'added',
    references: plan.references,
    draftIds: drafts.map((draft) => draft?.id),
  }
}

module.exports = {
  isImageMediaType,
  isFileDrag,
  paneIdFromTarget,
  paneElementFrom,
  loadedPaneCount,
  loadedPanes,
  takeoverFileDrag,
  sessionIdForPane,
  routeFileDrag,
  droppedDirectories,
  filesOf,
  resolveBridge,
  dragHasDirectory,
  intakeRoute,
  willAcceptDrop,
  deliverPaneFiles,
}
