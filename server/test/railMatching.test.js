/**
 * Phase 6 Group A — rail matching.
 *
 * Two behaviours, and the second matters more than the first:
 *   1. A logical rail matches a numbered pin of the same rail (GND -> GND1).
 *   2. Separate rails are NOT treated as aliases. `VDDA` is the analog supply,
 *      not a VDD alias; wiring digital VDD to it is an electrical error that
 *      renders perfectly and fails in hardware.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { matchLogicalPin } from "../src/design/pinout.js";

const pinout = (pins) => ({ ok: true, pins });

test("GND matches GND1 when the rail is split across numbered pins", () => {
  // RF-BM-2340A2I: GND1..GND5, no bare GND.
  const result = matchLogicalPin("GND", pinout({ GND1: "pin1", VCC: "pin2", GND2: "pin8" }));
  assert.equal(result.ok, true);
  assert.equal(result.pad, "pin1");
  assert.equal(result.via, "numbered_rail");
});

test("the lowest-numbered pin of a rail is chosen, deterministically", () => {
  const pins = { GND10: "pinA", GND2: "pinB", GND1: "pinC" };
  assert.equal(matchLogicalPin("GND", pinout(pins)).pad, "pinC");
  // Numeric, not lexicographic: GND10 must not sort before GND2.
  const noOne = { GND10: "pinA", GND2: "pinB" };
  assert.equal(matchLogicalPin("GND", pinout(noOne)).pad, "pinB");
});

test("GND reaches VSS1 through the equivalent rail plus numbering", () => {
  // FS32K116LFT0MLFT: VSS1/VSS2, no GND and no bare VSS.
  const result = matchLogicalPin("GND", pinout({ VDD1: "pin5", VSS1: "pin7", VSS2: "pin30" }));
  assert.equal(result.ok, true);
  assert.equal(result.pad, "pin7");
  assert.equal(result.matchedName, "VSS1");
});

test("VDD prefers VDD1 over VDDA — the analog supply is a different rail", () => {
  // The bug this fixes: VDD previously matched VDDA (pin6) while VDD1 (pin5) existed.
  const result = matchLogicalPin(
    "VDD",
    pinout({ VDD1: "pin5", VDDA: "pin6", VSS1: "pin7", VDD2: "pin31" })
  );
  assert.equal(result.pad, "pin5", "must pick the digital supply VDD1");
  assert.notEqual(result.matchedName, "VDDA");
});

test("VDDA alone is NOT accepted as a VDD match", () => {
  const result = matchLogicalPin("VDD", pinout({ VDDA: "pin6", VSS1: "pin7" }));
  assert.equal(result.ok, false, "an analog-only supply must not satisfy a digital VDD");
});

test("VIN is not a VDD alias", () => {
  // TP4110 (charger) exposes VIN and no VDD. The honest answer is PIN_NOT_FOUND,
  // not the input supply pin.
  const result = matchLogicalPin("VDD", pinout({ GND: "pin3", VIN: "pin16", V1: "pin8" }));
  assert.equal(result.ok, false);
});

test("AGND and DGND are not generic ground aliases", () => {
  for (const pins of [{ AGND: "pin1" }, { DGND: "pin1" }, { GNDA: "pin1" }]) {
    assert.equal(
      matchLogicalPin("GND", pinout(pins)).ok,
      false,
      `${Object.keys(pins)[0]} is a separate ground domain`
    );
  }
});

test("numbered suffixes on SIGNAL pins are never treated as aliases", () => {
  // DIO11 is not "DIO", OUT3 is not "OUT" — a numbered signal is a different signal.
  assert.equal(matchLogicalPin("DIO", pinout({ DIO11: "pin7", DIO12: "pin8" })).ok, false);
  assert.equal(matchLogicalPin("OUT", pinout({ OUT0: "pin1", OUT1: "pin2" })).ok, false);
  assert.equal(matchLogicalPin("TX", pinout({ TX1: "pin4" })).ok, false);
});

test("exact match still wins over any rail rule", () => {
  const result = matchLogicalPin("GND", pinout({ GND: "pin8", GND1: "pin1", VSS: "pin9" }));
  assert.equal(result.pad, "pin8");
  assert.equal(result.via, "exact");
});

test("VCC and VDD remain interchangeable", () => {
  assert.equal(matchLogicalPin("VDD", pinout({ VCC: "pin8" })).pad, "pin8");
  assert.equal(matchLogicalPin("VCC", pinout({ VDD: "pin2" })).pad, "pin2");
});
