/**
 * Build the net shape `resolveComponents()` actually wants.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * Every script consumer flattened normalized nets back into v1-style strings:
 *
 *     connections: net.members.map((m) => `${m.ref_id}.${m.logicalPin}`)
 *
 * For schema 2.0 that is wrong in a way that silently destroys the measurement.
 * v2 asserts NO pin name (D-076): `validatedDesign.js` sets `pin: null` and
 * carries the declared `role` alongside, so the template produced the literal
 * string `"U1.null"` for EVERY member, discarding `role` entirely. The resolver
 * then dutifully tried to resolve a pin named "null" on every part -- which no
 * part in any catalogue has.
 *
 * The result was one guaranteed error per component on every v2 design,
 * independent of which part was selected. Which error code you got was decided
 * purely by the part's naming completeness: PART_CAPABILITY_MISMATCH when the
 * pin set was complete ("contains no null"), PIN_NOT_FOUND when it was not
 * ("absence of null is not confirmed"). That correlation was 10/10 on the run
 * that exposed it.
 *
 * WHY NO PRODUCTION CODE CHANGES
 * ------------------------------
 * `resolveComponents()` already supports role-based nets -- it switches to
 * `pinRequestsByRef()` whenever a net carries a `members` array. The consumers
 * were destroying that array before handing it over. `resolveComponents` is
 * called ONLY from server/scripts/ (jobs.js:68 deliberately does not call it,
 * and Phase 10 is unstarted), so this defect never reached the product path --
 * but it invalidated every Phase 5 measurement taken through the harness.
 *
 * @param {object} upstream the raw fixture/design document
 * @param {object} validatedDesign `buildValidatedDesign(upstream).design`
 * @param {(payload: object) => boolean} isSchemaV2
 * @returns {Array<object>} nets carrying `members`, for resolveComponents
 */
export function resolverNets(upstream, validatedDesign, isSchemaV2) {
  // Taken from the VALIDATED design, not raw upstream, so net de-duplication
  // still applies. `roleIsDeclared` comes from the document's schema version --
  // it must be true only when upstream actually stated a role, never inferred
  // from a pin name we fabricated (normalizeUpstream.js:26).
  const declared = isSchemaV2(upstream);
  return (validatedDesign.nets ?? []).map((net) => ({
    name: net.name,
    net_class: net.net_class,
    interface: net.interface ?? null,
    members: (net.members ?? []).map((member) => ({
      ref_id: member.ref_id,
      role: member.role ?? null,
      logicalPin: member.logicalPin ?? null,
      roleIsDeclared: declared,
    })),
  }));
}

/**
 * The v1-style `connections` shape, which the COMPILER still requires.
 *
 * `toTscircuit.js` traces nets by splitting "REF.PIN" strings, so run-poc and
 * run-modification need this alongside the role-based nets above. Kept separate
 * and named so the two shapes are never confused again.
 *
 * NOTE: for schema 2.0 this still yields "REF.null", because the compiler has
 * no role-aware path. That is a real limitation of the compile step, not of
 * resolution, and is deliberately NOT addressed here -- it lives in
 * server/src/compile/, outside this harness fix.
 */
export function compilerNets(validatedDesign) {
  return (validatedDesign.nets ?? []).map((net) => ({
    name: net.name,
    net_class: net.net_class,
    connections: (net.members ?? []).map((m) => `${m.ref_id}.${m.logicalPin}`),
  }));
}
