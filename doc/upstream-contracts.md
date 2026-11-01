# dsh contracts this plugin depends on

This page is the durable record of the DeepSeek Harness (dsh) behaviour the
client half of `dsh-hk-craft` builds on. Code comments point here instead of at
a checkout or a temporary extraction directory, because `.scratch/` is a
short-lived working area (`AGENTS.md` §3.2) and upstream line numbers drift
between releases.

**Verified version:** `@deepseek-ai/dsh` **0.2.1-rc.5** — the train pinned in
`deps/VERSIONS.md` and `packages/dsh-hk-craft/package.json` (`engines.dsh`), and
the runtime shipped with the installed Desktop application
(`resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh*`).
The items below were originally read in the 0.2.0-rc.2 bundles. The
conversation-occurrence and phase rules were re-read in 0.2.1-rc.5 (that is the
delta the composer regression came from); the remaining items still carry their
0.2.0-rc.2 reading and need the manual smoke pass on this train.

**Verification method:** read-only inspection of the unpacked client plugin
bundles shipped with that version (`@deepseek-ai/dsh-client-ui-*` and
`@deepseek-ai/dsh-api-*`, their `lib/client.js` and type declarations) plus the
official package READMEs. No dsh runtime is available in this repository, so
every item below also needs a manual smoke check when the plugin is installed
into `desktop`. When upgrading dsh, re-verify every item and update this page;
the code should then be a one-file fix per adapter.

---

## `main` keyed slot and `selectPanel`

**Provider:** `@deepseek-ai/dsh-client-ui-layout` (`layout` client service).

**Semantics:** `main` is a keyed root slot. The frame renders the entry whose
key equals `activePanelId ?? "conversation"`, so selecting a different key
unmounts the native Conversation instead of stacking a second one on top.
`ctx.layout.selectPanel(id)` switches that key and rejects ids with no live
`main` entry; `selectPanel(null)` returns to the native Conversation. When a
panel unregisters, the layout controller resets `activePanelId`, which is why
the plugin does not have to clean it up by hand.

**Why we rely on it:** the pane workspace is one `main` entry (`key =
"hkcraft.panes"`); selecting it is the whole "enter split view" mechanism, and
`selectPanel(null)` is the clean way back to native dsh.

**Verified:** slot key fallback, `selectPanel` validation, and the
unregistration reset were read in the ui-layout bundle. Runtime probe: enter the
split panes from the HK Craft settings page and confirm the native conversation
unmounts.

---

## SessionProvider and conversation.content

**Provider:** `@deepseek-ai/dsh-client-ui-renderer` (`slots` kit) and
`@deepseek-ai/dsh-client-ui-conversation` (the `conversation.content` factory).

**Semantics:** a `main` entry that declares a non-root child receives
`SessionProvider` and the authorized `renderSlot` in its kit. A session-scoped
child entry additionally receives the session standard props (`sessionId`,
`useSession`, …). Every entry kit exposes
`renderFactorySlot(name, props, options)`, which does not check slot ownership.
The official Conversation mounts its body through
`renderFactorySlot("conversation.content", { variant: "main", phase, hero },
{ slots, fallback })`; the factory is registered under that literal name.

**Why we rely on it:** each pane mounts `<SessionProvider session={ref}>` plus
`renderFactorySlot("conversation.content", …)`, which is how a pane gets dsh's
real conversation UI (composer, streaming, tool calls) for a chosen session
without forking or copying it and without a second React tree.

**Occurrence: a pane must pass `variant: "embedded"`.** The Factory is rendered
by two kinds of caller and the caller has to say which one it is. `main`
assumes it sits inside `main.conversation`, whose `.root[data-phase]` element
owns the phase-scoped rules that pin the composer (`position: sticky;
bottom: 0`), centre the hero and hand the scrollport to the transcript.
`embedded` is the supported non-root occurrence: the same rules hang off the
body's own `[data-content-phase]`, the content column is derived from the
occurrence width, and the main header and width handles are omitted. A pane has
no `.root`, so `main` leaves the composer seat in normal flow at the end of the
scrolling transcript: the pane shows the messages and no input box
(`ConversationRoot.module.css` in `@deepseek-ai/dsh-client-ui-conversation`
0.2.1-rc.5).

**Phase: `hero` must be false for a live Session.** `phase`/`hero` are supplied
by the caller, not derived by the Factory. The native derivation ORs
`conversation.activeTargets` with the Session summary, but a pane only receives
the Session standard props — `conversation` is ui-conversation's own hook and
is absent — so its absence must mean "no active targets", not "no Session".
Reading it as blank selects the Factory's `hero` (or `settling`) state, whose
composer stack is not the pinned conversation seat.

**Verified:** factory name, props and the ownership rule were read in the
renderer and ui-conversation bundles; `slots.snapshot("factory:<name>")` was
used as a feature probe. The two occurrences and their phase-scoped CSS were
read in 0.2.1-rc.5. Runtime probe: split into two panes, open a live Session in
one, and confirm its composer stays pinned at the pane bottom while the
transcript scrolls behind it.

---

## Retention sources and the single `mainView` derivation

