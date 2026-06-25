/* Zotero Metadata Repair - writer
 *
 * Applies an approved subset of a Proposal onto a real Zotero item.
 * Loaded (via loadSubScript) into the shared ZMR scope AFTER core-fields.js
 * and resolver.js, so `ZMR` already exists with its consts + helpers.
 *
 * Hard safety rules (see CONTRACTS.md "WRITER"):
 *   - NEVER blank an existing value. `blanked` is ALWAYS [].
 *   - itemType is written FIRST (via setType) so later field writes are
 *     validated against the new type.
 *   - creators is all-or-nothing (setCreators with the full array).
 *   - Every scalar write is guarded by Zotero.ItemFields.isValidForType and
 *     wrapped in try/catch, so one bad field can't abort the rest.
 *   - One saveTx at the end (skipped when nothing actually changed).
 */

ZMR.writer = (function () {
  /**
   * Resolve the Zotero field name to use for a core key on this item, with the
   * per-type helpers taking precedence over the generic resolver.
   * @param {string} key
   * @param {Object} item
   * @returns {string|null}
   */
  function zoteroFieldFor(key, item) {
    const cf = ZMR.coreFields;
    if (key === "doi") return "DOI";
    if (key === "container") return cf.containerFieldFor(item.itemType);
    if (key === "publisher") {
      return cf.publisherFieldFor(item.itemType) ||
        cf.zoteroFieldFor("publisher", item);
    }
    return cf.zoteroFieldFor(key, item) || key;
  }

  /**
   * True when `name` is a real, type-valid Zotero field for this item.
   * @param {string} name
   * @param {Object} item
   * @returns {boolean}
   */
  function isValidField(name, item) {
    try {
      if (!name) return false;
      const id = Zotero.ItemFields.getID(name);
      if (!id) return false;
      return Zotero.ItemFields.isValidForType(id, item.itemTypeID);
    } catch (e) {
      return false;
    }
  }

  /**
   * Apply the approved fields of a proposal onto an item.
   *
   * @param {Object} item     The Zotero item to mutate.
   * @param {Object} proposal A Proposal (object-keyed `fields`).
   * @param {{fieldsToApply:String[], overwriteNonEmpty:Object}} decision
   * @returns {Promise<{changed:String[], skipped:String[], blanked:String[]}>}
   */
  async function applyApproved(item, proposal, decision) {
    const changed = [];
    const skipped = [];
    const blanked = []; // contract: ALWAYS [].

    if (!item || !proposal || !proposal.fields || !decision) {
      return { changed, skipped, blanked };
    }

    const fields = proposal.fields;
    const overwrite = decision.overwriteNonEmpty || {};
    const requested = new Set(decision.fieldsToApply || []);

    // Walk in frozen CORE order so itemType is handled first.
    const order = (ZMR.coreFields && ZMR.coreFields.KEYS) ||
      ["itemType", "creators", "date", "container", "publisher", "place", "doi"];

    for (const key of order) {
      if (!requested.has(key)) continue;

      const f = fields[key];
      if (!f) continue; // not in proposal -> nothing to do.

      // Overwrite guard: a non-empty target needs an explicit allow.
      if (f.willFill === false && overwrite[key] !== true) {
        skipped.push(key);
        continue;
      }

      // NEVER blank: refuse empty proposed values outright.
      const proposedEmpty = (key === "creators")
        ? !(Array.isArray(f.proposed) && f.proposed.length > 0)
        : (f.proposed === undefined || f.proposed === null || f.proposed === "");
      if (proposedEmpty) {
        skipped.push(key);
        continue;
      }

      try {
        if (key === "itemType") {
          const typeID = Zotero.ItemTypes.getID(f.proposed);
          if (!typeID || item.itemType === f.proposed) {
            // Unknown type, or already this type (idempotent): nothing to do.
            if (!typeID) skipped.push(key);
            continue;
          }
          item.setType(typeID);
          changed.push(key);
          continue;
        }

        if (key === "creators") {
          item.setCreators(f.proposed);
          changed.push(key);
          continue;
        }

        // doi / container / publisher / date / place -> scalar setField.
        const name = zoteroFieldFor(key, item);
        if (!isValidField(name, item)) {
          skipped.push(key);
          continue;
        }
        if (String(item.getField(name) || "") === String(f.proposed)) {
          // Already equal (idempotent re-apply): no change, no save churn.
          continue;
        }
        item.setField(name, f.proposed);
        changed.push(key);
      } catch (e) {
        ZMR.log("writer: failed to apply '" + key + "': " + e);
        skipped.push(key);
      }
    }

    if (changed.length > 0) {
      try {
        await item.saveTx({ skipDateModifiedUpdate: true });
      } catch (e) {
        ZMR.log("writer: saveTx failed: " + e);
        throw e;
      }
    }

    return { changed, skipped, blanked };
  }

  return { applyApproved };
})();
