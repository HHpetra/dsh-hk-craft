# HK-Craft (`C:\Agent\Agent10-WorkTable`) — split-screen / multi-pane report

Each **pane** is one CLI agent in a PTY; multi-conversation mode = several agent panes in a project.

## 1. Behaviour walkthrough

Left sidebar = projects, one active (`src/components/layout/AppLayout.tsx:10-18`); main area = tab strip + panel body. Each project owns an ordered `panes[]` of `explorer | agent | runner | docker`; a new project seeds explorer + agent + runner (`src/lib/panes.ts:20-31`).

Layouts are per project, whole-workspace, not per-pane splits (`src/components/layout/WorkspacePanels.tsx:143-198`): `tabs` (active visible; all mounted `absolute inset-0`, inactive `invisible` — :161-177), `row` (horizontal `Group` with draggable `Separator`s — :110-130), `grid` (two rows, `cols = ceil(n/2)`, one blank cell when odd — :12-19, :188-198).

No pane-count limit; ≈8/row is the practical cap from `minSize="12%"` (:136) `[inference]`. New pane via the `+` dropdown (explorer / runner / Docker / per-preset agents), mouse only (`src/components/layout/WorkspaceTabBar.tsx:203-268`); close via per-tab `X` on hover (:176-195), no Ctrl+W; tabs drag-reorder past a 6px threshold (:71-123, `src/lib/reorder.ts:5`).

Focus = `active_pane_id`, set by tab click or `onMouseDown` on a body (`WorkspacePanels.tsx:88-108`), shown **only** by the tab's `bg-active` (`WorkspaceTabBar.tsx:166-167`) — tiled panes get no focus ring `[inference]`. Closing the active pane picks next, else previous (`panes.ts:112-116`).

## 2. State model

Zustand, one store, no persist middleware: the TOML config *is* the state, every mutation round-trips through Rust (`src/store/workspace.ts:56-103`).

```ts
// src/types/index.ts:38-48
type WorkspacePane =
  | { id; kind: "explorer" } | { id; kind: "runner" }
  | { id; kind: "agent"; preset_id?; agent_session_id? }
  | { id; kind: "docker"; docker_container?; docker_auto_exec?; docker_exec_command? };
```

`WorkspaceLayout = "tabs" | "row" | "grid"` (:1). `Project` (:68-83) carries `layout`, `active_pane_id`, `panes[]` and per-project session fields. Persistence: `~/.hk-craft/config.toml`, one `[[projects]]` each, panes flattened (`src-tauri/src/config/mod.rs:62-111`), atomic temp+rename (:379-386). Scope is **per project**; only `active_project_id` / `resume_on_start` / `default_split_ratio` are global (`types/index.ts:13-24`). Writes are serialized against the *latest* config (`workspace.ts:452-474`), so layout edits cannot clobber concurrent session-id writes (`ai-docs/docker-bugs.md:83`). Boot spawns only the active project (`workspace.ts:416-442`).

## 3. Tabs vs panes; view switching

Tabs **are** panes: flat, no nesting, no per-pane tab set, and **no per-pane view switcher** — the view is fixed by `kind` and dispatched in `PaneBody` (`WorkspacePanels.tsx:67-86`). The nearest analogue is the explorer's global list/icon toggle (`src/components/explorer/FileExplorer.tsx:131-134`).

The tab is the pane header: `WorkspaceTabBar.tsx:164-175` renders `<Icon size={13}…/>`, `<span>{paneTitle(...)}</span>`, `{sid && <StatusDot status={status[sid]}/>}`, and applies `isActive && "bg-active text-ink"` (:166-167). `paneTitle` appends ordinals to duplicates (`panes.ts:91-110`). The layout switcher is three buttons from one array carrying `shortcut` (`WorkspaceTabBar.tsx:13-17,272-288`).

## 4. Opening history into a pane

