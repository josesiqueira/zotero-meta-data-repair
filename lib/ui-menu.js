/* Zotero Metadata Repair - UI, lifecycle & orchestration
 *
 * Loaded LAST (via loadSubScript) into the shared ZMR scope, after
 * core-fields.js + resolver.js + writer.js. It assigns the lifecycle hooks
 * (init/addToWindow/removeFromWindow/shutdown), the orchestrator (runRepair)
 * and the UI-free test surface (test) onto ZMR, and publishes the public
 * façade as Zotero.MetaDataRepair in init().
 *
 * Menu wiring is feature-detected:
 *   - Zotero 8/9: Zotero.MenuManager.registerMenu (registered ONCE).
 *   - Zotero 7 (and as a safe fallback): DOM-injected <menuitem> per window.
 */

(function () {
  // Cc/Ci/Services are globals in the bootstrap scope; tolerate absence.
  const _Cc = (typeof Cc !== "undefined") ? Cc
    : (typeof Components !== "undefined" ? Components.classes : null);
  const _Ci = (typeof Ci !== "undefined") ? Ci
    : (typeof Components !== "undefined" ? Components.interfaces : null);

  const DIALOG_URL = "chrome://metadatarepair/content/diff-dialog.xhtml";

  // ---- module state ------------------------------------------------------
  let _menuEls = [];                // DOM <menuitem> elements we created.
  let _menuPopups = [];             // {popup, handler} popupshowing listeners.

  // ---- helpers -----------------------------------------------------------
  function mainWindows() {
    return typeof Zotero.getMainWindows === "function"
      ? Zotero.getMainWindows()
      : [Zotero.getMainWindow()].filter(Boolean);
  }

  function isRegular(it) {
    return !!(it && it.isRegularItem && it.isRegularItem());
  }

  function regularItems(items) {
    return (items || []).filter(isRegular);
  }

  function selectedRegularItems(win) {
    try {
      const pane = (win && win.ZoteroPane) || Zotero.getActiveZoteroPane();
      return regularItems(pane ? pane.getSelectedItems() : []);
    } catch (e) {
      return [];
    }
  }

  // ---- DOM menu injection (Z7 / fallback) --------------------------------
  function addDomMenu(window) {
    if (!window || !window.document) return;
    const doc = window.document;
    if (doc.getElementById("zmr-item-repair")) return;
    const parent = doc.getElementById("zotero-itemmenu");
    if (!parent) return;

    const mi = doc.createXULElement("menuitem");
    mi.id = "zmr-item-repair";
    mi.setAttribute("label", "Repair metadata…");
    mi.classList.add("menuitem-iconic");
    if (ZMR._rootURI) mi.setAttribute("image", ZMR._rootURI + "icons/repair.svg");
    mi.addEventListener("command", function () {
      ZMR.runRepair(selectedRegularItems(window));
    });
    parent.appendChild(mi);
    _menuEls.push(mi);

    // Update label/visibility each time the item menu opens.
    const onShowing = function () {
      try {
        const items = selectedRegularItems(window);
        mi.hidden = items.length === 0;
        mi.setAttribute("label", items.length > 1
          ? "Repair metadata (" + items.length + ")…"
          : "Repair metadata…");
      } catch (e) { /* menu not ready */ }
    };
    parent.addEventListener("popupshowing", onShowing);
    _menuPopups.push({ popup: parent, handler: onShowing });
  }

  function removeDomMenu(window) {
    if (!window || !window.document) return;
    const doc = window.document;
    const el = doc.getElementById("zmr-item-repair");
    if (el) { try { el.remove(); } catch (e) {} }
    _menuEls = _menuEls.filter((m) => m.ownerDocument !== doc);
    _menuPopups = _menuPopups.filter((p) => {
      if (p.popup && p.popup.ownerDocument === doc) {
        try { p.popup.removeEventListener("popupshowing", p.handler); } catch (e) {}
        return false;
      }
      return true;
    });
  }

  function removeAllDomMenus() {
    for (const el of _menuEls) { try { el.remove(); } catch (e) {} }
    _menuEls = [];
    for (const p of _menuPopups) {
      try { p.popup.removeEventListener("popupshowing", p.handler); } catch (e) {}
    }
    _menuPopups = [];
  }

  // ---- public lifecycle --------------------------------------------------
  /**
   * Plugin startup. Registers chrome for the dialog, the prefs pane, publishes
   * the public API, registers the context menu and wires already-open windows.
   * @param {{id:String, version:String, rootURI:String}} data
   */
  ZMR.init = function init(data) {
    data = data || {};
    ZMR._rootURI = data.rootURI || "";
    ZMR._version = data.version || "";

    // Register chrome:// for the diff dialog WITHOUT a chrome.manifest, by
    // mapping content/metadatarepair -> rootURI/content/ at runtime.
    try {
      const aomStartup = _Cc["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(_Ci.amIAddonManagerStartup);
      const manifestURI = Services.io.newURI(ZMR._rootURI + "manifest.json");
      ZMR._chromeHandle = aomStartup.registerChrome(manifestURI, [
        ["content", "metadatarepair", ZMR._rootURI + "content/"],
      ]);
    } catch (e) {
      ZMR.log("init: registerChrome failed: " + e);
    }

    // Preferences pane.
    try {
      Zotero.PreferencePanes.register({
        pluginID: ZMR.PLUGIN_ID,
        src: "prefs.xhtml",
        scripts: ["prefs.js"],
        label: "Metadata Repair",
        image: "icons/repair.svg",
      });
    } catch (e) {
      ZMR.log("init: PreferencePanes.register failed: " + e);
    }

    // Publish the public API surface (see CONTRACTS.md).
    Zotero.MetaDataRepair = {
      init: ZMR.init,
      addToWindow: ZMR.addToWindow,
      removeFromWindow: ZMR.removeFromWindow,
      shutdown: ZMR.shutdown,
      runRepair: ZMR.runRepair,
      resolver: ZMR.resolver,
      writer: ZMR.writer,
      report: ZMR.report,
      coreFields: ZMR.coreFields,
      getPref: ZMR.getPref,
      setPref: ZMR.setPref,
      test: ZMR.test,
    };

    // Context menu: DOM-injected <menuitem> into #zotero-itemmenu per window.
    // This is the path proven across Zotero 7/8/9 (the Z9 MenuManager menu
    // schema has no plain `label`, so a label-less item silently never renders).
    for (const w of mainWindows()) ZMR.addToWindow(w);
  };

  /**
   * Per-window setup. On builds without MenuManager, injects the DOM menuitem.
   * @param {Window} window
   */
  ZMR.addToWindow = function addToWindow(window) {
    addDomMenu(window);
  };

  /**
   * Per-window teardown. Removes the DOM menuitem if one was injected.
   * @param {Window} window
   */
  ZMR.removeFromWindow = function removeFromWindow(window) {
    removeDomMenu(window);
  };

  /**
   * Plugin shutdown. Unregisters the menu, removes DOM menus, releases chrome.
   */
  ZMR.shutdown = function shutdown() {
    removeAllDomMenus();
    try { if (ZMR._chromeHandle) ZMR._chromeHandle.destruct(); } catch (e) {}
    ZMR._chromeHandle = null;
    try { delete Zotero.MetaDataRepair; } catch (e) {}
  };

  // ---- orchestration -----------------------------------------------------
  /**
   * Look up + repair a set of items: build proposals, then for each one with
   * changes, open the modal diff dialog and apply the user's approved subset.
   * @param {Object[]} items
   * @returns {Promise<void>}
   */
  ZMR.runRepair = async function runRepair(items) {
    const targets = regularItems(items);
    if (!targets.length) return;

    const pw = new Zotero.ProgressWindow();
    let proposals = [];
    try {
      pw.changeHeadline("Metadata Repair");
      pw.addDescription("Looking up " + targets.length + " item(s)…");
      pw.show();

      let built = [];
      try {
        built = await ZMR.resolver.buildProposalsForItems(targets);
      } catch (e) {
        ZMR.log("runRepair: buildProposalsForItems failed, falling back: " + e);
        built = [];
        for (const it of targets) {
          try { built.push(await ZMR.resolver.buildProposal(it)); }
          catch (e2) { ZMR.log("runRepair: buildProposal failed: " + e2); }
        }
      }

      proposals = (built || []).filter((p) =>
        p && p.fields && Object.keys(p.fields).length > 0);
    } finally {
      try { pw.startCloseTimer(2500); } catch (e) {}
    }

    if (!proposals.length) {
      ZMR.notify("No repairs proposed.");
      return;
    }

    const win = ZMR.mainWindow();
    let applied = 0;
    const total = proposals.length;

    for (let i = 0; i < proposals.length; i++) {
      const proposal = proposals[i];
      const item = Zotero.Items.getByLibraryAndKey(
        proposal.libraryID, proposal.itemKey);
      if (!item) continue;

      const io = {
        proposal,
        itemDisplayTitle: item.getField("title") || "(no title)",
        out: { approved: false, fieldsToApply: [], overwriteNonEmpty: {} },
        batch: total > 1 ? { index: i + 1, total } : undefined,
      };

      try {
        win.openDialog(DIALOG_URL, "zmr-diff",
          "chrome,dialog,modal,centerscreen,resizable", io);
      } catch (e) {
        ZMR.log("runRepair: openDialog failed: " + e);
        continue;
      }

      if (io.out.batchAction === "stop") break;
      if (!io.out.approved) continue;

      try {
        const res = await ZMR.writer.applyApproved(item, proposal, {
          fieldsToApply: io.out.fieldsToApply,
          overwriteNonEmpty: io.out.overwriteNonEmpty,
        });
        if (res && res.changed && res.changed.length) applied++;
      } catch (e) {
        ZMR.log("runRepair: applyApproved failed for " + proposal.itemKey + ": " + e);
      }
    }

    ZMR.notify("Repaired " + applied + " of " + total + ".");
  };

  // ---- test surface (always present) -------------------------------------
  function userLibID() { return Zotero.Libraries.userLibraryID; }

  function itemByKey(key) {
    return Zotero.Items.getByLibraryAndKey(userLibID(), key);
  }

  ZMR.test = {
    version: function () { return ZMR._version; },

    coreFieldsFor: function (itemType) {
      return ZMR.coreFields.applicableCoreFields(itemType);
    },

    findSampleItems: async function (opts) {
      opts = opts || {};
      const limit = Math.min(10, opts.limit || 6);
      const all = await Zotero.Items.getAll(userLibID(), true);
      const out = [];
      for (const it of all) {
        if (!isRegular(it)) continue;
        let hasDoi = false;
        try { hasDoi = !!(it.getField("DOI") || ""); } catch (e) {}
        if (opts.withDoi === true && !hasDoi) continue;
        if (opts.withDoi === false && hasDoi) continue;
        if (opts.missingField &&
          !ZMR.coreFields.isFieldMissing(it, opts.missingField)) continue;
        out.push({
          itemKey: it.key,
          itemID: it.id,
          itemType: it.itemType,
          title: it.getField("title") || "",
          hasDoi,
        });
        if (out.length >= limit) break;
      }
      return out;
    },

    buildProposal: function (itemKey) {
      const item = itemByKey(itemKey);
      return ZMR.resolver.buildProposal(item);
    },

    getReport: function () { return ZMR.report.getReport(); },

    applyApproved: async function (itemKey, proposal, decision) {
      const item = itemByKey(itemKey);
      return ZMR.writer.applyApproved(item, proposal, decision);
    },

    openDiffDialog: async function (itemKey, proposal) {
      const item = itemByKey(itemKey);
      const p = proposal || await ZMR.resolver.buildProposal(item);
      const io = {
        proposal: p,
        itemDisplayTitle: (item && item.getField("title")) || "(no title)",
        out: { approved: false, fieldsToApply: [], overwriteNonEmpty: {} },
      };
      ZMR.mainWindow().openDialog(DIALOG_URL, "zmr-diff",
        "chrome,dialog,modal,centerscreen,resizable", io);
    },
  };
})();
