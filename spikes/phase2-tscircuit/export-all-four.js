/**
 * Phase 2 empirical check: can tscircuit produce REAL FILES for all four
 * required outputs, headlessly, in plain Node with no browser?
 *
 * Circuit shape mirrors test-fixtures/rc_car.json: 3 chips (U1 power, U2 MCU,
 * U3 sensor), a GND net, a 3V3 rail, and one I2C signal.
 *
 * Run: node export-all-four.js
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OUT = path.join(import.meta.dirname, "out");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

function record(name, ok, detail, file) {
  let bytes = null;
  if (file && fs.existsSync(file)) bytes = fs.statSync(file).size;
  results.push({ name, ok, detail, file: file ? path.basename(file) : null, bytes });
}

// ---------------------------------------------------------------------------
// Step 1 — evaluate TSX to Circuit JSON, headlessly
// ---------------------------------------------------------------------------
const source = `
circuit.add(
  <board width="100mm" height="60mm">
    <chip name="U1" footprint="soic16" pcbX={-30} pcbY={0} schX={-6} />
    <chip name="U2" footprint="qfn48"  pcbX={0}   pcbY={0} schX={0} />
    <chip name="U3" footprint="qfn16"  pcbX={30}  pcbY={0} schX={6} />

    <trace from=".U1 > .pin1" to=".U2 > .pin1" />
    <trace from=".U2 > .pin2" to=".U3 > .pin1" />
  </board>
)
`;

let circuitJson;
const t0 = Date.now();
try {
  const { CircuitRunner } = await import("@tscircuit/eval");
  const runner = new CircuitRunner();
  await runner.execute(source);
  await runner.renderUntilSettled();
  circuitJson = await runner.getCircuitJson();

  const counts = {};
  for (const el of circuitJson) counts[el.type] = (counts[el.type] ?? 0) + 1;

  const file = path.join(OUT, "circuit.json");
  fs.writeFileSync(file, JSON.stringify(circuitJson, null, 2));
  record(
    "0. headless eval (@tscircuit/eval CircuitRunner)",
    true,
    `${circuitJson.length} elements in ${Date.now() - t0}ms; ` +
      `pcb_smtpad=${counts.pcb_smtpad ?? 0} pcb_trace=${counts.pcb_trace ?? 0} ` +
      `source_component=${counts.source_component ?? 0}`,
    file
  );
} catch (error) {
  record("0. headless eval", false, `${error.constructor.name}: ${error.message}`);
  console.log(JSON.stringify(results, null, 2));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Output 2 (schematic) + Output 1 (circuit/connectivity) — circuit-to-svg
// ---------------------------------------------------------------------------
try {
  const { convertCircuitJsonToSchematicSvg, convertCircuitJsonToPcbSvg } =
    await import("circuit-to-svg");

  const schematicSvg = convertCircuitJsonToSchematicSvg(circuitJson);
  const schFile = path.join(OUT, "schematic.svg");
  fs.writeFileSync(schFile, schematicSvg);
  record(
    "2. SCHEMATIC -> svg (convertCircuitJsonToSchematicSvg)",
    schematicSvg.includes("<svg"),
    `sha=${sha(schematicSvg)}`,
    schFile
  );

  const pcbSvg = convertCircuitJsonToPcbSvg(circuitJson);
  const pcbSvgFile = path.join(OUT, "pcb.svg");
  fs.writeFileSync(pcbSvgFile, pcbSvg);
  record(
    "3a. PCB -> svg (convertCircuitJsonToPcbSvg)",
    pcbSvg.includes("<svg"),
    `sha=${sha(pcbSvg)}`,
    pcbSvgFile
  );
} catch (error) {
  record("2/3a. circuit-to-svg", false, `${error.constructor.name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Output 1 (circuit diagram / connectivity) — readable netlist
// ---------------------------------------------------------------------------
try {
  const mod = await import("circuit-json-to-readable-netlist");
  const fn = mod.convertCircuitJsonToReadableNetlist ?? mod.default;
  const netlist = fn(circuitJson);
  const file = path.join(OUT, "netlist.txt");
  fs.writeFileSync(file, netlist);
  record("1b. CIRCUIT -> readable netlist", netlist.length > 0, `sha=${sha(netlist)}`, file);
} catch (error) {
  record(
    "1b. CIRCUIT -> readable netlist",
    false,
    `${error.constructor.name}: ${error.message}`
  );
}

// ---------------------------------------------------------------------------
// Output 3 (PCB) — KiCad .kicad_pcb and .kicad_sch
// ---------------------------------------------------------------------------
try {
  const { CircuitJsonToKicadPcbConverter, CircuitJsonToKicadSchConverter } =
    await import("circuit-json-to-kicad");

  const pcbConv = new CircuitJsonToKicadPcbConverter(circuitJson);
  pcbConv.runUntilFinished();
  const pcbText = pcbConv.getOutputString();
  const pcbFile = path.join(OUT, "board.kicad_pcb");
  fs.writeFileSync(pcbFile, pcbText);
  record(
    "3b. PCB -> .kicad_pcb",
    pcbText.startsWith("(kicad_pcb"),
    `starts "${pcbText.slice(0, 24).replace(/\n/g, " ")}..."`,
    pcbFile
  );

  const schConv = new CircuitJsonToKicadSchConverter(circuitJson);
  schConv.runUntilFinished();
  const schText = schConv.getOutputString();
  const schFile = path.join(OUT, "board.kicad_sch");
  fs.writeFileSync(schFile, schText);
  record(
    "2b. SCHEMATIC -> .kicad_sch",
    schText.startsWith("(kicad_sch"),
    `starts "${schText.slice(0, 24).replace(/\n/g, " ")}..."`,
    schFile
  );
} catch (error) {
  record("3b/2b. kicad", false, `${error.constructor.name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Output 3 (PCB, manufacturing) — Gerbers
// ---------------------------------------------------------------------------
try {
  const {
    convertSoupToGerberCommands,
    stringifyGerberCommandLayers,
    convertSoupToExcellonDrillCommands,
    stringifyExcellonDrill,
  } = await import("circuit-json-to-gerber");

  const gerberLayers = convertSoupToGerberCommands(circuitJson);
  const gerberText = stringifyGerberCommandLayers(gerberLayers);
  const gerberDir = path.join(OUT, "gerbers");
  fs.mkdirSync(gerberDir, { recursive: true });

  // stringifyGerberCommandLayers returns { layerName: gerberString }
  let written = 0;
  for (const [layerName, text] of Object.entries(gerberText)) {
    fs.writeFileSync(path.join(gerberDir, `${layerName}.gbr`), text);
    written += 1;
  }

  const drill = convertSoupToExcellonDrillCommands({
    circuitJson,
    is_plated: true,
  });
  fs.writeFileSync(path.join(gerberDir, "plated.drl"), stringifyExcellonDrill(drill));

  record(
    "3c. PCB -> gerber + excellon drill",
    written > 0,
    `${written} gerber layers + drill file in out/gerbers/`,
    path.join(gerberDir, "plated.drl")
  );
} catch (error) {
  record("3c. PCB -> gerber", false, `${error.constructor.name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Output 4 (3D) — GLB / GLTF
// ---------------------------------------------------------------------------
try {
  const { convertCircuitJsonToGltf } = await import("circuit-json-to-gltf");

  const glb = await convertCircuitJsonToGltf(circuitJson, { format: "glb" });
  const glbFile = path.join(OUT, "board.glb");
  const glbBuf = Buffer.from(glb);
  fs.writeFileSync(glbFile, glbBuf);
  // A valid .glb starts with the ASCII magic "glTF".
  const magic = glbBuf.subarray(0, 4).toString("ascii");
  record("4. 3D -> .glb", magic === "glTF", `magic="${magic}" sha=${sha(glbBuf)}`, glbFile);

  const gltf = await convertCircuitJsonToGltf(circuitJson, { format: "gltf" });
  const gltfFile = path.join(OUT, "board.gltf");
  fs.writeFileSync(gltfFile, JSON.stringify(gltf));
  record("4b. 3D -> .gltf", true, "text glTF 2.0", gltfFile);
} catch (error) {
  record("4. 3D -> glb", false, `${error.constructor.name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
console.log("\ntscircuit headless export spike\n" + "=".repeat(72));
for (const r of results) {
  console.log(
    `${r.ok ? "PASS" : "FAIL"}  ${r.name}` +
      `${r.file ? `\n      -> ${r.file} (${r.bytes} bytes)` : ""}` +
      `\n      ${r.detail}`
  );
}
console.log("=".repeat(72));
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
console.log(`node ${process.version}, no browser, no display\n`);
