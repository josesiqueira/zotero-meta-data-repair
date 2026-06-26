# CLAUDE.md: zotero-meta-data-repair

Architecture notes for future sessions. Lean plain JS, no framework, no build
step. Sibling of `../zotero-open-citations` (same author, same bootstrap style).

## Identity

- Plugin id: `meta-data-repair@zotero-plugin.org`
- Namespace: `ZMR`; public global published by `init()` = `Zotero.MetaDataRepair`
- Prefs branch: `metadatarepair.` (pass the SHORT branch to `Zotero.Prefs.get/set`;
  it auto-roots under `extensions.zotero.`)
- Display name "Zotero Metadata Repair"; version 0.1.1; Zotero 7/8/9
  (`strict_min_version` 6.999, `strict_max_version` 9.*)
- Chrome registered in `init`: `chrome://metadatarepair/content/` ->
  `rootURI + "content/"` (for the diff dialog).

## File tree

```
manifest.json            # id, versions, prefs pane registration metadata
bootstrap.js             # lifecycle; loadSubScript of the lib/ files in order
lib/core-fields.js       # FIRST: consts, shared helpers, coreFields, report
lib/resolver.js          # buildProposal / buildProposalsForItems / mapping
lib/writer.js            # applyApproved
lib/ui-menu.js           # LAST: init/addToWindow/.../runRepair + test hooks
content/diff-dialog.xhtml + diff-dialog.js   # chrome-registered modal dialog
prefs.xhtml + prefs.js   # preferences pane (settings + live report)
icons/repair.svg
README.md  CREDITS.md  LICENSE  CONTRACTS.md
```

### Single shared scope (load order is LOAD-BEARING)

`bootstrap.js` `loadSubScript`s the four lib files into ONE shared scope in this
order: `core-fields.js` -> `resolver.js` -> `writer.js` -> `ui-menu.js`.

- `core-fields.js` is first and does
  `var ZMR = (typeof ZMR !== "undefined" && ZMR) || {};` then defines consts,
  shared helpers, `ZMR.coreFields`, `ZMR.report`.
- Files 2 to 4 only assign onto `ZMR` (e.g. `ZMR.resolver = {...}`). They must
  NOT re-declare `var ZMR = {}` (that would clobber the shared object).
- `ui-menu.js` last; its `init()` publishes `Zotero.MetaDataRepair = ZMR`.

Shared helpers in core-fields.js: `log`, `getPref`, `setPref`, `notify`
(ProgressWindow toast), `mainWindow`, `cleanDOI`, `norm`, `sleep`, `jitter`.

## The 7 core fields

`ZMR.CORE_FIELD_KEYS = ["itemType","creators","date","container","publisher","place","doi"]`

- `container` is virtual: publicationTitle (journalArticle) / proceedingsTitle
  (conferencePaper) / bookTitle (bookSection); null for book/report/thesis.
- `publisher` maps to publisher (book/bookSection) / institution (report) /
  university (thesis).
- `doi` key is lowercase; the Zotero field is "DOI".
- `itemType` + `creators` are structural (not getField values).
- Policy per type: expected (counts + flagged) / optional (repairable, never
  flagged) / na (skipped). Always probe
  `Zotero.ItemFields.isValidForType(...)` before treating a field applicable.

## Frozen shapes (lived in CONTRACTS.md during build)

- **Proposal**: object-keyed `fields` where each key has
  `{current, proposed, changed:true, willFill}`. A key appears only when the
  source supplied a non-empty value that differs from current. Plus
  `itemKey, libraryID, itemType, matched, source, confidence`.
- **Report** (`ZMR.report.getReport`): `totalItems`, `completeness` (0..100),
  `byField` (all 7 keys: `{label, applicable, missing, missingPct}`),
  `byItemType` (`{label, count, completeness, missingByField}`), `worst`
  (`{itemKey, libraryID, itemType, title, missing:[key...], missingCount}`).
  Single read-only pass over the current library's regular items; no network.
- **Decision / dialog out**: `{approved, fieldsToApply:[key], overwriteNonEmpty:{key:bool}, batchAction?}`.

## v0.1.1 (review window fix)

Additive changes only; the writer and Report shapes are unchanged.

- **Always-open review window.** The single-item path ALWAYS opens the diff
  dialog, even when there are zero proposed changes. The old "No repairs
  proposed." toast is gone from the single path; a toast now only appears as a
  post-apply confirmation ("Updated N field(s)."). Batch is unchanged: it opens
  a window per item that has changes and accumulates a summary toast for items
  with none.
