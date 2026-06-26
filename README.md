# Zotero Metadata Repair

A modern **Zotero 7, 8, and 9** plugin that finds items with thin or missing
metadata and repairs them from authoritative sources, one reviewable diff at a
time. It reuses Zotero's own translators for exact identifier matches and falls
back to a guarded fuzzy search only when it is confident. Nothing is written
without your approval, and an existing field is never blanked.

> Lineage: this is a sibling of
> [zotero-open-citations](../zotero-open-citations) by the same author. It
> shares that project's lean Zotero 7+ bootstrap architecture, its paced and
> polite-pool API habits (OpenAlex and Crossref), and its plain-DOM
> preferences pane with a live report. Full attribution in [CREDITS.md](CREDITS.md).

## The 7 core fields

The plugin scores and repairs exactly these fields, in this order:

1. **Item type**
2. **Authors** (creators)
3. **Date**
4. **Publication / container title** (journal, proceedings, or book title)
5. **Publisher** (or institution / university for reports and theses)
6. **Place**
7. **DOI**

Each field is judged per item type. A field that does not apply to a type (for
example a DOI on a book chapter) is never counted against it.

## Install

This is a build-free bootstrap plugin. Download the `.xpi` from
**Releases**, then in Zotero: **Tools -> Plugins** (or Add-ons) -> the gear
icon -> **Install Plugin From File** -> pick the `.xpi`. Works on Zotero
**7, 8, and 9**.

## Usage

1. Select one or more items, right-click, and choose **"Repair metadata…"**.
2. For a **single item the review window always opens**, even when nothing would
   change. It shows your current value on the left and what was found on the
   right for every core field, so you can see exactly what is being proposed.
3. **Approve each row** you want, or use **Approve all changed**, then **Apply**.
4. Empty fields are pre-checked (safe fills). A row that would **overwrite** an
   existing value is shown in amber and is **not** pre-checked: you must also
   tick its "allow overwrite" box for it to apply.
5. When **nothing is found**, the window stays open and shows a clear reason
   (for example no confident match, already up to date, no title to search with,
   or the lookup service was unavailable), so you are never left guessing.

Nothing is overwritten unless you explicitly allow it, and the plugin **never
blanks a field**.

## The report

**Settings -> Metadata Repair** opens a dedicated pane with a live
**completeness report**: an overall completeness percentage across your library,
a per-field table (how many items are missing each of the 7 core fields), a
per-item-type completeness breakdown, and a "needs attention" list of the worst
offenders. A **Refresh report** button re-scans, and a **Repair worst
offenders** button runs the repair flow over the flagged items. The same pane
holds the two optional settings (OpenAlex key and contact email).

## How matching works

1. **DOI first.** If the item has an identifier (DOI, PMID, arXiv, or ISBN, in
   that priority), the plugin captures a record through **Zotero's own
   translators**. This is the exact, high-confidence path. If the identifier
   lookup fails, there is **no** fuzzy fallback for that item.
2. **Guarded fuzzy fallback.** With no identifier, the plugin searches by title
   and **refuses low-confidence matches**: it accepts only when title
   similarity is at least 0.90 and either the first author's surname matches or
   the year is within one. Otherwise it reports no match and proposes nothing.

The fuzzy search uses **Crossref** with no key by default (its keyless polite
pool). **OpenAlex** is used only when you set a free API key in the settings.
Setting a contact email identifies you to both polite pools and makes them
faster and more reliable.

## Safety

- **Fill-empty by default.** Empty fields are pre-checked; overwrites require an
  explicit per-field opt-in.
- **Never blanks.** A blank or missing source value never produces a change and
  never clears your data.
- **Undoable.** Every apply is a single `saveTx`, so you can undo it with
  Ctrl+Z.

## Compatibility

Zotero **7, 8, and 9** (`strict_min_version` 6.999, `strict_max_version` 9.*).
Bootstrapped plugin, no XUL overlay.

## License

[Mozilla Public License 2.0](LICENSE). See [CREDITS.md](CREDITS.md).
