/* Zotero Metadata Repair - bootstrap entry point
 *
 * Modern Zotero 7/8/9 bootstrapped plugin. No XUL overlay, no install.rdf.
 * All real logic lives in lib/*.js, loaded into this same scope via
 * loadSubScript so the single `ZMR` namespace they build is visible here.
 *
 * Load order is LOAD-BEARING:
 *   core-fields.js (creates `var ZMR = {}` + shared consts/helpers) MUST be first;
 *   ui-menu.js (lifecycle + orchestration + test hooks) MUST be last.
 */

var ZMR;

function log(msg) {
  Zotero.debug("[MetaDataRepair/bootstrap] " + msg);
}

async function startup({ id, version, rootURI }, reason) {
  await Zotero.initializationPromise;
  Services.scriptloader.loadSubScript(rootURI + "lib/core-fields.js");
  Services.scriptloader.loadSubScript(rootURI + "lib/resolver.js");
  Services.scriptloader.loadSubScript(rootURI + "lib/writer.js");
  Services.scriptloader.loadSubScript(rootURI + "lib/ui-menu.js");
  try {
    await ZMR.init({ id, version, rootURI });
    log("started v" + version);
  } catch (e) {
    log("startup error: " + e + "\n" + (e && e.stack));
  }
}

function onMainWindowLoad({ window }) {
  if (ZMR) ZMR.addToWindow(window);
}

function onMainWindowUnload({ window }) {
  if (ZMR) ZMR.removeFromWindow(window);
}

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) return;
  if (ZMR) {
    try { ZMR.shutdown(); } catch (e) { log("shutdown error: " + e); }
  }
  ZMR = undefined;
}

function install() {}
function uninstall() {}