**Provider:** `@deepseek-ai/dsh-api-session-controller` (`sessions.retain`) and
`@deepseek-ai/dsh-client-ui-workspace` / `-session` (the "current session"
consumers).

**Semantics:** `sessions.retain(sessionId, { source })` returns an independent
reference with `ready` and `release()`. `source` is a free-form label; dsh does
not enforce uniqueness. "The current session" is derived, not stored: consumers
scan the session list for the first row with `retainedBy.mainView > 0`. The
right sidebar uses its own source (`sidebarView`) the same way. Releasing a
reference tears down that client generation only; it never stops the host
agent.

**Why we rely on it:** every mounted pane holds one `hkcraftPane` reference;
exactly one pane (the focused pane of the visible workspace) also holds the
`mainView` reference, so dsh's single-value derivation keeps following the
focused pane while the others keep streaming.

**Verified:** retention API and the scan were read in the session controller and
ui-workspace bundles. Runtime probe: focus different panes and check the
sidebar's current row and rename/fork shortcuts follow the focused one.

---

## Interrupting a running turn

**Provider:** `@deepseek-ai/dsh-api-session-controller` (`sessions.scope`) and
`@deepseek-ai/dsh-client-ui-conversation` (the stop button).

**Semantics:** the shell's stop action resolves the session-scoped face as
`sessions.scope(id).get("conversation")` and calls `cancel()` on it. That
`cancel()` forwards to `sessions.binding(id).session.cancel()`, the Host RPC
`remote.session.cancel({ sessionId })`. The binding form reports failure as
`{ ok: false, error }` instead of throwing.

**Why we rely on it:** closing a running pane must stop the turn before the
pane is released (spec D4). This is the same public route the stop button uses;
releasing a client reference is not a substitute.

**Verified:** stop-button path and the RPC were read in ui-conversation and the
session controller. Runtime probe: close a streaming pane, confirm the host
turn stops and history is kept.

---

## Conversation View switch

**Provider:** `@deepseek-ai/dsh-client-ui-conversation`
(`uiConversation.binding(id)`).

**Semantics:** `uiConversation.binding(sessionId)` resolves the stable
per-session binding and throws for an unknown or inactive session.
`binding.activate(viewId)` activates the assembler target that builds the View
data (`"chat"`, `"trajectory"`) without rebuilding the session, so the draft and
the native scroll behaviour are untouched.

**Important:** `binding.activate(view)` alone does **not** change what the shell
renders. dsh's own View switcher (`selectView` in `conversation.session`) calls
`activateView(...)` **and** `actions.setView(view)`, where the latter writes
ui-conversation's per-session `dsh.conversation` store. The rendered View is
`resolveActiveView(tabs, useStore((s) => s.view))`, so without that store write the
shell stays on Chat. See the next section for how the pane replaces that
selection without writing the store.

**Why we rely on it:** the pane still warms the assembler target through the
public binding before rendering the View; the actual rendering choice comes from
the pane's layout record via the embedded `views` slot.

**Verified:** binding, activate, and the `selectView` double write were read in
ui-conversation 0.2.1-rc.5. Runtime probe: calling only `binding.activate` leaves
the pane on Chat.

---

## Embedded `views` local slot and View selection

**Provider:** `@deepseek-ai/dsh-client-ui-conversation` (the `conversation.content`
factory) and `@deepseek-ai/dsh-client-ui-renderer` (factory local components).

**Semantics:** the `conversation.content` factory declares `views` as a local
`session` component slot. Its default renders the `conversation.session` entry,
which chooses the View from the per-session store described above.
`renderFactorySlot(name, props, { slots: { views: Component } })` lets the caller
replace that local component for its own occurrence. The replacement receives
the session standard props and the **factory-bound** `renderSlot`, so it can
render the direct child `conversation.session` with owner props.
`conversation.session`'s `DefaultConversationViews` honours a `view` prop over the
store (`viewId = view ?? active?.id`).

**Why we rely on it:** the pane's View memory lives in its layout record, not in
ui-conversation's store. Replacing `views` and passing that View as
`conversation.session`'s `view` prop keeps dsh's transcript, draft persistence and
composer while making the pane's toggle authoritative. The toggle still calls
`binding.activate` first so the target data is built.

**Verified:** the factory's local `views` declaration, the default adapter, the
`view` override and `selectView`'s double write were read in ui-conversation
0.2.1-rc.5; local-component binding was read in `dsh-client-ui-renderer`. Manual
probe to run after install: toggle a pane to Trajectory and confirm the transcript
swaps while the composer stays mounted, then click a tool call in Chat and confirm
the inspect jump reaches the pane.

---

## Trajectory gate (`developerTools.enabled`)

**Provider:** `@deepseek-ai/dsh-client-ui-conversation` and
`@deepseek-ai/dsh-client-ui-settings`.

**Semantics:** the trajectory View is gated by
`ctx.configForms.developerTools.enabled.getSnapshot()`. While that value is
false, ui-conversation does not offer the View at all — it is absent, not
disabled. `DeveloperToolsPreference` reads `value?.enabled ?? false`, so the
answer is false until the host value arrives.

**Why we rely on it:** a pane must match native dsh. When the gate is off the
trajectory View is not rendered (and a remembered trajectory choice reads as
chat); when the gate flips back on, the remembered choice is re-asserted.

