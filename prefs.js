/* Metadata Repair - preferences pane script.
 * Runs in the Zotero preferences window. `document` is the prefs document;
 * `Zotero` is available. Talks to the plugin via the Zotero.MetaDataRepair API
 * exposed by lib/ui-menu.js.
 */
var ZMR_Prefs = {
  api() { return Zotero.MetaDataRepair || {}; },
  $(id) { return document.getElementById(id); },

  init() {
    if (this._inited) return;
    try {
      this._inited = true;
      const api = this.api();

      // Settings: wired to the plugin's own getPref/setPref (branch metadatarepair.)
      this.$("zmr-openalexkey").value = (api.getPref && api.getPref("openAlexKey")) || "";
      this.$("zmr-email").value = (api.getPref && api.getPref("email")) || "";

      this.$("zmr-openalexkey").addEventListener("change", () => {
        if (api.setPref) api.setPref("openAlexKey", this.$("zmr-openalexkey").value.trim());
      });
      this.$("zmr-email").addEventListener("change", () => {
        if (api.setPref) api.setPref("email", this.$("zmr-email").value.trim());
      });

      this.$("zmr-refresh").addEventListener("command", () => this.render());
      this.$("zmr-repair-worst").addEventListener("command", () => this.repairWorst());

      this.render();
    } catch (e) {
      Zotero.debug("[MetaDataRepair/prefs] init error: " + e);
    }
  },

  async render() {
    const el = this.$("zmr-report");
    try {
      const api = this.api();
      if (!api.report || !api.report.getReport) {
        el.textContent = "Plugin not ready (reopen this pane).";
        return null;
      }
      const r = await api.report.getReport();
      el.textContent = this.format(r);
      return r;
    } catch (e) {
      el.textContent = "Report error: " + e;
      return null;
    }
  },

  async repairWorst() {
    const api = this.api();
    if (!api.report || !api.runRepair) return;
    const btn = this.$("zmr-repair-worst");
    btn.disabled = true;
    try {
      const r = await api.report.getReport();
      const worst = (r && r.worst) || [];
      const items = [];
      for (const it of worst) {
        try {
          const item = await Zotero.Items.getByLibraryAndKey(it.libraryID, it.itemKey);
          if (item) items.push(item);
        } catch (e) { /* skip unresolvable */ }
      }
      if (items.length) await api.runRepair(items);
    } catch (e) {
      Zotero.debug("[MetaDataRepair/prefs] repairWorst error: " + e);
    } finally {
      btn.disabled = false;
      await this.render();
    }
  },

  format(r) {
    const cf = (this.api().coreFields) || {};
    const label = (k) => (cf.label && cf.label(k)) || k;
    const trunc = (s, n) => {
      s = s || "(untitled)";
      return s.length > n ? s.slice(0, n - 3) + "..." : s;
    };
    const pad = (s, n) => {
      s = String(s);
      return s.length >= n ? s : s + ".".repeat(n - s.length);
    };
    const L = [];

    L.push("Completeness: " + r.completeness + "%  (" + r.totalItems + " items)");
    L.push("");

    // Per-field table (all 7 keys, CORE order).
    L.push("By field:");
    const keys = (cf.KEYS) || ["itemType", "creators", "date", "container", "publisher", "place", "doi"];
    for (const k of keys) {
      const f = (r.byField && r.byField[k]) || { label: label(k), missing: 0, applicable: 0, missingPct: 0 };
      const name = f.label || label(k);
      L.push("  " + pad(name + " ", 24) + " " + f.missing + "/" + f.applicable + " missing (" + f.missingPct + "%)");
    }
    L.push("");

    // Per-itemType list.
    L.push("By item type:");
    const types = Object.entries(r.byItemType || {});
    if (!types.length) {
      L.push("  (none)");
    } else {
      for (const [, t] of types) {
        L.push("  " + (t.label || "?") + " (" + t.count + "): " + t.completeness + "%");
      }
    }
    L.push("");

    // Needs attention (worst offenders).
    L.push("Needs attention:");
    const worst = (r.worst || []);
    if (!worst.length) {
      L.push("  (nothing flagged)");
    } else {
      for (const w of worst) {
        const miss = (w.missing || []).map(label).join(",");
        L.push("  - " + trunc(w.title, 64) + "  (missing: " + miss + ")");
      }
    }

    return L.join("\n");
  },
};

// Self-bootstrap: the fragment's inline onload is unreliable in prefs panes, so
// poll briefly for our elements (they're injected into the prefs document) and
// initialize as soon as they exist.
(function boot(tries) {
  try {
    if (typeof document !== "undefined" && document.getElementById &&
        document.getElementById("zmr-report")) {
      ZMR_Prefs.init();
      return;
    }
  } catch (e) { /* not ready */ }
  if ((tries || 0) < 30) {
    setTimeout(() => boot((tries || 0) + 1), 100);
  }
})(0);
