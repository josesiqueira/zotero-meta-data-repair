/* Zotero Metadata Repair - core fields, shared helpers, and the library report.
 *
 * This file is loaded FIRST into the shared bootstrap scope, so it creates the
 * single `ZMR` namespace and attaches: shared consts, small helpers (ported from
 * the zotero-open-citations template), the field model (`ZMR.coreFields`), and
 * the missing-field report (`ZMR.report`). resolver.js / writer.js / ui-menu.js
 * load AFTER this and only extend `ZMR`.
 *
 * The 7 "core fields" are the only metadata this plugin repairs/reports on:
 *   itemType, creators, date, container, publisher, place, doi
 * `container` and `publisher` resolve to a real Zotero field per item type.
 */

var ZMR = (typeof ZMR !== "undefined" && ZMR) || {};

(function () {
  const { classes: Cc, interfaces: Ci } = Components;

  // ---- shared consts -----------------------------------------------------
  ZMR.PLUGIN_ID = "meta-data-repair@zotero-plugin.org";
  ZMR.PREF_BRANCH = "metadatarepair.";
  ZMR.CORE_FIELD_KEYS = ["itemType", "creators", "date", "container", "publisher", "place", "doi"];

  const DEFAULTS = {
    openAlexKey: "",     // optional OpenAlex key; OpenAlex is OFF when empty
    email: "",           // Crossref/OpenAlex polite-pool contact (recommended)
    titleFloor: 0.90,    // min title similarity for a guarded fuzzy match
    yearTolerance: 1,    // allowed |year| difference for the year corroborator
    minDelayMs: 1500,    // pacing: min gap between network calls
    maxDelayMs: 4000,    // pacing: max gap between network calls
    batchMax: 50,        // max items processed per run
  };

  const GENERIC_TYPE = "document";              // itemType considered "missing type"
  const AUTHOR_TYPES = ["author", "editor"];    // creator types that satisfy "has authors"

  // ---- module state ------------------------------------------------------
  const _liveTimers = new Set();

  // ---- small helpers (ported from open-citations) ------------------------
  ZMR.log = function (msg) { Zotero.debug("[MetaDataRepair] " + msg); };

  ZMR.getPref = function (k) {
    const v = Zotero.Prefs.get(ZMR.PREF_BRANCH + k);
    return v === undefined || v === null || v === "" ? DEFAULTS[k] : v;
  };
  ZMR.setPref = function (k, v) { Zotero.Prefs.set(ZMR.PREF_BRANCH + k, v); };

  ZMR.jitter = function () {
    const lo = Number(ZMR.getPref("minDelayMs"));
    const hi = Number(ZMR.getPref("maxDelayMs"));
    return lo + Math.floor(Math.random() * Math.max(1, hi - lo));
  };

  // nsITimer-backed sleep (setTimeout is not a global in the bootstrap scope).
  ZMR.sleep = function (ms) {
    return new Promise((res) => {
      const t = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      _liveTimers.add(t);
      t.initWithCallback(
        { notify: () => { _liveTimers.delete(t); res(); } },
        ms, Ci.nsITimer.TYPE_ONE_SHOT
      );
    });
  };

  ZMR.notify = function (msg) {
    ZMR.log(msg);
    try {
      const pw = new Zotero.ProgressWindow();
      pw.changeHeadline("Metadata Repair");
      pw.addDescription(msg);
      pw.show();
      pw.startCloseTimer(5000);
    } catch (e) { /* headless / no window */ }
  };

  ZMR.mainWindow = function () { return Zotero.getMainWindow(); };
  ZMR.mainWindows = function () {
    return typeof Zotero.getMainWindows === "function"
      ? Zotero.getMainWindows()
      : [Zotero.getMainWindow()].filter(Boolean);
  };

  function rateLimitError() {
    const e = new Error("rate-limited");
    e._rateLimit = true;
    return e;
  }
  ZMR.rateLimitError = rateLimitError;
  ZMR.isRateLimit = function (e) {
    return !!(e && (e._rateLimit || e.status === 429 ||
      (e.xmlhttp && e.xmlhttp.status === 429)));
  };

  ZMR.norm = function (s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ").trim();
  };

  // GET returning parsed JSON; throws a rate-limit-tagged error on HTTP 429.
  ZMR.httpJson = async function (url, headers) {
    const opts = { responseType: "json", timeout: 30000, successCodes: false };
    if (headers) opts.headers = headers;
    const resp = await Zotero.HTTP.request("GET", url, opts);
    if (resp.status === 429) throw rateLimitError();
    if (resp.status < 200 || resp.status >= 300) return null;
    return resp.response !== undefined && resp.response !== null
      ? resp.response
      : (resp.responseText ? JSON.parse(resp.responseText) : null);
  };

  // Normalized DOI for an item ("" if none). Checks the DOI field then the
  // `extra` field for a 10.xxxx/... token; strips any doi.org URL prefix.
  ZMR.cleanDOI = function (item) {
    let d = "";
    try { d = item.getField("DOI") || ""; } catch (e) { /* type has no DOI */ }
    if (!d) {
      const ex = (item.getField("extra") || "");
      const m = ex.match(/10\.\d{4,9}\/[^\s]+/);
      if (m) d = m[0];
    }
    return d.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  };

  // ---- field-name resolution ---------------------------------------------
  const CONTAINER_FIELD = {
    journalArticle: "publicationTitle",
    conferencePaper: "proceedingsTitle",
    bookSection: "bookTitle",
    magazineArticle: "publicationTitle",
    newspaperArticle: "publicationTitle",
  };
  const PUBLISHER_FIELD = {
    book: "publisher",
    bookSection: "publisher",
    report: "institution",
    thesis: "university",
    journalArticle: "publisher",
    conferencePaper: "publisher",
  };

  function containerFieldFor(itemType) { return CONTAINER_FIELD[itemType] || null; }
  function publisherFieldFor(itemType) { return PUBLISHER_FIELD[itemType] || null; }

  // The concrete Zotero field name for a core field key on an item, or null
  // (null => structural field, or not valid for this item's type on this build).
  function zoteroFieldFor(fieldKey, item) {
    const itemType = item && item.itemType;
    let name = null;
    switch (fieldKey) {
      case "itemType":
      case "creators": return null;
      case "date": name = "date"; break;
      case "place": name = "place"; break;
      case "doi": name = "DOI"; break;
      case "container": name = containerFieldFor(itemType); break;
      case "publisher": name = publisherFieldFor(itemType); break;
      default: return null;
    }
    if (!name) return null;
    try {
      const fid = Zotero.ItemFields.getID(name);
      if (!fid) return null;
      if (!Zotero.ItemFields.isValidForType(fid, item.itemTypeID)) return null;
    } catch (e) { return null; }
    return name;
  }

  // ---- field model (catalog + policy) ------------------------------------
  // policy: per-type "expected" | "optional"; "*" applies to all listed types.
  const CORE_FIELDS = [
    { key: "itemType", label: "Item type", structural: true,
      policy: { "*": "expected" } },
    { key: "creators", label: "Authors", structural: true,
      policy: { "*": "expected" } },
    { key: "date", label: "Date", policy: { "*": "expected" } },
    { key: "container", label: "Publication / container",
      policy: { journalArticle: "expected", conferencePaper: "expected", bookSection: "expected",
                magazineArticle: "expected", newspaperArticle: "expected" } },
    { key: "publisher", label: "Publisher",
      policy: { book: "expected", bookSection: "expected", report: "expected", thesis: "expected",
                journalArticle: "optional", conferencePaper: "optional" } },
    { key: "place", label: "Place",
      policy: { book: "expected", bookSection: "expected", report: "expected", thesis: "expected",
                conferencePaper: "optional", journalArticle: "optional" } },
    { key: "doi", label: "DOI",
      policy: { journalArticle: "expected", conferencePaper: "expected",
                book: "optional", bookSection: "optional", report: "optional", thesis: "optional" } },
  ];
  const BY_KEY = {};
  for (const f of CORE_FIELDS) BY_KEY[f.key] = f;

  function label(fieldKey) { return (BY_KEY[fieldKey] && BY_KEY[fieldKey].label) || fieldKey; }

  // "expected" | "optional" | "na" for a core field on an item type.
  function fieldPolicy(fieldKey, itemType) {
    const f = BY_KEY[fieldKey];
    if (!f) return "na";
    const p = f.policy;
    let verdict = "na";
    if (Object.prototype.hasOwnProperty.call(p, itemType)) verdict = p[itemType];
    else if (Object.prototype.hasOwnProperty.call(p, "*")) verdict = p["*"];
    else return "na";
    // For non-structural fields, downgrade to "na" if the running Zotero build
    // does not expose the field for this item type.
    if (!f.structural && verdict !== "na") {
      try {
        const item = { itemType: itemType, itemTypeID: Zotero.ItemTypes.getID(itemType) };
        if (!zoteroFieldFor(fieldKey, item)) return "na";
      } catch (e) { return "na"; }
    }
    return verdict;
  }

  // Expected core-field keys for an item type, in CORE order (report denominator).
  function applicableCoreFields(itemType) {
    return ZMR.CORE_FIELD_KEYS.filter((k) => fieldPolicy(k, itemType) === "expected");
  }

  // ---- missing detection -------------------------------------------------
  function hasUsableCreator(item) {
    let creators;
    try { creators = item.getCreators(); } catch (e) { return false; }
    for (const c of (creators || [])) {
      let typeName = "";
      try { typeName = Zotero.CreatorTypes.getName(c.creatorTypeID); } catch (e) { /* ignore */ }
      if (AUTHOR_TYPES.indexOf(typeName) === -1) continue;
      const last = (c.lastName || "").trim();
      const one = (c.fieldMode === 1) ? last : (last || (c.firstName || "").trim());
      if (one) return true;
    }
    return false;
  }

  function hasParsableYear(item) {
    let raw = "";
    try { raw = item.getField("date", false, true) || ""; } catch (e) { return false; }
    if (!raw.trim()) return false;
    try {
      const d = Zotero.Date.strToDate(raw);
      return d && Number.isFinite(Number(d.year));
    } catch (e) { return false; }
  }

  function fieldHasValue(item, fieldKey) {
    if (fieldKey === "itemType") return item.itemType !== GENERIC_TYPE;
    if (fieldKey === "creators") return hasUsableCreator(item);
    if (fieldKey === "date") return hasParsableYear(item);
    if (fieldKey === "doi") return ZMR.cleanDOI(item) !== "";
    const name = zoteroFieldFor(fieldKey, item);
    if (!name) return true; // not applicable -> treat as "not missing"
    let v = "";
    try { v = item.getField(name) || ""; } catch (e) { return true; }
    return v.trim() !== "";
  }

  // True ONLY when the field is expected for this item AND empty/unparseable.
  function isFieldMissing(item, fieldKey) {
    if (fieldPolicy(fieldKey, item.itemType) !== "expected") return false;
    return !fieldHasValue(item, fieldKey);
  }

  ZMR.coreFields = {
    CORE_FIELDS: CORE_FIELDS,
    KEYS: ZMR.CORE_FIELD_KEYS,
    label: label,
    resolveZoteroField: zoteroFieldFor,
    zoteroFieldFor: zoteroFieldFor,
    containerFieldFor: containerFieldFor,
    publisherFieldFor: publisherFieldFor,
    fieldPolicy: fieldPolicy,
    applicableCoreFields: applicableCoreFields,
    isFieldMissing: isFieldMissing,
  };

  // ---- library report ----------------------------------------------------
  function itemTypeLabel(itemType) {
    try { return Zotero.ItemTypes.getLocalizedString(itemType); } catch (e) { return itemType; }
  }
  function pct(missing, applicable) {
    return applicable > 0 ? Math.round((missing / applicable) * 100) : 0;
  }

  /**
   * Build the completeness report for a library (default: current user library).
   * @param {{libraryID?:number, worstLimit?:number}} [opts]
   * @returns {Promise<Object>} the frozen Report shape (see CONTRACTS).
   */
  async function getReport(opts) {
    opts = opts || {};
    const libraryID = opts.libraryID || Zotero.Libraries.userLibraryID;
    const worstLimit = opts.worstLimit || 10;

    const all = await Zotero.Items.getAll(libraryID, true);
    const items = all.filter((it) => it.isRegularItem());

    const byField = {};
    for (const k of ZMR.CORE_FIELD_KEYS) {
      byField[k] = { label: label(k), applicable: 0, missing: 0, missingPct: 0 };
    }
    const byItemType = {};
    const worst = [];
    let expectedFieldSlots = 0;
    let filledFieldSlots = 0;

    for (const item of items) {
      const itemType = item.itemType;
      const keys = applicableCoreFields(itemType);
      if (!byItemType[itemType]) {
        byItemType[itemType] = {
          label: itemTypeLabel(itemType), count: 0, completeness: 0,
          missingByField: {}, _slots: 0, _filled: 0,
        };
      }
      const t = byItemType[itemType];
      t.count++;

      const missingKeys = [];
      for (const k of keys) {
        expectedFieldSlots++;
        t._slots++;
        byField[k].applicable++;
        if (isFieldMissing(item, k)) {
          byField[k].missing++;
          t.missingByField[k] = (t.missingByField[k] || 0) + 1;
          missingKeys.push(k);
        } else {
          filledFieldSlots++;
          t._filled++;
        }
      }
      if (missingKeys.length) {
        worst.push({
          itemKey: item.key,
          libraryID: item.libraryID,
          itemType: itemType,
          title: item.getField("title") || "(no title)",
          missing: missingKeys,
          missingCount: missingKeys.length,
        });
      }
    }

    for (const k of ZMR.CORE_FIELD_KEYS) {
      byField[k].missingPct = pct(byField[k].missing, byField[k].applicable);
    }
    for (const tn of Object.keys(byItemType)) {
      const t = byItemType[tn];
      t.completeness = t._slots > 0 ? Math.round((t._filled / t._slots) * 100) : 100;
      delete t._slots; delete t._filled;
    }
    worst.sort((a, b) => b.missingCount - a.missingCount ||
      a.itemType.localeCompare(b.itemType) || a.title.localeCompare(b.title));

    return {
      version: ZMR._version || "",
      generatedAt: new Date().toISOString(),
      libraryID: libraryID,
      scopeLabel: "My Library",
      totalItems: items.length,
      completeness: expectedFieldSlots > 0
        ? Math.round((filledFieldSlots / expectedFieldSlots) * 100) : 100,
      expectedFieldSlots: expectedFieldSlots,
      filledFieldSlots: filledFieldSlots,
      byField: byField,
      byItemType: byItemType,
      worst: worst.slice(0, worstLimit),
    };
  }

  ZMR.report = { getReport: getReport };
})();