**Verified:** the gate read and the "skip the View entirely" branch were read
in ui-conversation and ui-settings. Runtime probe: turn developer tools off and
confirm the View disappears from every pane.

---

## Slash commands and `popupSelect`

**Provider:** `@deepseek-ai/dsh-client-ui-commands` (`commandUi`).

**Semantics:** `commandUi.register(spec)` adds a client-local slash command.
`ui.kind: "action"` runs a callback with the triggering session; nothing is sent
to the model. `ui.kind: "popupSelect"` opens the shell's own overlay, which owns
↑/↓, Enter, Esc, the search field and the local filtering. In
`searchMode: "fuzzy-label"` the shell ranks `option.label` only; `detail` and
`badge` are display-only. `onSelect(option, context)` receives no keyboard
event, so modifiers must be tracked separately.

**Why we rely on it:** `/clear`, `/new`, `/resume`, `/fork` and `/trace` are
pure client commands. `/resume` is the `popupSelect`; the others are `action`s.
The pane-aware `Ctrl+Enter` (open in a new pane) has to be observed around the
shell's own handler because the shell ignores event modifiers.

**Verified:** registration, popup dispatch, label-only ranking and the missing
event argument were read in the commands bundle. Runtime probe: run both
commands and confirm the session log gains no model request.

---

## Session summary fields

**Provider:** `@deepseek-ai/dsh-api-session-controller` (`sessions.list`
snapshot) and `@deepseek-ai/dsh-client-ui-session` (`sessionStatus` map).

**Semantics:** the session list snapshot is `{ phase, ids, byId }`. A row
carries `{ id, title, displayTitle, running, blank, updatedAt }`;
`displayTitle` falls back to the cwd basename and then the raw id, so a
"missing title" decision must read `title`, never `displayTitle`. `sessionStatus`
is a `Map<sessionId, { running, pendingInteraction, completionUnread }>`, where
`pendingInteraction` is an approval/question/plan-review union. There is **no
failure bit** in either projection: a failed turn is a conversation node, not a
summary field. `blank` is true while the conversation has never sent a message;
the sidebar inverts it into the light's `started` signal, so an enabled workspace
holding only fresh blank sessions stays gray.

**Why we rely on it:** the sidebar lights and the strip dots are derived from
these fields only; reading an error would require opening every session's
history, which the sidebar must not do. This is why red means "waiting for you"
and not "errored" (spec §7).

**Verified:** snapshot and status shapes were read in the controller and
ui-session bundles. Runtime probe: run a turn, queue an approval, and compare
the lights.

---

## Completion unread

**Provider:** `@deepseek-ai/dsh-client-ui-session` (`sessionStatus` map).

**Semantics:** `completionUnread` is true for a session whose turn stopped running
while that session was **not** the current one (`mainView` retention). It is
cleared when the session becomes current again (for example, it is focused) or
when it starts running again. The plugin reads it as the `unread` signal; the
sidebar paints green only for this bit, so a workspace that is merely idle stays
blue after a restart instead of looking like a fresh completion.

**Why we rely on it:** without this bit, "a conversation just finished and you have
not looked" is indistinguishable from "nothing is running"; a restart would paint
every used workspace green. The bit is part of the same `sessionStatus` map the
sidebar already consumes, so the light needs no extra history read.

**Verified:** set/clear rules were read in the 0.2.1-rc.5 `ui-session` bundle
(`observeRunning`, `reconcileStatus`, `isMain`). Runtime probe: leave a workspace,
let a background turn finish, confirm green; focus the conversation, confirm it
returns to idle.

---

## Desktop notifications (renderer `Notification`)

**Provider:** the Electron renderer's standard `Notification` API, dsh's Electron
session permission handler (`resources/app.asar` → `lib/main.js`,
`installMicrophonePermissions`), `@deepseek-ai/dsh-client-ui-session`
(`uiSession.sessionStatus`), and `@deepseek-ai/dsh-api-session-controller`
(the forwarded `api-session/error` event).

**Semantics:** dsh exposes no plugin-facing notification service. The only
`Notification` in the Electron main process is the mandatory-update reminder,
and the client `Toast` is an in-app overlay. A plugin renderer can still call
`new Notification(title, options)`: the `dsh-app://` scheme is registered with
`secure: true`, and the application session's permission handler answers `true`
for every non-`media` permission (the microphone handler is the only special
case), so `Notification.permission` is `granted` in the Desktop shell.

The status projection supplies the type inputs without opening conversation
history:

- `sessionStatus` is a `Map<sessionId, { running, pendingInteraction,
  completionUnread }>`. A `pendingInteraction` carries `key`, `sessionId` and
  `kind`; `ui-approval` sets `kind: "approval"`, and `ui-user-questions` sets
  `kind: "question"` or `kind: "plan-review"` (from the plan intent). `key`
  identifies one interaction, so a new key is a new request.
- `running` true → false is one completed turn. `completionUnread` is not used
  for notifications: it is cleared when the session becomes the current one, so
  the focused pane's own completion would otherwise never notify.
