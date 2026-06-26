/* zotero-meta-data-repair v0.1.1 - approve-per-field DIFF dialog controller.
 *
 * Runs in the XUL-rooted dialog window opened via:
 *   win.openDialog("chrome://metadatarepair/content/diff-dialog.xhtml",
 *                  "zmr-diff",
 *                  "chrome,dialog,modal,centerscreen,resizable,width=780,height=560",
 *                  io);
 *
 * INPUT : window.arguments[0] = { proposal, itemDisplayTitle, out, batch? }
 *           batch = { index, total } or undefined.
 * OUTPUT: mutates window.arguments[0].out IN PLACE (never reassigns it) to
 *           { approved, fieldsToApply:[coreKey], overwriteNonEmpty:{[coreKey]:Boolean},
 *             batchAction?:"apply"|"skip"|"stop" }.
 *
 * Drives ONLY the IDs in the DESIGN "Dialog DOM contract":
 *   #zmr-title #zmr-subhead #zmr-banner (#zmr-banner-title #zmr-banner-body)
 *   #zmr-overwrite-toggle #zmr-approve-all #zmr-clear-all #zmr-tbody
 *   #zmr-apply #zmr-skip #zmr-cancel #zmr-close
 */
var ZMR_Diff = {
  HTML: "http://www.w3.org/1999/xhtml",

  // CORE field order (frozen).
  KEYS: ["itemType", "creators", "date", "container", "publisher", "place", "doi"],

  // Local label fallback (used when ZMR.coreFields.label is unavailable).
  LABELS: {
    itemType: "Item type",
    creators: "Authors",
    date: "Date",
    container: "Publication / container",
    publisher: "Publisher",
    place: "Place",
    doi: "DOI"
  },

  // Reason WORDING map (UI layer; resolver only emits the code). No em dashes.
  REASONS: {
    no_match: {
      title: "No confident match found",
      body: "We couldn't find a reliable online record for this item. There's no DOI or other identifier, and the title didn't match closely enough to trust an update.",
      tone: "info"
    },
    complete: {
      title: "Already up to date",
      body: "We found a matching record online, but it had nothing this item is missing. No changes were proposed.",
      tone: "info"
    },
    no_title: {
      title: "Not enough to search",
      body: "This item has no title, so there's nothing to look up. Add a title (or a DOI) and try again.",
      tone: "info"
    },
    rate_limited: {
      title: "Couldn't reach the lookup service",
      body: "The lookup service is temporarily busy or unavailable. Your item wasn't changed. Try again shortly.",
      tone: "warn"
    },
    unsupported_type: {
      title: "Lookup not available for this item type",
      body: "Automatic repair supports articles, books, conference papers, and similar items. This item type isn't supported yet, so nothing was changed.",
      tone: "warn"
    },
    error: {
      title: "Something went wrong",
      body: "The lookup failed unexpectedly. Your item wasn't changed.",
      tone: "warn"
    }
  },

  rows: [],   // [{ key, kind, checkbox }]; kind = "fill" | "overwrite"
  io: null,
  item: null, // resolved live Zotero item (or null)

  $(id) { return document.getElementById(id); },

  // Create an HTML element in the XHTML namespace; `attrs.text` sets textContent.
  he(tag, attrs) {
    const el = document.createElementNS(this.HTML, tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "text") el.textContent = attrs[k];
        else el.setAttribute(k, attrs[k]);
      }
    }
    return el;
  },

  ZMR() {
    try {
      const Z = this.Zotero || (typeof Zotero !== "undefined" ? Zotero : null);
      return (Z && Z.MetaDataRepair) || null;
    } catch (e) { return null; }
  },

  label(key) {
    const ZMR = this.ZMR();
    try {
      if (ZMR && ZMR.coreFields && typeof ZMR.coreFields.label === "function") {
        const l = ZMR.coreFields.label(key);
        if (l) return l;
      }
    } catch (e) { /* fall through */ }
    return this.LABELS[key] || key;
  },

  // -----------------------------------------------------------------------
  // Live current-value reads (mirror resolver's readCurrent* logic). Every
  // returned scalar is a plain string; creators is an Array of {firstName,
  // lastName, creatorType}. Returns null/[] when the field is not applicable.
  // -----------------------------------------------------------------------
  zoteroFieldFor(key) {
    const ZMR = this.ZMR();
    if (ZMR && ZMR.coreFields && typeof ZMR.coreFields.zoteroFieldFor === "function") {
      try { return ZMR.coreFields.zoteroFieldFor(key, this.item); } catch (e) { /* fall through */ }
    }
    if (key === "date") return "date";
    if (key === "place") return "place";
    if (key === "doi") return "DOI";
    return null;
  },

  // Is this core field applicable to the resolved item's type?
  applicable(key) {
    if (!this.item) return false;
    if (key === "itemType" || key === "creators") return true;
    if (key === "doi") return true;
    return !!this.zoteroFieldFor(key);
  },

  readCurrentCreators() {
    if (!this.item) return [];
    try {
      const cs = this.item.getCreators() || [];
      const Z = this.Zotero;
      return cs.map((c) => {
        let ct = "author";
        try { ct = (Z && Z.CreatorTypes.getName(c.creatorTypeID)) || "author"; }
        catch (e) { /* default */ }
        return {
          firstName: c.firstName || "",
          lastName: c.lastName || c.name || "",
          creatorType: ct
        };
      });
    } catch (e) { return []; }
  },

  readCurrent(key) {
    if (!this.item) return "";
    if (key === "itemType") {
      try { return this.item.itemType || ""; } catch (e) { return ""; }
    }
    if (key === "creators") return this.readCurrentCreators();
    if (key === "doi") {
      const ZMR = this.ZMR();
      try {
        if (ZMR && typeof ZMR.cleanDOI === "function") return ZMR.cleanDOI(this.item) || "";
      } catch (e) { /* fall through */ }
      try { return this.item.getField("DOI") || ""; } catch (e) { return ""; }
    }
    const zf = this.zoteroFieldFor(key);
    if (!zf) return "";
    try { return this.item.getField(zf) || ""; } catch (e) { return ""; }
  },

  // Render a value for display. creators -> one per line. Returns "" for empty.
  fmt(key, value) {
    if (value === undefined || value === null) return "";
    if (key === "creators") {
      if (!Array.isArray(value) || !value.length) return "";
      return value.map((c) => {
        const last = (c && (c.lastName || c.name)) || "";
        const first = (c && c.firstName) || "";
        if (last && first) return last + ", " + first;
        return last || first || "(unknown)";
      }).join("\n");
    }
    return String(value);
  },

  // Append a (possibly multi-line) text value into a cell, HTML-escaped, with
  // <br/> between lines. Wrapping flag toggles the struck-through class.
  putText(td, text, struck) {
    const lines = String(text).split("\n");
    const span = this.he("span");
    if (struck) span.setAttribute("class", "zmr-old");
    lines.forEach((ln, i) => {
      if (i > 0) span.appendChild(this.he("br"));
      span.appendChild(document.createTextNode(ln));
    });
    td.appendChild(span);
  },

  putMuted(td, text) {
    const span = this.he("span", { "class": "zmr-note", text: text });
    td.appendChild(span);
  },

  // =======================================================================
  init() {
    try {
      const args = window.arguments && window.arguments[0];
      if (!args) return;
      this.io = args;

      const proposal = args.proposal || {};
      const fields = proposal.fields || {};
      const sourceFields = proposal.sourceFields || null;
      const batch = args.batch || null;
      const hasChanges = Object.keys(fields).length > 0;

      // Zotero is NOT a global in a standalone chrome dialog window; resolve it
      // from the passed args, the opener window, or (rarely) the global.
      this.Zotero = (args && args.Zotero) ||
        (window.opener && window.opener.Zotero) ||
        (typeof Zotero !== "undefined" ? Zotero : null);

      // Resolve the live item to read CURRENT values for all 7 core fields.
      this.item = null;
      try {
        const Z = this.Zotero;
        if (Z && Z.Items && typeof Z.Items.getByLibraryAndKey === "function") {
          this.item = Z.Items.getByLibraryAndKey(
            proposal.libraryID, proposal.itemKey) || null;
        }
      } catch (e) { this.item = null; }

      // ---- Header ----------------------------------------------------------
      const title = args.itemDisplayTitle || "(untitled item)";
      this.$("zmr-title").textContent = title;

      const subhead = this.$("zmr-subhead");
      if (proposal.matched) {
        const source = proposal.source || "unknown";
        const conf = (typeof proposal.confidence === "number" ? proposal.confidence : 0);
        const pct = Math.round(conf * 100);
        let txt = "Matched via " + source + ", confidence " + pct + "%";
        if (batch && typeof batch.index !== "undefined" && typeof batch.total !== "undefined") {
          txt += " · item " + batch.index + " of " + batch.total;
        }
        subhead.textContent = txt;
        subhead.hidden = false;
        subhead.removeAttribute("hidden");
      } else {
        subhead.textContent = "";
        subhead.hidden = true;
        subhead.setAttribute("hidden", "true");
      }

      // ---- Reason banner ---------------------------------------------------
      this.renderBanner(proposal.reason);

      // ---- Rows (ALL 7 in CORE order) -------------------------------------
      const tbody = this.$("zmr-tbody");
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
      this.rows = [];
      this.KEYS.forEach((key) => this.buildRow(tbody, key, fields[key], sourceFields));

      // ---- Footer wiring ---------------------------------------------------
      const toggle = this.$("zmr-overwrite-toggle");
      if (toggle) toggle.addEventListener("command", () => this.onToggleOverwrite());
      this.bind("zmr-approve-all", () => this.onApproveAll());
      this.bind("zmr-clear-all", () => this.onClearAll());
      this.bind("zmr-cancel", () => this.onCancel());
      this.bind("zmr-apply", () => this.onApply());
      this.bind("zmr-close", () => this.onCancel());

      // Batch-only Skip button.
      const skip = this.$("zmr-skip");
      if (skip) {
        if (batch) {
          skip.hidden = false;
          skip.removeAttribute("hidden");
          skip.addEventListener("command", () => this.onSkip());
        } else {
          skip.hidden = true;
          skip.setAttribute("hidden", "true");
        }
      }

      // Apply vs Close: when there are zero changed fields, hide Apply + show Close.
      const apply = this.$("zmr-apply");
      const close = this.$("zmr-close");
      if (hasChanges) {
        if (apply) { apply.hidden = false; apply.removeAttribute("hidden"); }
        if (close) { close.hidden = true; close.setAttribute("hidden", "true"); }
      } else {
        if (apply) { apply.hidden = true; apply.setAttribute("hidden", "true"); }
        if (close) { close.hidden = false; close.removeAttribute("hidden"); }
      }

      // Overwrite rows start disabled (gate is off by default).
      this.applyGate(false);
      this.refreshApplyState();

      // ---- Focus -----------------------------------------------------------
      this.focusInitial(hasChanges);
    } catch (e) {
      try { Zotero.debug("[MetaDataRepair/diff] init error: " + e); } catch (ee) { /* no Zotero */ }
    }
  },

  bind(id, fn) {
    const el = this.$(id);
    if (el) el.addEventListener("command", fn);
  },

  renderBanner(reason) {
    const banner = this.$("zmr-banner");
    if (!banner) return;
    const spec = reason ? this.REASONS[reason] : null;
    if (!spec) {
      banner.hidden = true;
      banner.setAttribute("hidden", "true");
      return;
    }
    banner.setAttribute("class",
      "zmr-banner " + (spec.tone === "warn" ? "zmr-banner-warn" : "zmr-banner-info"));
    const t = this.$("zmr-banner-title");
    const b = this.$("zmr-banner-body");
    if (t) t.textContent = spec.title;
    if (b) b.textContent = spec.body;
    banner.hidden = false;
    banner.removeAttribute("hidden");
  },

  // -----------------------------------------------------------------------
  // Row branches (DESIGN "Row rendering rules"):
  //   A. proposal.fields[key] && willFill:true   -> zmr-fill  "Add"     (pre-checked)
  //   B. proposal.fields[key] && willFill:false  -> zmr-overwrite "Replace"
  //                                                 (unchecked, disabled until gate;
  //                                                  current struck-through)
  //   C. sourceFields[key] present && == current -> zmr-unchanged "(same)"
  //   D. field not applicable to item type       -> zmr-nodata "(n/a)"
  //   E. otherwise                               -> zmr-nodata "(not found)"
  // Every injected value is HTML-escaped (textContent / text nodes).
  // -----------------------------------------------------------------------
  buildRow(tbody, key, field, sourceFields) {
    const tr = this.he("tr");
    const current = this.readCurrent(key);
    const currentText = this.fmt(key, current);

    // Branch detection.
    const isChange = !!field;
    const willFill = isChange && field.willFill === true;
    const isOverwrite = isChange && field.willFill === false;

    let cls, badge, proposedText, struckCurrent, checkbox;

    if (isChange) {
      proposedText = this.fmt(key, field.proposed);
      if (willFill) {
        cls = "zmr-fill";
        badge = "Add";
        struckCurrent = false;
      } else {
        cls = "zmr-overwrite";
        badge = "Replace";
        struckCurrent = true;
      }
    } else if (!this.applicable(key)) {
      cls = "zmr-nodata";
      proposedText = "(n/a)";
      struckCurrent = false;
    } else {
      // Did the source supply this field at all?
      const srcHas = sourceFields &&
        Object.prototype.hasOwnProperty.call(sourceFields, key) &&
        !this.isBlank(sourceFields[key]);
      if (srcHas && this.equalsCurrent(key, current, sourceFields[key])) {
        cls = "zmr-unchanged";
        proposedText = "(same)";
      } else {
        cls = "zmr-nodata";
        proposedText = "(not found)";
      }
      struckCurrent = false;
    }
    tr.setAttribute("class", cls);

    // Column 1: checkbox (only for change rows).
    const tdCk = this.he("td", { "class": "zmr-ck" });
    if (isChange) {
      checkbox = this.he("input", { type: "checkbox" });
      if (willFill) checkbox.checked = true;          // safe fill: pre-checked
      if (isOverwrite) checkbox.disabled = true;      // gated until overwrite toggle
      checkbox.addEventListener("change", () => this.refreshApplyState());
      tdCk.appendChild(checkbox);
    } else {
      tdCk.appendChild(document.createTextNode("·")); // middle dot, no checkbox
    }
    tr.appendChild(tdCk);

    // Column 2: field label (+ badge for change rows).
    const tdLabel = this.he("td", { "class": "zmr-field" });
    tdLabel.appendChild(this.he("span", { text: this.label(key) }));
    if (badge) {
      const b = this.he("span", { "class": "zmr-badge", text: badge });
      tdLabel.appendChild(document.createTextNode(" "));
      tdLabel.appendChild(b);
    }
    tr.appendChild(tdLabel);

    // Column 3: current value.
    const tdCur = this.he("td", { "class": "zmr-current" });
    if (currentText === "") this.putMuted(tdCur, "(empty)");
    else this.putText(tdCur, currentText, struckCurrent);
    tr.appendChild(tdCur);

    // Column 4: arrow (only for change rows).
    tr.appendChild(this.he("td", { "class": "zmr-arrow", text: isChange ? "→" : "" }));

    // Column 5: proposed value.
    const tdProp = this.he("td", { "class": "zmr-proposed" });
    if (isChange) this.putText(tdProp, proposedText, false);
    else this.putMuted(tdProp, proposedText);
    tr.appendChild(tdProp);

    tbody.appendChild(tr);

    if (isChange) {
      this.rows.push({ key: key, kind: willFill ? "fill" : "overwrite", checkbox: checkbox });
    }
  },

  // ---- value helpers (parallel resolver's diff helpers, display-only) ----
  isBlank(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    return String(v).trim() === "";
  },

  // Compare a live current value against a source-supplied value for "(same)".
  equalsCurrent(key, current, sourceVal) {
    if (key === "creators") {
      const sig = (arr) => (Array.isArray(arr) ? arr : []).map((c) =>
        String(c && (c.lastName || c.name) || "").trim().toLowerCase() + "|" +
        String(c && c.firstName || "").trim().toLowerCase()).join(";");
      return sig(current) === sig(sourceVal);
    }
    return String(current == null ? "" : current).trim().toLowerCase() ===
           String(sourceVal == null ? "" : sourceVal).trim().toLowerCase();
  },

  // -----------------------------------------------------------------------
  // Interaction
  // -----------------------------------------------------------------------
  // Overwrite gate: enable/disable all overwrite-row checkboxes.
  applyGate(on) {
    this.rows.forEach((r) => {
      if (r.kind === "overwrite" && r.checkbox) {
        r.checkbox.disabled = !on;
        if (!on) r.checkbox.checked = false;
      }
    });
  },

  onToggleOverwrite() {
    const toggle = this.$("zmr-overwrite-toggle");
    const on = !!(toggle && toggle.checked);
    this.applyGate(on);
    this.refreshApplyState();
  },

  // "Approve all changed": check all currently-enabled change rows.
  onApproveAll() {
    this.rows.forEach((r) => {
      if (r.checkbox && !r.checkbox.disabled) r.checkbox.checked = true;
    });
    this.refreshApplyState();
  },

  // "Clear all": uncheck everything.
  onClearAll() {
    this.rows.forEach((r) => {
      if (r.checkbox) r.checkbox.checked = false;
    });
    this.refreshApplyState();
  },

  approvedCount() {
    let n = 0;
    this.rows.forEach((r) => {
      if (r.checkbox && r.checkbox.checked && !r.checkbox.disabled) n++;
    });
    return n;
  },

  // Live Apply label "Apply N approved changes"; disabled when N == 0.
  refreshApplyState() {
    const apply = this.$("zmr-apply");
    if (!apply) return;
    const n = this.approvedCount();
    apply.setAttribute("label", "Apply " + n + " approved changes");
    apply.disabled = (n === 0);
  },

  focusInitial(hasChanges) {
    try {
      if (hasChanges) {
        const apply = this.$("zmr-apply");
        if (apply && !apply.disabled) { apply.focus(); return; }
        for (const r of this.rows) {
          if (r.checkbox && !r.checkbox.disabled) { r.checkbox.focus(); return; }
        }
        if (apply) apply.focus();
      } else {
        const close = this.$("zmr-close");
        if (close) close.focus();
      }
    } catch (e) { /* focus best-effort */ }
  },

  // -----------------------------------------------------------------------
  // Output (mutate io.out in place; never reassign)
  // -----------------------------------------------------------------------
  onApply() {
    const out = this.io.out;
    const fieldsToApply = [];
    const overwriteNonEmpty = {};
    // this.rows is already in CORE order.
    this.rows.forEach((r) => {
      if (r.checkbox && r.checkbox.checked && !r.checkbox.disabled) {
        fieldsToApply.push(r.key);
        if (r.kind === "overwrite") overwriteNonEmpty[r.key] = true;
      }
    });
    out.approved = true;
    out.fieldsToApply = fieldsToApply;
    out.overwriteNonEmpty = overwriteNonEmpty;
    out.batchAction = "apply";
    window.close();
  },

  onCancel() {
    // Leave out at its pre-seeded cancel default; signal stop in batch mode.
    if (this.io.batch) this.io.out.batchAction = "stop";
    window.close();
  },

  onSkip() {
    const out = this.io.out;
    out.approved = false;
    out.fieldsToApply = [];
    out.overwriteNonEmpty = {};
    out.batchAction = "skip";
    window.close();
  }
};
