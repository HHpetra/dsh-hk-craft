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

**Why we rely on it:** `/clear` and `/resume` are pure client commands, and the
pane-aware `Ctrl+Enter` (open in a new pane) has to be observed around the
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
holding only fresh blank sessions stays gray (spec §1).

**Why we rely on it:** the sidebar lights and the strip dots are derived from
these fields only; reading an error would require opening every session's
history, which the sidebar must not do. This is why red means "waiting for you"
and not "errored" (spec §7).

**Verified:** snapshot and status shapes were read in the controller and
ui-session bundles. Runtime probe: run a turn, queue an approval, and compare
the lights.

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
`/resume` lists and which panes survive a restore. Until `phase === "ready"` the
plugin keeps every stored pane instead of pruning against an incomplete
catalog, and re-runs the prune when the catalog becomes ready.

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

**Semantics:** a workspace is "enabled" when it has a loaded pane layout in this
process or a persisted layout key from an earlier one. The controller writes the
key the first time a workspace's tree is restored or shown in split, including an
empty tree; nothing else writes it. Opening a workspace in the native view goes
through `uiWorkspace.startSession`/`openSession` and never reaches the pane
controller, so it does **not** count as enabled and must not change the gray
light. The key's existence is read without parsing the payload: a corrupt or
empty payload still proves the workspace was opened in split at some point.

**Why we rely on it:** the sidebar's gray light means "never opened in split, or
no conversation finished yet", not "no active session". The key is also the
record ticket 03 must clear when it deletes a workspace, so a removed workspace
cannot come back as an enabled gray row.

**Degradation:** an absent storage backend or a throwing store means "no key" for
that workspace only; a pane controller that cannot answer at all makes the
section treat every workspace as enabled and derive green/yellow/red/gray from
the sessions, which loses at most the never-opened gray (spec §1).

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

**Why we rely on it:** pointer drag reordering (ticket 04) only decides an
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
ships no "open right sidebar" button in this version (spec §5): it could not
open the native right bar for a split pane, and falling back to the native
conversation would silently leave the split. The group is the reserved home for
native header tools that can work inside a pane — the read-only mode badge
(ticket 07) and the subagent viewer (ticket 08) — and any future native tool
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
to be two `sidebar.footer.action` buttons; ticket 05 moves them into one
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