- `api-session/error` forwards `(sessionId, message)` for a live `agent/error`
  (`dsh-agent-loop` `throwError`). It is relayed by the session controller and
  forwarded with a `session` resource. A failure has no summary bit, so this
  event is the cheap failure signal; a failed turn also ends with
  `running: false`, which is why the plugin suppresses the following completion.

`Notification` supports `tag`, `renotify`, `requireInteraction`, `silent`,
`data` and `onclick` in this renderer; `new Notification` displays immediately
(no `show()` call). The plugin uses one tag per type + session, keeps waiting
types on screen, and routes a click back into the pane controller or
`uiWorkspace.openSession`.

The optional foreground gate is client policy, not a dsh service:
`document.hasFocus()` and `document.visibilityState` decide whether the dsh
window is in front; split-view visibility is
`paneController.paneIndexOf(sessionId) != null` (every pane of the active
workspace is on screen); the native view uses `mainSessionId(sessions.list)`
(the `mainView` retention). When the gate is on and the session is visible, no
toast is raised; other workspaces and a background dsh still notify. The gate
does not queue suppressed events for later.

**Why we rely on it:** the plugin needs five distinct OS notifications without
reading every session's history or changing the Electron main process. The
status map and the error relay are the only public signals that separate
"waiting for approval", "waiting for an answer", "plan review", "finished" and
"failed".

**Verified:** the permission handler, the `dsh-app` scheme privileges, the
`sessionStatus` shape and `pendingInteraction.kind` values, and the
`api-session/error` emission/forwarding were read in the installed Desktop
0.2.1-rc.5 bundles (`lib/main.js`, `dsh-client-ui-session`,
`dsh-client-ui-approval`, `dsh-client-ui-user-questions`,
`dsh-api-session-controller`). Runtime probe: restart dsh, trigger each of the
five types, and confirm the settings page's test button shows a Windows toast.

**Windows identity caveat:** the toast's application identity is the Electron
process AUMID/Start Menu shortcut, not the plugin. The installed shortcut is
`com.deepseek.dsh`, while the application code does not call
`app.setAppUserModelId`; the runtime probe above must therefore include a real
Windows toast (the test button). If Windows suppresses it, the transport needs
a host/native helper; the five signals and their policy stay unchanged.

---

## Session preset and optional roster

**Provider:** `@deepseek-ai/dsh-api-session-controller` (the `sessions.list`
snapshot row), `@deepseek-ai/dsh-client-ui-agent-preset` (the native header
label), and `@deepseek-ai/dsh-agent-preset-registry` (the `remote.agentPresets`
namespace).

**Semantics:** a session summary row carries
`projectionValues.agentPreset`, a string id naming the Agent preset the
conversation was composed with. The native header label reads exactly
`state.byId[sessionId]?.projectionValues?.agentPreset` and renders nothing when
the field is absent, which is the same source and the same "no field, no badge"
rule the pane strip follows. The composition is fixed once the conversation
starts, so the label is read-only; there is no "switch this session's preset"
operation in the public services.

The roster behind the names is an **optional** capability:
`ctx.get("remote")` exposes `agentPresets.list()`, whose success result is
`{ ok: true, value: { presets: [{ id, isDefault, name?, description?, broken? }] } }`.
A failed read returns `{ ok: false, error }` (a not-yet-ready gateway is
`gateway/invocation-unavailable`), and an older or trimmed shell may have no
`remote` service at all. Declarations that publish a `name` own their copy; the
four shipped presets (`standard`, `ptc`, `minimal`, `cordis`) publish no name,
so their labels and descriptions are the UI dictionaries'
`presetStandardName`/`presetStandardDescription` (and the matching PTC, Minimal
and Creator keys). The pane badge localizes just the names and falls back to the
localized shipped name, then the raw id; the roster is read through `ctx.get`
instead of `inject`, and absence, failure or malformed rows degrade silently.

**Why we rely on it:** the split pane does not mount the native session header,
so the strip's read-only mode seat reconstructs its label from the same summary
field. Resolving copy in this order (`ctx`-read roster name > localized shipped
name > id) keeps custom presets honest without making user-authored names
translatable.

**Verified:** the summary read, the native `AgentPresetLabel` fallback and the
roster result shape were read in the installed Desktop 0.2.1-rc.5 bundles
(`dsh-client-ui-agent-preset`, `dsh-agent-preset-registry`,
`dsh-api-session-controller`). Runtime probe: start sessions with shipped and
custom presets, switch panes, and confirm the badge follows focus; remove the
`remote` fiber and confirm the built-in names still render.

---

## Subagent catalog (direct children)

**Provider:** `@deepseek-ai/dsh-api-session-controller` (`sessions.list`
snapshot, `sessions.refreshProjections`, `sessions.retain`) and
`@deepseek-ai/dsh-client-ui-session` (`sessionStatus`).

**Semantics:** the raw `useSessions` list snapshot also carries
`projectionsBySession: Record<sessionId, {state, error?, values}>`. The focused
conversation's direct children are
`projectionsBySession[sessionId].values.subagentCatalog`: an array in parent
catalog event order, **absent** until a projection read produces it (an explicit
`[]` is a ready empty catalog). Each entry is
`{ id, createdAt, mode, label? }`, where `mode` is `one-shot`, `continuable`,
`external` or `unknown`; `continuable` always carries a `label`, the other modes
may omit it. Activity prefers `sessionStatus.get(id)?.running` and falls back to
the summary row's `running`; a finished child reads completed only when
`summary.projectionValues.subagentTiming.lastTurnCompleted === true`. External
entries describe tasks without a local Session.