There is **no picker, palette or `/resume` flow**. Resume is automatic: (1) each agent pane stores its own `agent_session_id` (`types/index.ts:40`); (2) on open, transcripts are discovered per `(command, cwd)` — stored ids are kept, unclaimed chats fill only *empty* panes (`src/lib/agentSessionAssign.ts:82-117`); (3) spawn appends the protocol flag (`src/lib/paneLaunch.ts:95-99` → `src/lib/agentProtocol.ts:36-41`): `--resume`, `--session`, or `resume` (`src/lib/agent-protocol.json:3-7`); (4) ids are re-captured every 2500 ms (`src/hooks/useAgentSessionCapture.ts:18-31`); (5) an unreadable resume triggers a bare respawn and a 12 s probe (`workspace.ts:259-365`).

The only user control is one global checkbox whose help text admits the limit: "终端画面不会恢复" (`src/components/settings/SettingsDialog.tsx:243-253`). Conversations are *resumed*, never opened from a list — dsh must design that flow, not port it.

## 5. Split mechanics

Drag-only resize via `react-resizable-panels@4`; `Separator` hover → accent (`WorkspacePanels.tsx:132-141`, `src/index.css:169-179`). No double-click reset, collapse, or per-pane maximize; "maximize" = switch to `tabs`. **Ratios are not persisted**: `Group` gets only `id`, not `defaultLayout`/`onLayoutChanged` (`WorkspacePanels.tsx:118,189`) which v4 needs for storage, and `default_split_ratio` has no consumer in `src/` (`types/index.ts:15`, `workspace.ts:108`) — the documented "本地记忆" (`ai-docs/agent-workbench-design.md:8`) is not implemented.

| Shortcut | Action |
| --- | --- |
| `Ctrl+1/2/3` | tabs / row / grid (`src/hooks/useHotkeys.ts:23-28`) |
| drag tab | reorder panes (`WorkspaceTabBar.tsx:71-123`) |

Non-focused panes keep streaming: output goes to a module-level xterm registry (`src/lib/termRegistry.ts:56,200-212`) buffering 256 k chars for unmounted sessions (:62-85); panes are never unmounted on switch — the host div is re-parented (`src/components/terminal/TerminalPane.tsx:43-56`). Status is global: `running → waiting` after 1.5 s silence or on exit (`usePtyStatusListener.ts:101-136`), feeding the tab `StatusDot` and sidebar badge (`ProjectSidebar.tsx:172-174`) plus a desktop notification (:48-61). **No unread badges.** Quit is blocked by a native confirm listing running sessions (`useAgentSessionCapture.ts:48-55` over `panes.ts:72-89`).

## 6. Reusable vs Tauri-specific

Reusable: (a) ordered pane array + separate `activeId` on the owner, neighbour-fallback on close; (b) three-value layout enum, not a split tree; (c) `(latest) => config` serialized writes; (d) a `paneCaps` capability table so behaviour switches on data (`src/lib/paneCaps.ts:5-47`); (e) tab = icon + label + status dot + hover close.

Tauri/Rust-bound: processes surviving UI changes (`portable-pty` in Rust, `pty-output`/`pty-exit`, kill on close — `workspace.ts:703-731`), xterm re-parenting, pre-spawn ConPTY sizing (`workspace.ts:120-133`), WebGL, IME anchoring. A browser chat UI needs none of it; it needs a per-pane subscription that survives unmount.

## 7. Noted problems / regrets

- Adding a pane kind touches ~11 files; the plan is a capability table + discriminated union because `WorkspacePane` became an optional-field bag. Explicit "do not"s: no plugin pane registry, no nested TOML migration (`ai-docs/docker-refactor.md:105,131-141,180-187`).
- `PaneLaunchPlan` is a shallow interface whose flag table callers must understand; `executePaneLaunch` (~150 store lines) is nearly untested (:25-44).
- Drift: `default_split_ratio` dead, README's font-zoom shortcut absent, design doc still on the abandoned `Ctrl+4` model (`agent-workbench-design.md:34,95`).
- Resume fragility is the recurring bug class; ids are re-validated before every spawn (`workspace.ts:263-292`), and the changelog records the fix plus a follow-up dead-terminal bug (`CHANGELOG.md:43-44`).
- Explorer panes keep navigation state in local `useState` (`FileExplorer.tsx:141-151`), lost on project switch while terminals survive `[inference]`.
