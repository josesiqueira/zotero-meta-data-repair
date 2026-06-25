# Credits and lineage

`zotero-meta-data-repair` is a lean Zotero 7/8/9 bootstrap plugin that repairs
item metadata against authoritative sources. It reuses Zotero's own machinery
for the high-confidence path and falls back to open scholarly APIs only under a
strict confidence guard.

## Built on Zotero

- **Zotero** (<https://www.zotero.org>): the plugin reuses Zotero's own
  **translators** (`Zotero.Translate.Search`) to resolve items from identifiers
  (DOI, PMID, arXiv, ISBN), and Zotero's item-field and preferences APIs. The
  exact, high-confidence match path is Zotero's, not ours.

## Data sources (fuzzy fallback)

- **Crossref**, <https://www.crossref.org> (REST API). Used keyless by default
  via its polite pool. Set your email in the settings to identify yourself.
- **OpenAlex**, <https://openalex.org> (open catalog of scholarly works). Used
  only when you set an API key in the settings. The same email pref is used for
  its polite pool.

## Sibling project and author

- **Jose Siqueira de Cerqueira**
  ([@josesiqueira](https://github.com/josesiqueira)): author of this plugin and
  of its sibling [zotero-open-citations](../zotero-open-citations). This project
  shares that sibling's Zotero 7+ bootstrap architecture, its polite-pool and
  paced API habits (OpenAlex, Crossref), and its plain-DOM preferences pane with
  a live report.

## License

This plugin is distributed under the **Mozilla Public License 2.0** (see
[LICENSE](LICENSE)), matching the license of the sibling `zotero-open-citations`
project and of Zotero itself, for continuity across the family.