`refreshProjections(parentSessionId): Promise<void>` is public, does not start a
format migration, and reuses an in-flight read (or resolves immediately when the
catalog is already ready). It reads projections only; it never opens the
conversation. The native header's dropdown does **not** request its root catalog
on open — a plugin-side refresh on open is an extra, safe read.

**Why we rely on it:** the strip's subagent seat shows the focused
conversation's direct-child total and running count with a flat dropdown of
direct children, and hides itself when the projection has no usable entries. It
reads only these fields and never opens a child's history. On open it asks for
one refresh so newly created children appear promptly; a failure is ignored.

**Open: the public path that keeps the split view.** `sessions.retain(target)`
calls the manager's `resolveTarget`, which accepts either a session id or a
`{ parentSessionId, childSessionId, mode }` address. For a bare id it derives the
address from the parent catalog's `subagentCatalog` entry (`subagentAddress`) and
installs it on the Session instance, so a pane can retain and mount a direct child
by id. `external` entries are deliberately excluded from that derivation, which
is why the seat does not make them navigable. The native header instead passes the
address to `uiWorkspace.openSession(address)`, which reveals the native
conversation panel and would dismiss the pane workspace (see
[`#native-start-session-reveal`](#native-start-session-reveal)); the pane uses the
controller's `openInNewPane(sessionId)` instead — it focuses an already-open child
and otherwise splits a new pane beside the focused one (subject to the workspace
pane limit, ADR-0009).

**Verified:** the catalog shape, mode union and label requirements, activity
fallback, `refreshProjections`, and `resolveTarget`/`subagentAddress` were read in
the 0.2.1-rc.5 installed bundles (`dsh-api-session-controller`,
`dsh-client-ui-subagent`, `dsh-client-ui-session`). Runtime probe: open a split
pane whose conversation has children, check the count trigger and the localized
mode/activity rows, open a child in a new pane, and confirm an external row is
inert.

---

## Directory picker

**Provider:** the Electron preload bridge
`globalThis.__DSH_DIRECTORY_PICKER__` (`dsh-client-ui-directory-picker-native`)
or the public `uiWorkspace.pickDirectory()` service.

**Semantics:** both resolve a filesystem path, or `null` when the user cancels.
`workspaces.create({ path })` then resolves the workspace record or throws
`WorkspaceCreateError`.

**Why we rely on it:** "Add workspace" keeps dsh's own picking and creation
path instead of inventing a second directory dialog or writing to the profile.

**Verified:** both picker routes and `workspaces.create` were read in the
ui-directory-picker-native, ui-workspace and workspace-controller bundles.
Runtime probe: add a workspace from the slim sidebar and confirm it appears.

---

## Native start-session reveal

**Provider:** `@deepseek-ai/dsh-client-ui-workspace` (`uiWorkspace.openSession`
and the shared `replaceMain(…, "reveal")` path).

**Semantics:** both `openSession(sessionId)` and `startSession(workspaceId)`
eventually reveal the target through `replaceMain(…, "reveal")`, which
selects the native conversation panel (`selectPanel(null)`). That is the right
behaviour outside the pane workspace, but fatal inside it: the pane panel would
be dismissed and every pane unmounted. There is no public "reveal without
selecting the panel" variant.

**Why we rely on it:** `/resume` uses `openSession` only when the pane panel is
not showing; while it is showing, selection replaces/focuses a pane instead.
`/clear` for the same reason uses `sessions.create`, never `startSession`.

**Verified:** openSession/startSession and the reveal branch were read in the
ui-workspace bundle. Runtime probe: run `/resume` outside the pane workspace,
then inside it, and confirm the split survives only in the second case.

---

## Creating a session without leaving the panel

**Provider:** `@deepseek-ai/dsh-api-session-controller` (`sessions.create`).

**Semantics:** `sessions.create({ workspaceId })` resolves to the new session id
and publishes its catalog row before resolving. It creates a **new** session;
it never reuses an existing blank one. By contrast the native
`uiWorkspace.startSession(workspaceId)` reuses the workspace's blank session
(creating one when none exists) and then reveals it through
`replaceMain(…, "reveal")`, which calls `ctx.layout.selectPanel(null)` and
would dismiss the pane workspace.

**Why we rely on it:** `/clear`, `+`, and splitting a pane must put a new
conversation in the pane workspace. That is why the pane path calls
`sessions.create` and never `uiWorkspace.startSession`; the native path stays in
use only outside the pane workspace.

**Verified:** create's publication order and the reveal path were read in the
session controller and ui-workspace. Runtime probe: `/clear` inside a split,
then check the sidebar and `/resume` see the new session.

---

## Forking a session (`uiWorkspace.forkSession`)

**Provider:** `@deepseek-ai/dsh-client-ui-workspace` (`uiWorkspace.forkSession`)
over `@deepseek-ai/dsh-api-session-controller` (`sessions.fork`). The cut and
the migration preflight live in `dsh-api-session-controller/lib/index.js`. The
workspace puts the child on its session list in `@deepseek-ai/dsh-workspace`
(`attachSession`).

**Semantics:** `forkSession(sessionId, onCreated?, options?)` returns a Promise
of the child session id. It calls

```js
sessions.fork({
  sessionId,
  increaseTitle: true,
  // onCreated is omitted when the argument is undefined
  // allowMigration is omitted unless the caller set it
})
```

and nothing else. It does not call `openSession` or `replaceMain`, does not
`retain` the child, and does not open the child's history.

`sessions.fork` does not pass `atSeq`. The host then cuts at the latest
completed-turn prefix: the last `turn/end`, plus events after it until a
`turn/start`, an appending `user/message`, or `agent/inbox/spliced`. A turn
that is still open is not copied. A source with no `turn/end` is rejected as
`SessionForkError` with `rpcError.code === "session/fork-unavailable"`.

`options.allowMigration === false` — the value the native sidebar Fork item
passes — makes the host reject with `session/migration-required` when the
source is not loaded and its stored log still needs a format migration, instead
of migrating it. Omitting the flag keeps that automatic migration. `/fork`
passes `false`, the same as the sidebar.

On success the workspace prepends the child id onto `sessionIds`, so the copy
is listed ahead of the source. The client calls `onCreated(childId)` before
it renames the child, which is why a new pane can show the inherited title for
a moment. `increaseTitle` reads the source summary's `title` and renames the
child: a trailing ` (n)` or `（n）` increments, and any other title gains
` (1)`. A rename failure rejects after `onCreated` has already run; the child
still exists.

`SessionForkError` is an `Error` with `name === "SessionForkError"`,
`rpcError.code`, and `sourceSessionId`.

dsh-tui describes `/fork` as a copy of the whole conversation. This path can
leave out a turn that is still running, because that is what the sidebar does.
The plugin does not invent its own cut.

**Why we rely on it:** `/fork` must match the sidebar Fork item (cut, title,
list position, no navigation, same error codes). The plugin calls
`uiWorkspace.forkSession` and does not call `sessions.fork` itself. In the pane
workspace, `onCreated` opens the child in a new pane; in the native view the
callback is omitted, so the copy only shows up in the session list. A new pane
that the pane budget refuses does not roll the fork back.

**Verified:** read in Desktop `0.2.1-rc.5` (`resources/app.asar`):
`dsh-client-ui-workspace/lib/client.js` (`forkSession`, and the sidebar call
with `{ allowMigration: false }`), `dsh-api-session-controller/lib/client.js`
(`ClientSessions.fork`, `increasedForkTitle`, `SessionForkError`),
`dsh-api-session-controller/lib/index.js` (`latestCompletedPrefixBoundary` and
the `allowMigration: false` preflight), and `dsh-workspace/lib/index.js`
(`attachSession` prepends). Runtime probe: `/fork` in the native view and in a
split, including a blank session, a session with no completed turn, and a
workspace already at its pane cap.

---

## Workspace catalog

**Provider:** `@deepseek-ai/dsh-api-workspace-controller`
(`workspaces.list`).

**Semantics:** the snapshot is `{ items, archivedSessionIds, pinnedSessionIds,
phase, state }`. Each item is
`{ workspaceId, path, title, sessionIds, createdAt, updatedAt }`. `phase`
becomes `"ready"` only after the catalog has loaded; before that, `items` cannot
be trusted as a complete membership list. The automatic first-use title is the
literal `default-workspace`, localized at display time.

**Why we rely on it:** workspace membership decides which conversations
`/resume` lists and which panes survive a restore. The workspace catalog
becomes `"ready"` before the session list does, and the early membership can
still be empty. Until **both** `workspaces.list` and `sessions.list` are
`"ready"` the plugin keeps every stored pane instead of pruning against an
incomplete catalog, and re-runs the prune when the session list becomes ready.
The workspace shown at startup waits for that same moment before treating an
empty read as "no past conversations".

**Verified:** snapshot and record shapes were read in the workspace controller
and ui-workspace. Runtime probe: restart dsh with a deleted session and check
the pane is dropped.

---

## Deleting a workspace

**Provider:** `@deepseek-ai/dsh-api-workspace-controller` (`workspaces`).

**Semantics:** `workspaces.delete(workspaceId)` removes **only the workspace
registration**. It does not delete the directory and does not delete the
conversations: those sessions stay in dsh's session data, and the native sidebar
groups them under “Ungrouped”. It also does not interrupt a conversation that is
running — deleting the registration is not closing the session. The call
rejects with the shell's error when the host refuses the delete, and the local
state must then be left untouched.

A successful delete drops the row from `workspaces.list` immediately. A client
that still needs the deleted row's old position — for example to hand the view
to the next (or previous) workspace in Host order — must capture that order
*before* awaiting the call.

The plugin's own per-workspace layout key (`dsh.hkcraft.layout.v1.<workspaceId>`,
`layout-store.js`) is invisible to the host. After a successful delete the
plugin removes that key itself (`layout-store.js:removeLayout`), because the
“enabled” inference treats an existing key as evidence that the workspace was
opened in a split view; leaving it behind would resurrect a ghost workspace
after the next restart. Deleting a workspace that was never opened in split
view is still a meaningful operation (it clears just such a key) but has no
layout side effect.

**Why we rely on it:** the sidebar delete entry calls the public service first
and only then asks the pane controller to forget the workspace
(`dsh-workspaces.js:createSectionActions.deleteWorkspace` →
`dsh-pane-host.js:forgetWorkspace`). The controller drops the layout, releases
the pane references (never the Host sessions) and moves the visible workspace to
its Host-order neighbour.

**Verified:** the delete semantics are the user-confirmed contract recorded in
this feature's spec (§2, §8). Runtime probe on the pinned train: delete a
workspace with a running conversation and confirm the row and its layout key
disappear, the directory and sessions remain, and the turn keeps running.

---

## Workspace enablement ("ever opened in split")

**Provider:** this plugin itself — the workspace layout key
`dsh.hkcraft.layout.v1.<workspaceId>` (`src/client/layout-store.js`) plus the pane
controller's loaded-layout registry (`dsh-pane-host.js:isWorkspaceEnabled`).

**Semantics (the host boundary):** the layout key is plugin-owned storage; dsh
does not read or write it. The controller writes the key the first time a
workspace's tree is restored or shown in split, including an empty tree; nothing
else writes it. Opening a workspace in the native view goes through
`uiWorkspace.startSession`/`openSession` and never reaches the pane controller,
so it writes **no** key. The key's existence is read without parsing the payload:
a corrupt or empty payload still proves the workspace was opened in split at some
point. The key is also the record the delete path must clear after a successful
`workspaces.delete`, so a removed workspace cannot come back with a ghost layout.

**Why we rely on it:** the native-open path is indistinguishable from "never
shown in split" by layout alone, which is exactly the fact the plugin wants; the
`blank` summary bit (see [`#session-summary-fields`](#session-summary-fields))
and `completionUnread` (see [`#completion-unread`](#completion-unread)) supply the
other facts. How those become a sidebar light — including what gray and idle mean
— is a plugin UI decision, recorded in
[`README.md`](README.md#5-工作区状态与五态灯) and
[ADR-0007](../ai-docs/ADR/decisions.md#adr-0007--侧栏工作区管理窗格条工具栏与设置页搬迁) /
[ADR-0008](../ai-docs/ADR/decisions.md#adr-0008--五态工作区灯与窗格头部原生控件),
not an upstream contract.

**Degradation:** an absent storage backend or a throwing store means "no key" for
that workspace only; a pane controller that cannot answer at all makes the
section treat every workspace as enabled and derive the session lights from the
sessions, which loses at most the never-opened gray.

**Verified:** key existence and write timing were exercised through the storage
seam and the controller's fake services. Runtime probe: open a workspace in split
and watch the row leave gray without a reload; restart dsh and confirm it is
still enabled; open another workspace natively and confirm it stays gray.


---

## Workspace display order

**Provider:** `@deepseek-ai/dsh-client-ui-workspace` (the injectable `workspaces`
client service) over `@deepseek-ai/dsh-api-workspace-controller`.

**Semantics:** `workspaces.insertBefore(workspaceId, beforeWorkspaceId?)` moves
one workspace in the registry's durable display order. The positional
`beforeWorkspaceId` is the workspace the moved one must precede; omitting it (or
passing `undefined`) appends to the end. The remote request is the object
`{ workspaceId, beforeWorkspaceId? }` and its result is the complete resulting
order as `{ workspaceIds }`. The client model installs the optimistic order
immediately, then reconciles it with the returned complete order; on failure it
reinstalls its `committedOrder` **before** rejecting, and the rejection is a
plain `Error` whose message is `workspace reorder failed: <code>: <message>`.
`workspaces.list().items` is already in display order and is the only order the
plugin renders — the plugin keeps no order of its own, so a failed write needs
no local rollback.

**Why we rely on it:** pointer drag reordering only decides an
anchor from the row under the pointer and its upper/lower half; persistence,
optimism and rollback belong to the host. The sidebar therefore never sorts or
caches an order: it writes through this call and re-renders `workspaces.list`,
which is why "drop back into place" is detected before the call (no meaningless
write) and a failure simply shows the host's committed order again.

**Verified:** the positional client signature, the object-shaped remote request,
the `workspaceIds` result, the optimistic install / `committedOrder` restore and
the `commandError("reorder", …)` message were read in the workspace-controller
and ui-workspace bundles (0.2.1-rc.5). Runtime probe: drag a row past 6px, drop
it before/after another, restart dsh and confirm the order survived; then force a
failure and confirm the row snaps back while the error is shown.

---

## Split panel hides the native right bar

**Provider:** `@deepseek-ai/dsh-client-ui-sidebar-right` (the `rightbar` slot
occupant and `ctx.sidebarRight`) and the layout service's `panelInfo`.

**Semantics:** the shell frame always renders the `rightbar` slot for the main
column, but the occupant decides what is visible. Its `RightbarRoot` treats the
Session views as `visible` only while `panelInfo.activePanelId === null`, and
the same effect publishes the on-screen Session to `ctx.sidebarRight` as
`activePanelId === null ? selected?.sessionId : undefined`. With a plugin panel
selected — the pane workspace — native dsh hides the right bar and the public
face has no "current session" to act on. Its navigation calls (`openResource`,
`openTab`) act on that on-screen Session, and there is no public "open this
Session's right bar" call.

**Why we rely on it:** the pane strip's pinned native-action group therefore
ships no "open right sidebar" button in this version: it could not
open the native right bar for a split pane, and falling back to the native
conversation would silently leave the split. The group is the reserved home for
native header tools that can work inside a pane — the read-only mode badge
and the subagent viewer — and any future native tool
needs an explicit seat there.

**Verified:** `RightbarRoot`'s `activePanelId === null` visibility and the
`show(activePanelId === null ? selected?.sessionId : undefined)` sync were read
in `dsh-client-ui-sidebar-right` 0.2.1-rc.5 (the installed Desktop bundle).
Runtime probe: enter split view, confirm the native right bar is hidden and the
strip offers no right-bar button.

---

## `sidebar.workspaces` slot

**Provider:** `@deepseek-ai/dsh-client-ui-workspace` and
`@deepseek-ai/dsh-client-ui-sidebar`.

**Semantics:** the sidebar shell renders
`renderSlot("sidebar.workspaces", { wide, expandSidebar })`. It is a `single`
root slot; the slot core sorts entries by `priority ?? 0` ascending and renders
the first, and the shipped occupant registers without a priority (0). A negative
priority therefore shadows it without changing upstream code.

**Why we rely on it:** the slim workspace section (name + light + add) replaces
only that slot and keeps the rest of the sidebar, so the change stays a plugin,
not a fork.

**Verified:** slot render, shipped registration and the priority sort were read
in the sidebar and ui-workspace bundles. Runtime probe: install, confirm the
section is slim and uninstall restores the native one.

---

## `settings.section` slot

**Provider:** `@deepseek-ai/dsh-client-ui-settings-general` (the settings shell).

**Semantics:** the shell declares `settings.section` as a `list` root slot and
renders the active page with
`renderSlot("settings.section", { close }, { only: active })`. A contribution
registers `{ name, id, order, label, locale }` (plus optional
`children` / `inject`) through `ctx.slots.inject` followed by
`ctx.slots.register`; a list entry requires an `id`. The navigation projects
every entry as `{ id, order, label }` and sorts by `order` ascending. The
official top-level sections use `account -10` (when signed in), `general 0`,
`models 10`, `plugins 15` and `agent-presets 20`, so a page that wants the end of
the nav registers a larger order. `label` is a thunk resolved with
`resolveSlotLabel` and re-read whenever the slot version or the locale revision
changes, which is how a nav label follows a live language switch. The section
component receives the standard slot props (including the `t` bound by its
`locale`) plus `close`, the callback that dismisses the settings panel.

**Why we rely on it:** the diagnostics panel and the native ⇄ pane switch used
to be two `sidebar.footer.action` buttons; they now live in one
dedicated HK Craft settings page. The page consumes only the slot's `t` / `close`
and the pane controller closure, so it needs neither `configForms` nor a
settings data namespace. Because the entry is registered inside
`ctx.slots.inject`, a shell without the settings slot never runs the callback
and the page simply stays absent.

**Verified:** the root slot declaration, the ordered nav projection, the
`{ close }` render props and the thunk refresh were read in the
ui-settings-general bundle 0.2.1-rc.5; the account and agent-preset
registrations were read in their own bundles. Runtime probe: open Settings,
confirm the HK Craft row is last, the diagnostics match the shell, and entering
split view from the page closes Settings and selects the pane panel.

---

## Optional service reads through `ctx.get`

**Provider:** `@deepseek-ai/cordis` (the client context proxy and
`ReflectService`).

**Semantics:** a plugin context is a proxy. Reading a service property that the
plugin did not declare in `inject` throws
`cannot get property "<name>" without inject`; `ctx.get("<name>")` is the
supported **no-inject** read and returns `undefined` while the providing fiber
is inactive. `ctx.get(name, false)` returns an implementation regardless of its
fiber state.

**Why we rely on it:** the pane must keep working chat-only when `ui-settings` or
`ui-conversation` is absent or has not loaded, so the View adapter reads both
optional services through `ctx.get` at call time instead of adding them to
`inject`. A plain property read must not come first: its Cordis throw looks like
"service absent" and silently disables the trajectory view and its toggle. That
was the real cause of the missing pane view toggle.

**Verified:** the proxy trap and `ReflectService.get` were read in
`@deepseek-ai/cordis` 0.2.1-rc.5. The pane header now reads the gate through
`ctx.get("configForms").developerTools.enabled`. Runtime probe: open a pane with
`ui-settings.enabled: true` and confirm the 轨迹/对话 toggle appears and switches
the resident View.

---

## Related

- [`README.md`](README.md) — architecture overview.
- [`../deps/VERSIONS.md`](../deps/VERSIONS.md) — pinned dsh version.
- [`../GLOSSARY.md`](../GLOSSARY.md) — the domain vocabulary used above.
