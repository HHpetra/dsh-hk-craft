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
unregistration reset were read in the ui-layout bundle. Runtime probe: toggle
the footer action and confirm the native conversation unmounts.

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
`binding.activate(viewId)` switches the resident conversation View (e.g.
`"chat"`, `"trajectory"`) without rebuilding the session, so the draft and the
native scroll behaviour are untouched. dsh's own View switcher calls the same
method and then persists its preference; this plugin keeps the choice in the
layout tree instead, so no dsh store is written.

**Why we rely on it:** the pane's `对话 | 轨迹` control is a per-pane memory.
It must drive the real View through the public binding rather than mount a
second copy of the conversation.

**Verified:** binding and activate were read in ui-conversation. Runtime probe:
switch one pane to trajectory and back; the other pane is unaffected.

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
trajectory segment is not rendered (and a remembered trajectory choice reads
as chat); when the gate flips back on, the remembered choice is re-asserted.

**Verified:** the gate read and the "skip the View entirely" branch were read
in ui-conversation and ui-settings. Runtime probe: turn developer tools off and
confirm the segment disappears from every pane.

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
summary field.

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

## Related

- [`README.md`](README.md) — architecture overview.
- [`../deps/VERSIONS.md`](../deps/VERSIONS.md) — pinned dsh version.
- [`../GLOSSARY.md`](../GLOSSARY.md) — the domain vocabulary used above.
