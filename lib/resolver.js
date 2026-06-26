/* Zotero Metadata Repair - resolver
 *
 * Loads SECOND, AFTER lib/core-fields.js, into the shared bootstrap scope.
 * `ZMR` already exists (created by core-fields.js) with the shared helpers
 * ZMR.httpJson / isRateLimit / norm / cleanDOI / sleep / jitter / getPref /
 * log / notify and ZMR.coreFields.{containerFieldFor,zoteroFieldFor,...}.
 * We ONLY assign `ZMR.resolver` here; we never re-declare `var ZMR`.
 *
 * Responsibility: turn a Zotero item into a Proposal (CONTRACTS.md shape) by
 *   1. identifier-first lookup via Zotero's translators (DOI>PMID>arXiv>ISBN),
 *   2. a guarded fuzzy fallback (Crossref keyless polite pool, OpenAlex if a key
 *      pref is set) ONLY when the item carries no identifier,
 *   3. a strict accept gate, then a pure field-mapping + diff against the item.
 *
 * Invariants (mirrored from CONTRACTS.md):
 *   - A field appears in a Proposal ONLY if the source gave a non-empty value
 *     AND it differs from the current value. Null/blank never blanks user data.
 *   - Identifier present => identifier path only; on its failure NO fuzzy fallback.
 *   - Fuzzy accept requires titleSimilarity >= titleFloor AND (author OR year±tol).
 *
 * Fetch + title-match patterns mirror ../zotero-open-citations/lib/open-citations.js.
 */

