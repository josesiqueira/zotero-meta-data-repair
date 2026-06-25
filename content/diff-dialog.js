/* zotero-meta-data-repair — approve-per-field DIFF dialog controller.
 * Runs in the XUL-rooted dialog window opened via:
 *   win.openDialog("chrome://metadatarepair/content/diff-dialog.xhtml",
 *                  "zmr-diff", "chrome,dialog,modal,centerscreen,resizable", io);
 * INPUT : window.arguments[0] = { proposal, itemDisplayTitle, out, batch? }
 * OUTPUT: mutates window.arguments[0].out (never reassigns it).
 */
var ZMR_Diff = {
  HTML: "http://www.w3.org/1999/xhtml",

  // CORE field order (frozen, CONTRACTS.md).
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

  rows: [],       // [{ key, willFill, rowCheckbox, allowCheckbox }]
  io: null,

  $(id) { return document.getElementById(id); },

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

  label(key) {
    try {
      const ZMR = (typeof Zotero !== "undefined" && Zotero.MetaDataRepair) || null;
      if (ZMR && ZMR.coreFields && typeof ZMR.coreFields.label === "function") {
        const l = ZMR.coreFields.label(key);
        if (l) return l;
      }
    } catch (e) { /* fall through to local map */ }
    return this.LABELS[key] || key;
  },

  // Render a value for display. creators arrays -> "Last, First; Last, First".
  fmt(key, value) {
    if (value === undefined || value === null || value === "") return "(empty)";
    if (key === "creators" && Array.isArray(value)) {
      if (!value.length) return "(empty)";
      return value.map((c) => {
        const last = (c && (c.lastName || c.name)) || "";
        const first = (c && c.firstName) || "";
        if (last && first) return last + ", " + first;
        return last || first || "(unknown)";
      }).join("; ");
    }
    return String(value);
  },

  count(value) {
    return Array.isArray(value) ? value.length : (value ? 1 : 0);
  },

  init() {
    try {
      const args = window.arguments && window.arguments[0];
      if (!args) return;
      this.io = args;
      const proposal = args.proposal || { fields: {} };
      const fields = proposal.fields || {};
      const batch = args.batch;

      // Header.
      const title = args.itemDisplayTitle || "(untitled item)";
      this.$("zmr-title").textContent = "Repair: " + title;
      const source = proposal.source || "unknown";
      const pct = Math.round(((typeof proposal.confidence === "number" ? proposal.confidence : 0)) * 100);
      this.$("zmr-source").textContent = "Matched via " + source + ", confidence " + pct + "%";

      if (batch && typeof batch.index !== "undefined" && typeof batch.total !== "undefined") {
        this.$("zmr-batch").textContent = "(" + batch.index + "/" + batch.total + ")";
        const skip = this.$("zmr-skip");
        skip.hidden = false;
        skip.removeAttribute("hidden");
        skip.addEventListener("command", () => this.onSkip());
      }

      // Build one row per core field, in CORE order.
      const tbody = this.$("zmr-rows");
      this.KEYS.forEach((key) => this.buildRow(tbody, key, fields[key]));

      // Footer buttons.
      this.$("zmr-approveall").addEventListener("command", () => this.onApproveAll());
      this.$("zmr-clearall").addEventListener("command", () => this.onClearAll());
      this.$("zmr-cancel").addEventListener("command", () => this.onCancel());
      this.$("zmr-apply").addEventListener("command", () => this.onApply());

      this.refreshApplyState();
    } catch (e) {
      try { Zotero.debug("[MetaDataRepair/diff] init error: " + e); } catch (ee) { /* no Zotero */ }
    }
  },

  buildRow(tbody, key, field) {
    const tr = this.he("tr");
    const present = !!field;
    const willFill = present && field.willFill === true;
    const overwrite = present && field.willFill === false;

    tr.setAttribute("class", !present ? "zmr-none" : (willFill ? "zmr-fill" : "zmr-overwrite"));

    // Column 1: row checkbox.
    const tdCk = this.he("td", { "class": "zmr-ck" });
    const cb = this.he("input", { type: "checkbox" });
    if (!present) cb.disabled = true;
    else if (willFill) cb.checked = true; // safe fill pre-checked
    cb.addEventListener("change", () => this.refreshApplyState());
    tdCk.appendChild(cb);
    tr.appendChild(tdCk);

    // Column 2: label (+ inline allow-overwrite control for overwrite rows).
    const tdLabel = this.he("td", { "class": "zmr-label" });
    tdLabel.appendChild(this.he("div", { text: this.label(key) }));

    let allowCb = null;
    if (overwrite) {
      const allowWrap = this.he("label", { "class": "zmr-allow" });
      allowCb = this.he("input", { type: "checkbox" });
      allowCb.addEventListener("change", () => this.refreshApplyState());
      allowWrap.appendChild(allowCb);
      allowWrap.appendChild(this.he("span", { text: " allow overwrite" }));
      tdLabel.appendChild(allowWrap);
    }
    tr.appendChild(tdLabel);

    // Column 3: current value.
    const tdCur = this.he("td", { "class": "zmr-current", text: this.fmt(key, present ? field.current : "") });
    tr.appendChild(tdCur);

    // Column 4: arrow.
    tr.appendChild(this.he("td", { "class": "zmr-arrow", text: present ? "→" : "" }));

    // Column 5: proposed value (+ creators add/replace note).
    const tdProp = this.he("td", { "class": "zmr-proposed" });
    if (present) {
      tdProp.appendChild(this.he("span", { text: this.fmt(key, field.proposed) }));
      if (key === "creators") {
        const n = this.count(field.proposed);
        const note = willFill ? " (add " + n + ")" : " (replace " + n + ")";
        tdProp.appendChild(this.he("span", { "class": "zmr-note", text: note }));
      }
    } else {
      tdProp.appendChild(this.he("span", { "class": "zmr-note", text: "no change" }));
    }
    tr.appendChild(tdProp);

    tbody.appendChild(tr);

    this.rows.push({ key: key, present: present, willFill: willFill, overwrite: overwrite,
                     rowCheckbox: cb, allowCheckbox: allowCb });
  },

  // A row counts as approved when its row checkbox is ticked AND, for overwrite
  // rows, its allow-overwrite box is also ticked.
  isApproved(r) {
    if (!r.present) return false;
    if (!r.rowCheckbox.checked) return false;
    if (r.overwrite && !(r.allowCheckbox && r.allowCheckbox.checked)) return false;
    return true;
  },

  refreshApplyState() {
    const any = this.rows.some((r) => this.isApproved(r));
    this.$("zmr-apply").disabled = !any;
  },

  onApproveAll() {
    this.rows.forEach((r) => {
      if (!r.present) return;
      r.rowCheckbox.checked = true;
      if (r.overwrite && r.allowCheckbox) r.allowCheckbox.checked = true;
    });
    this.refreshApplyState();
  },

  onClearAll() {
    this.rows.forEach((r) => {
      if (r.rowCheckbox && !r.rowCheckbox.disabled) r.rowCheckbox.checked = false;
      if (r.allowCheckbox) r.allowCheckbox.checked = false;
    });
    this.refreshApplyState();
  },

  onApply() {
    const out = this.io.out;
    const fieldsToApply = [];
    const overwriteNonEmpty = {};
    // Preserve CORE order via this.rows (already in CORE order).
    this.rows.forEach((r) => {
      if (this.isApproved(r)) {
        fieldsToApply.push(r.key);
        if (r.overwrite) overwriteNonEmpty[r.key] = true;
      }
    });
    out.approved = true;
    out.fieldsToApply = fieldsToApply;
    out.overwriteNonEmpty = overwriteNonEmpty;
    if (this.io.batch) out.batchAction = "apply";
    window.close();
  },

  onCancel() {
    // Leave out at the pre-seeded cancel default; signal stop in batch mode.
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