- **Proposal gains `reason` + `sourceFields`** (both additive). `reason` is
  `null` when `fields` is non-empty (there are changes to show); otherwise it
  carries a code so the dialog can explain why nothing was proposed.
  `sourceFields` is the `mapRecordToCoreFields(...)` output when a record was
  matched (lets the dialog tell "(same)" from "(not found)"), or `null` when
  `matched:false`.
- **Reason taxonomy** (resolver emits the code; the dialog owns the wording):
  `complete` (matched but had nothing this item is missing), `no_title` (no
  identifier and no title to search with), `no_match` (searched but no confident
  match / identifier did not resolve), `rate_limited` (deferred or a
  rate-limit/network error), `unsupported_type` (not a regular item or no
  applicable core fields), `error` (any other thrown error).
- **Overwrite gate.** A single header checkbox `#zmr-overwrite-toggle` (off by
  default) keeps every overwrite-row checkbox disabled until the user opts in.
  Fill-empty rows stay pre-checked; overwrite rows stay individually unchecked
  even after the gate is on. The writer still never blanks (`blanked` always
  `[]`).

## Design and safety invariants

- **DOI-first.** Identifier present (DOI > PMID > arXiv > ISBN) => Zotero
  translator path only; on its failure, NO fuzzy fallback for that item.
- **Guarded fuzzy.** No identifier => Crossref (keyless polite pool) and, only
  if `openAlexKey` is set, OpenAlex. Accept only when titleSimilarity >= 0.90
  (titleFloor) AND (first-author surname match OR year within 1). Else
  `matched:false`, no fields.
- **No-blank / fill-empty default.** Empty fields are safe fills (pre-checked);
  overwriting a non-empty field needs an explicit per-field opt-in. The writer's
  `blanked` array is ALWAYS `[]`. itemType is opt-in only; creators are
  all-or-nothing.
- **Undoable.** One `item.saveTx({skipDateModifiedUpdate:true})` per item; skip
  if nothing changed. Idempotent: re-apply yields `changed:[]`.

## UI

- **Diff dialog**: chrome-registered modal opened with
  `win.openDialog("chrome://metadatarepair/content/diff-dialog.xhtml", "zmr-diff", "chrome,dialog,modal,centerscreen,resizable", io)`.
  Input `window.arguments[0] = {proposal, itemDisplayTitle, out, batch?}`;
  output mutates `io.out`. `modal` blocks, so orchestration reads `io.out`
  synchronously after it returns.
- **Menu**: context item "Repair metadata…". Z8/9 use
  `Zotero.MenuManager.registerMenu` (registered ONCE, flag `_menuRegisteredID`,
  unregistered in shutdown). Z7 (feature-detect
  `typeof Zotero.MenuManager?.registerMenu`) DOM-injects a `<menuitem>` into
  `#zotero-itemmenu` per window.
- **Prefs pane**: registered in `init` via
  `Zotero.PreferencePanes.register({pluginID, src:"prefs.xhtml", scripts:["prefs.js"], label:"Metadata Repair", image:"icons/repair.svg"})`.
  `prefs.js` self-boots by polling for `#zmr-report` (inline onload is
  unreliable in prefs panes), then loads the two settings values and renders the
  report.

## Public API surface (published by init)

```
Zotero.MetaDataRepair = {
  init, addToWindow, removeFromWindow, shutdown, runRepair,   // ui-menu
  resolver: { buildProposal, buildProposalsForItems },
  writer:   { applyApproved },
  report:   { getReport },
  coreFields,
  getPref, setPref,
  test: { ... }
};
```

## Test hooks (Zotero.MetaDataRepair.test)

Always present, UI-free except `openDiffDialog`:

- `test.version()`
- `test.coreFieldsFor(itemType)` -> String[]
- `test.findSampleItems({missingField?, withDoi?, limit?=6})` (read-only, cap 10)
- `test.buildProposal(itemKey)` (no UI, no writes)
- `test.getReport()`
- `test.applyApproved(itemKey, proposal, decision)`
- `test.openDiffDialog(itemKey, proposal?)`

Runbook invariants: `buildProposal` side-effect free; `applyApproved` writes are
a subset of approved-changed, never blanks (`blanked` always `[]`), idempotent
on re-run.

## Build / package

Build-free. Zip the root into the `.xpi` with `manifest.json` at the archive
root:

```
cd zotero-meta-data-repair
zip -r -X ../zotero-meta-data-repair.xpi manifest.json bootstrap.js lib content prefs.xhtml prefs.js icons README.md CREDITS.md LICENSE
```

Then in Zotero: Tools -> Plugins -> gear -> Install Plugin From File.