ZMR.resolver = (function () {
  // ---- prefs / small helpers --------------------------------------------
  function email() { return (ZMR.getPref("email") || "").trim(); }
  function version() {
    try { return ZMR.VERSION || ZMR.getPref("version") || "0.1.0"; }
    catch (e) { return "0.1.0"; }
  }
  function userAgent() {
    const m = email();
    return "ZoteroMetaDataRepair/" + version() + (m ? " (mailto:" + m + ")" : "");
  }
  function num(pref, dflt) {
    const v = Number(ZMR.getPref(pref));
    return isFinite(v) ? v : dflt;
  }

  // ---- CSL / container type maps ----------------------------------------
  const CSL_TYPE_MAP = {
    "journal-article": "journalArticle",
    "book-chapter": "bookSection",
    "proceedings-article": "conferencePaper",
    "book": "book",
    "monograph": "book",
    "report": "report",
    "dissertation": "thesis",
    "posted-content": null,
    "unknown": null,
  };

  /**
   * Map a CSL/Crossref type string to a Zotero item type, or null if unknown.
   * @param {String} cslType
   * @returns {String|null}
   */
  function cslTypeToZotero(cslType) {
    if (!cslType) return null;
    const key = String(cslType).toLowerCase().trim();
    return Object.prototype.hasOwnProperty.call(CSL_TYPE_MAP, key)
      ? CSL_TYPE_MAP[key]
      : null;
  }

  /**
   * The Zotero field that holds the "container" for an item type.
   * Delegates to core-fields when available.
   * @param {String} itemType
   * @returns {String|null}
   */
  function containerFieldFor(itemType) {
    if (ZMR.coreFields && typeof ZMR.coreFields.containerFieldFor === "function") {
      try { return ZMR.coreFields.containerFieldFor(itemType); } catch (e) { /* fall through */ }
    }
    if (itemType === "journalArticle") return "publicationTitle";
    if (itemType === "conferencePaper") return "proceedingsTitle";
    if (itemType === "bookSection") return "bookTitle";
    return null;
  }

  function publisherFieldFor(itemType) {
    if (ZMR.coreFields && typeof ZMR.coreFields.publisherFieldFor === "function") {
      try { return ZMR.coreFields.publisherFieldFor(itemType); } catch (e) { /* fall through */ }
    }
    if (itemType === "report") return "institution";
    if (itemType === "thesis") return "university";
    if (itemType === "book" || itemType === "bookSection") return "publisher";
    return null;
  }

  // ---- DOI normalization (ZMR.cleanDOI is item-shaped) -------------------
  function normDOI(s) {
    if (!s) return null;
    const d = String(s).trim()
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi:\s*/i, "")
      .trim();
    return d || null;
  }

  // ---- field validity guard ---------------------------------------------
  function isValidField(item, fieldName) {
    if (!fieldName) return false;
    try {
      const id = Zotero.ItemFields.getID(fieldName);
      if (!id) return false;
      return Zotero.ItemFields.isValidForType(id, item.itemTypeID);
    } catch (e) { return false; }
  }

  function getFieldSafe(item, fieldName) {
    if (!fieldName) return "";
    try { return item.getField(fieldName) || ""; } catch (e) { return ""; }
  }

  // =======================================================================
  // 1. IDENTIFIER COLLECTION
  // =======================================================================
  /**
   * Pull identifiers from the item, field-by-field. extractIdentifiers only
   * returns the FIRST identifier TYPE it finds in a blob, so we run it on the
   * `extra` text AND on dedicated fields SEPARATELY and merge by priority.
   * @param {Object} item Zotero item
   * @returns {{DOI?:String,PMID?:String,arXiv?:String,ISBN?:String}}
   */
  function collectIdentifiers(item) {
    const ids = {};

    // DOI: prefer the item's clean DOI (handles DOI field + extra).
    let doi = null;
    try { doi = ZMR.cleanDOI(item) || null; } catch (e) { doi = null; }
    if (doi) ids.DOI = normDOI(doi);

    const extract = (text) => {
      if (!text) return null;
      try {
        const found = Zotero.Utilities.extractIdentifiers(String(text));
        return (found && found.length) ? found[0] : null;
      } catch (e) { return null; }
    };

    // Merge a single extractIdentifiers result into ids (don't clobber existing).
    const merge = (res) => {
      if (!res) return;
      if (res.DOI && !ids.DOI) ids.DOI = normDOI(res.DOI);
      if (res.PMID && !ids.PMID) ids.PMID = String(res.PMID).trim();
      if (res.arXiv && !ids.arXiv) ids.arXiv = String(res.arXiv).trim();
      if (res.ISBN && !ids.ISBN) ids.ISBN = String(res.ISBN).trim();
    };

    // The 'extra' field can carry PMID:/arXiv: lines.
    merge(extract(getFieldSafe(item, "extra")));

    // Dedicated fields, each probed independently so we don't lose a type.
    if (!ids.ISBN) merge(extract(getFieldSafe(item, "ISBN")));
    if (!ids.DOI) merge(extract(getFieldSafe(item, "DOI")));

    return ids;
  }

  /** Highest-priority identifier as a single-key object for setIdentifier. */
  function pickIdentifier(ids) {
    if (!ids) return null;
    if (ids.DOI) return { DOI: ids.DOI };
    if (ids.PMID) return { PMID: ids.PMID };
    if (ids.arXiv) return { arXiv: ids.arXiv };
    if (ids.ISBN) return { ISBN: ids.ISBN };
    return null;
  }

  function hasIdentifier(ids) { return !!pickIdentifier(ids); }

  // =======================================================================
  // RECORD SHAPE (internal): { type, title, DOI, authors:[{family,given}],
  //                            year, month, day, container, publisher, place }
  // =======================================================================
  function emptyRecord() {
    return {
      type: null, title: null, DOI: null, authors: [],
      year: null, month: null, day: null,
      container: null, publisher: null, place: null,
    };
  }

  // ---- normalize a translator (Zotero item-data) result -----------------
  function normalizeFromTranslator(raw) {
    if (!raw) return null;
    const rec = emptyRecord();

    rec.type = raw.itemType || null; // already a Zotero item type
    rec.title = raw.title || null;
    rec.DOI = normDOI(raw.DOI);

    if (Array.isArray(raw.creators)) {
      for (const c of raw.creators) {
        if (!c) continue;
        const family = c.lastName || c.name || "";
        const given = c.firstName || "";
        const ctype = c.creatorType || "author";
        if (family) rec.authors.push({ family: family, given: given, creatorType: ctype });
      }
    }

    // date: translators give a free-form `date`; parse to Y/M/D.
    if (raw.date) {
      try {
        const d = Zotero.Date.strToDate(String(raw.date));
        if (d) {
          if (isFinite(d.year)) rec.year = d.year;
          if (isFinite(d.month)) rec.month = d.month + 1; // strToDate month is 0-based
          if (isFinite(d.day)) rec.day = d.day;
        }
      } catch (e) { /* leave date parts null */ }
    }

    rec.container = raw.publicationTitle || raw.proceedingsTitle ||
      raw.bookTitle || raw.conferenceName || raw.series || null;
    rec.publisher = raw.publisher || raw.institution || raw.university || null;
    rec.place = raw.place || null;

    if (!rec.title && !rec.DOI && !rec.authors.length) return null;
    return rec;
  }

  // ---- normalize a Crossref `message.items[i]` --------------------------
  function crossrefItemToRecord(it) {
    if (!it) return null;
    const rec = emptyRecord();

    rec.type = it.type || null; // CSL type; mapped later
    rec.title = Array.isArray(it.title) ? (it.title[0] || null) : (it.title || null);
    rec.DOI = normDOI(it.DOI);

    if (Array.isArray(it.author)) {
      for (const a of it.author) {
        if (!a) continue;
        const family = a.family || a.name || "";
        const given = a.given || "";
        if (family) rec.authors.push({ family: family, given: given, creatorType: "author" });
      }
    }

    const issued = it.issued && it.issued["date-parts"] && it.issued["date-parts"][0];
    if (Array.isArray(issued)) {
      if (isFinite(issued[0])) rec.year = Number(issued[0]);
      if (isFinite(issued[1])) rec.month = Number(issued[1]);
      if (isFinite(issued[2])) rec.day = Number(issued[2]);
    }

    rec.container = Array.isArray(it["container-title"])
      ? (it["container-title"][0] || null)
      : (it["container-title"] || null);
    rec.publisher = it.publisher || null;
    rec.place = it["publisher-location"] || null;

    return rec;
  }

  // ---- normalize an OpenAlex work --------------------------------------
  function openAlexItemToRecord(w) {
    if (!w) return null;
    const rec = emptyRecord();

    rec.type = w.type || null; // OpenAlex type ~ CSL-ish; mapped later
    rec.title = w.display_name || w.title || null;
    rec.DOI = normDOI(w.doi);

    if (Array.isArray(w.authorships)) {
      for (const au of w.authorships) {
        const name = au && au.author && au.author.display_name;
        if (!name) continue;
        const parts = String(name).trim().split(/\s+/);
        const family = parts.length > 1 ? parts[parts.length - 1] : parts[0];
        const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
        if (family) rec.authors.push({ family: family, given: given, creatorType: "author" });
      }
    }

    if (isFinite(w.publication_year)) rec.year = Number(w.publication_year);
    if (w.publication_date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(w.publication_date));
      if (m) { rec.month = Number(m[2]); rec.day = Number(m[3]); }
    }

    const src = w.primary_location && w.primary_location.source;
    rec.container = (src && src.display_name) || null;
    rec.publisher = (src && src.host_organization_name) || null;
    rec.place = null;

    return rec;
  }

  // =======================================================================
  // 2. IDENTIFIER LOOKUP (translators)
  // =======================================================================
  /**
   * Resolve an item via Zotero's translators using its highest-priority
   * identifier. translate({libraryID:false}) NEVER persists. Returns a Record
   * or null. Any failure => null (NO fuzzy fallback when an identifier existed).
   */
  async function resolveByIdentifier(item, ids) {
    const ident = pickIdentifier(ids);
    if (!ident) return null;
    try {
      const t = new Zotero.Translate.Search();
      t.setIdentifier(ident);
      let captured = null;
      t.setHandler("itemDone", (o, it) => { if (!captured) captured = it; });
      const trs = await t.getTranslators();
      if (!trs || !trs.length) return null;
      t.setTranslator(trs);
      const items = await t.translate({ libraryID: false, saveAttachments: false });
      const raw = captured || (items && items[0]);
      return normalizeFromTranslator(raw);
    } catch (e) {
      ZMR.log("resolveByIdentifier failed for " + item.key + ": " + e);
      return null;
    }
  }

  // =======================================================================
  // 3. FUZZY QUERY (Crossref keyless polite pool, then OpenAlex if key)
  // =======================================================================
  function firstCreatorSurname(item) {
    try {
      const cs = item.getCreators();
      if (cs && cs.length) return (cs[0].lastName || cs[0].name || "").trim();
    } catch (e) { /* none */ }
    return "";
  }

  function itemYear(item) {
    try {
      const raw = item.getField("date", false, true) || item.getField("date") || "";
      if (!raw) return null;
      const d = Zotero.Date.strToDate(String(raw));
      return (d && isFinite(d.year)) ? d.year : null;
    } catch (e) { return null; }
  }

  /**
   * Run Crossref then (optionally) OpenAlex, scoring each candidate; return the
   * first accepted {record, source, confidence} or null. ONLY call when the
   * item has no identifier. `skip` is a Set of sources to bypass (429 suppress).
   */
  async function resolveByQuery(item, skip) {
    const title = getFieldSafe(item, "title");
    if (!title) return null;
    const author = firstCreatorSurname(item);

    // --- Crossref ---
    if (!skip || !skip.has("crossref-search")) {
      try {
        const cands = await crossrefSearch(title, author);
        const hit = pickAccepted(item, cands, "crossref-search");
        if (hit) return hit;
      } catch (e) {
        if (ZMR.isRateLimit(e)) { if (skip) skip.add("crossref-search"); throw e; }
        ZMR.log("crossref search error: " + e);
      }
    }

    // --- OpenAlex (only if a key pref is set) ---
    const oaKey = (ZMR.getPref("openAlexKey") || "").trim();
    if (oaKey && (!skip || !skip.has("openalex"))) {
      try {
        const cands = await openAlexSearch(title, oaKey);
        const hit = pickAccepted(item, cands, "openalex");
        if (hit) return hit;
      } catch (e) {
        if (ZMR.isRateLimit(e)) { if (skip) skip.add("openalex"); throw e; }
        ZMR.log("openalex search error: " + e);
      }
    }

    return null;
  }

  async function crossrefSearch(title, author) {
    let url = "https://api.crossref.org/works?rows=5" +
      "&query.bibliographic=" + encodeURIComponent(title);
    if (author) url += "&query.author=" + encodeURIComponent(author);
    url += "&select=" + encodeURIComponent(
      "DOI,title,author,issued,container-title,publisher,publisher-location,type");
    const m = email();
    if (m) url += "&mailto=" + encodeURIComponent(m);

    const data = await ZMR.httpJson(url, { "User-Agent": userAgent() });
    const items = data && data.message && data.message.items;
    if (!Array.isArray(items)) return [];
    return items.map(crossrefItemToRecord).filter(Boolean);
  }

  async function openAlexSearch(title, key) {
    let url = "https://api.openalex.org/works?per_page=5" +
      "&search=" + encodeURIComponent(title) +
      "&api_key=" + encodeURIComponent(key);
    const m = email();
    if (m) url += "&mailto=" + encodeURIComponent(m);

    const data = await ZMR.httpJson(url);
    const results = data && data.results;
    if (!Array.isArray(results)) return [];
    return results.map(openAlexItemToRecord).filter(Boolean);
  }

  function pickAccepted(item, cands, source) {
    for (const rec of cands) {
      const acc = accept(item, rec);
      if (acc.ok) return { record: rec, source: source, confidence: acc.confidence };
    }
    return null;
  }

  // =======================================================================
  // 4. SCORING (strict)
  // =======================================================================
  /** 1.0 if normalized-equal else Jaccard over word sets. */
  function titleSimilarity(a, b) {
    const na = ZMR.norm(a || "");
    const nb = ZMR.norm(b || "");
    if (!na || !nb) return 0;
    if (na === nb) return 1.0;
    const A = new Set(na.split(" "));
    const B = new Set(nb.split(" "));
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const denom = A.size + B.size - inter;
    return denom > 0 ? inter / denom : 0;
  }

  /**
   * Strict accept gate. Returns {ok, confidence}.
   * ts >= titleFloor AND (firstAuthorSurname in cand authors OR |yΔ| <= tol).
   */
  function accept(item, rec) {
    const floor = num("titleFloor", 0.90);
    const tol = num("yearTolerance", 1);
    const ts = titleSimilarity(getFieldSafe(item, "title"), rec.title);
    if (ts < floor) return { ok: false, confidence: 0 };

    const surname = firstCreatorSurname(item).toLowerCase();
    const authorOK = !!surname && rec.authors.some(
      (a) => (a.family || "").toLowerCase() === surname);

    const yi = itemYear(item);
    const yOK = (yi != null && rec.year != null)
      ? Math.abs(yi - rec.year) <= tol : false;

    if (!authorOK && !yOK) return { ok: false, confidence: 0 };

    const confidence = Math.min(1, ts * (1 + 0.05 * authorOK + 0.05 * yOK));
    return { ok: true, confidence: confidence };
  }

  // =======================================================================
  // 5. PURE MAPPING: Record -> MappedFields
  // =======================================================================
  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function recordDateString(rec) {
    if (rec.year == null || !isFinite(rec.year)) return null;
    let s = String(rec.year);
    if (rec.month != null && isFinite(rec.month) && rec.month >= 1 && rec.month <= 12) {
      s += "-" + pad2(rec.month);
      if (rec.day != null && isFinite(rec.day) && rec.day >= 1 && rec.day <= 31) {
        s += "-" + pad2(rec.day);
      }
    }
    return s;
  }

  /**
   * PURE: project a Record onto the core fields for a given item type.
   * Never emits "" where the source had nothing -> use null instead.
   * @param {Object} record internal Record
   * @param {String} itemType the (target) Zotero item type
   * @returns {{itemType:String,creators:Array|null,date:String|null,
   *            container:String|null,publisher:String|null,place:String|null,
   *            doi:String|null}}
   */
  function mapRecordToCoreFields(record, itemType) {
    const out = {
      itemType: itemType || (record && record.type) || null,
      creators: null,
      date: null,
      container: null,
      publisher: null,
      place: null,
      doi: null,
    };
    if (!record) return out;

    // creators: drop empty-surname entries; null if none.
    if (Array.isArray(record.authors) && record.authors.length) {
      const creators = [];
      for (const a of record.authors) {
        const lastName = (a.family || "").trim();
        if (!lastName) continue;
        const ct = (a.creatorType === "editor") ? "editor" : "author";
        creators.push({
          firstName: (a.given || "").trim(),
          lastName: lastName,
          creatorType: ct,
        });
      }
      out.creators = creators.length ? creators : null;
    }

    const ds = recordDateString(record);
    out.date = ds || null;

    out.container = (record.container && String(record.container).trim()) || null;
    out.publisher = (record.publisher && String(record.publisher).trim()) || null;
    out.place = (record.place && String(record.place).trim()) || null;
    out.doi = normDOI(record.DOI);

    return out;
  }

  // =======================================================================
  // 6. DIFF: item + MappedFields -> Proposal.fields
  // =======================================================================
  function isBlank(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim() === "";
  }

  function trimLower(v) { return String(v == null ? "" : v).trim().toLowerCase(); }

  function canonDate(s) {
    if (!s) return "";
    try {
      const d = Zotero.Date.strToDate(String(s));
      if (!d || !isFinite(d.year)) return String(s).trim();
      let out = String(d.year);
      if (isFinite(d.month)) out += "-" + pad2(d.month + 1); // 0-based
      if (isFinite(d.day)) out += "-" + pad2(d.day);
      return out;
    } catch (e) { return String(s).trim(); }
  }

  function creatorsSig(arr) {
    if (!Array.isArray(arr)) return "";
    return arr.map((c) => trimLower(c.lastName || c.name || "") + "|" +
      trimLower(c.firstName || "") + "|" +
      trimLower(c.creatorType || "author")).join(";");
  }

  function readCurrentCreators(item) {
    try {
      const cs = item.getCreators() || [];
      return cs.map((c) => {
        let ct = "author";
        try { ct = Zotero.CreatorTypes.getName(c.creatorTypeID) || "author"; }
        catch (e) { /* default */ }
        return {
          firstName: c.firstName || "",
          lastName: c.lastName || c.name || "",
          creatorType: ct,
        };
      });
    } catch (e) { return []; }
  }

  function readCurrentScalar(item, fieldKey, itemType) {
    if (fieldKey === "doi") {
      try { return ZMR.cleanDOI(item) || ""; } catch (e) { return ""; }
    }
    let zf = null;
    if (ZMR.coreFields && typeof ZMR.coreFields.zoteroFieldFor === "function") {
      try { zf = ZMR.coreFields.zoteroFieldFor(fieldKey, item); } catch (e) { zf = null; }
    }
    if (!zf) {
      if (fieldKey === "date") zf = "date";
      else if (fieldKey === "place") zf = "place";
      else if (fieldKey === "container") zf = containerFieldFor(itemType);
      else if (fieldKey === "publisher") zf = publisherFieldFor(itemType);
    }
    if (!zf) return "";
    return getFieldSafe(item, zf);
  }

  function equalValue(fieldKey, current, proposed) {
    if (fieldKey === "creators") {
      return creatorsSig(current) === creatorsSig(proposed);
    }
    if (fieldKey === "date") {
      return canonDate(current) === canonDate(proposed);
    }
    if (fieldKey === "doi") {
      return trimLower(normDOI(current) || "") === trimLower(normDOI(proposed) || "");
    }
    return trimLower(current) === trimLower(proposed);
  }

  /**
   * Build the Proposal.fields object by diffing the item against MappedFields.
   * RULE1 skip if proposed null/""/[]. RULE2 skip if equalValue. RULE3 emit
   * {current, proposed, changed:true, willFill:isBlank(current)}.
   */
  function diffFields(item, mapped) {
    const fields = {};
    const itemType = mapped.itemType || item.itemType;

    // The diffable core keys (itemType handled by the writer, not diffed here).
    const keys = ["creators", "date", "container", "publisher", "place", "doi"];

    for (const key of keys) {
      const proposed = mapped[key];

      // RULE1: nothing to propose.
      if (isBlank(proposed)) continue;

      // For type-specific container/publisher, only propose if the target type
      // actually has a slot for it.
      if (key === "container" && !containerFieldFor(itemType)) continue;
      if (key === "publisher" && !publisherFieldFor(itemType)) continue;

      let current;
      if (key === "creators") current = readCurrentCreators(item);
      else current = readCurrentScalar(item, key, itemType);

      // RULE2: unchanged.
      if (equalValue(key, current, proposed)) continue;

      // RULE3: emit.
      fields[key] = {
        current: current,
        proposed: proposed,
        changed: true,
        willFill: isBlank(current),
      };
    }

    return fields;
  }

  // =======================================================================
  // 7. buildProposal
  // =======================================================================
  function baseProposal(item) {
    return {
      itemKey: item.key,
      libraryID: item.libraryID,
      itemType: item.itemType,
      matched: false,
      source: null,
      confidence: 0,
      fields: {},
      reason: null,
      sourceFields: null,
    };
  }

  /**
   * Resolve one item into a Proposal (CONTRACTS.md shape). Side-effect free.
   * `skip` (optional Set) suppresses fuzzy sources that already 429'd this run.
   * @param {Object} item Zotero item
   * @param {Set<String>} [skip]
   * @returns {Promise<Object>} Proposal
   */
  async function buildProposal(item, skip) {
    const proposal = baseProposal(item);

    // Only regular items are repairable.
    let regular = false;
    try { regular = item.isRegularItem(); } catch (e) { regular = false; }
    if (!regular) {
      proposal.error = "not a regular item";
      proposal.reason = "unsupported_type";
      return proposal;
    }

    let record = null;
    let source = null;
    let confidence = 0;
    let didLookup = false; // true once we ran an identifier OR a query lookup

    try {
      const ids = collectIdentifiers(item);
      if (hasIdentifier(ids)) {
        // Identifier path ONLY. On failure: matched:false, NO fuzzy fallback.
        didLookup = true;
        record = await resolveByIdentifier(item, ids);
        if (record) {
          source = "translator";
          confidence = 1.0;
        }
      } else if (getFieldSafe(item, "title")) {
        // Fuzzy path runs only with a title to search by.
        didLookup = true;
        const hit = await resolveByQuery(item, skip);
        if (hit) {
          record = hit.record;
          source = hit.source;
          confidence = hit.confidence;
        }
      }
    } catch (e) {
      if (ZMR.isRateLimit(e)) {
        proposal._deferred = true;
        proposal.reason = "rate_limited";
        return proposal;
      }
      proposal.error = String(e);
      proposal.reason = "error";
      return proposal;
    }

    if (!record) {
      // No match: matched:false, empty fields. Distinguish "nothing to search
      // with" (no identifier AND no title) from "searched but found nothing".
      proposal.reason = didLookup ? "no_match" : "no_title";
      return proposal;
    }

    // Determine target item type: prefer a mapped CSL/translator type, but only
    // adopt a *different* type when we actually resolved one; otherwise keep the
    // item's current type so we don't propose spurious retypes.
    let targetType = item.itemType;
    const mappedType = record.type
      ? (record.type.indexOf("-") >= 0 ? cslTypeToZotero(record.type) : record.type)
      : null;
    if (mappedType) targetType = mappedType;

    const mapped = mapRecordToCoreFields(record, targetType);
    const fields = diffFields(item, mapped);

    // itemType change is structural: propose it only when it genuinely differs
    // and we have a confident (identifier) or resolved type.
    if (mappedType && mappedType !== item.itemType) {
      fields.itemType = {
        current: item.itemType,
        proposed: mappedType,
        changed: true,
        willFill: false,
      };
    }

    proposal.matched = true;
    proposal.source = source;
    proposal.confidence = confidence;
    proposal.fields = fields;
    // sourceFields: the mapped values the source provided, so the dialog can
    // tell "(same)" (source had a value equal to current) from "(not found)".
    proposal.sourceFields = mapped;
    // reason: null when there are changes to show; "complete" when matched but
    // every source value equalled current (nothing to fill).
    proposal.reason = Object.keys(fields).length ? null : "complete";
    return proposal;
  }

  // =======================================================================
  // 8. buildProposalsForItems (single-flight, paced, capped, continue-on-error)
  // =======================================================================
  let _running = false;

  /**
   * Build proposals for a batch of items: single-flight, regular+titled only,
   * capped to the batchMax pref, sequential with jittered pacing between items,
   * continue-on-error, with per-source 429 suppression for the rest of the run.
   * @param {Array} items
   * @returns {Promise<Array>} Proposal[]
   */
  async function buildProposalsForItems(items) {
    if (_running) {
      ZMR.notify("A repair scan is already running; please wait.");
      return [];
    }
    _running = true;
    const skip = new Set();
    const out = [];
    try {
      const eligible = (items || []).filter((it) => {
        try { return it.isRegularItem() && getFieldSafe(it, "title"); }
        catch (e) { return false; }
      });
      const cap = num("batchMax", 50);
      const batch = eligible.slice(0, cap > 0 ? cap : eligible.length);

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        try {
          const p = await buildProposal(item, skip);
          out.push(p);
        } catch (e) {
          ZMR.log("buildProposal failed for " + (item && item.key) + ": " + e);
          const p = baseProposal(item);
          p.error = String(e);
          p.reason = "error";
          out.push(p);
        }
        if (i < batch.length - 1) {
          await ZMR.sleep(ZMR.jitter());
        }
      }
    } finally {
      _running = false;
    }
    return out;
  }

  // ---- public surface ----------------------------------------------------
  return {
    buildProposal: buildProposal,
    buildProposalsForItems: buildProposalsForItems,
    mapRecordToCoreFields: mapRecordToCoreFields,
    containerFieldFor: containerFieldFor,
    cslTypeToZotero: cslTypeToZotero,
  };
})();
