/**
 * The deterministic compiler: ValidatedDesign -> tscircuit -> the four required
 * output files.
 *
 * Produces REAL FILES on disk (PROJECT_PLAN §0). Nothing here is "rendered only".
 *
 *   1. circuit   -> .svg   (our own symbol-based renderer)
 *   2. schematic -> .svg + .kicad_sch
 *   3. pcb       -> .kicad_pcb + gerbers + .drl (+ .svg)
 *   4. 3d        -> .glb
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { renderCircuitDiagram } from "../render/circuitDiagram.js";
import { collectTscircuitIssues } from "../design/tscircuitErrors.js";
import { assertPadIntegrity, assertNetsRealized } from "../design/assertions.js";
import { generateTscircuitSource } from "./toTscircuit.js";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function write(outDir, name, data) {
  const file = path.join(outDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  fs.writeFileSync(file, buffer);
  return {
    filename: name,
    path: file,
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
}

/**
 * @param {object} params
 * @param {object} params.upstream de-duplicated upstream design
 * @param {Array} params.resolvedComponents from resolver
 * @param {string} params.outDir
 * @returns {Promise<object>} compile result incl. artifacts + assertions
 */
export async function compileDesign({ upstream, resolvedComponents, outDir }) {
  fs.mkdirSync(outDir, { recursive: true });

  const artifacts = {};
  const notes = [];

  // --- 1. circuit diagram — independent of tscircuit ----------------------
  // Rendered from the design itself, so it exists even if compilation fails.
  artifacts.circuit = {
    kind: "circuit",
    format: "svg",
    ...write(outDir, "circuit-diagram.svg", renderCircuitDiagram(upstream)),
  };

  // --- compile -------------------------------------------------------------
  const { source, pinMaps } = generateTscircuitSource(upstream, resolvedComponents);
  write(outDir, "generated.tsx", source);

  const { CircuitRunner } = await import("@tscircuit/eval");
  const runner = new CircuitRunner();

  const startedAt = Date.now();
  await runner.execute(source);
  await runner.renderUntilSettled();
  const circuitJson = await runner.getCircuitJson();
  const compileMs = Date.now() - startedAt;

  write(outDir, "circuit.json", JSON.stringify(circuitJson, null, 2));

  // --- ingest tscircuit's own errors --------------------------------------
  const issues = collectTscircuitIssues(circuitJson);

  // --- independent assertions (do NOT trust silence) ----------------------
  const expectedPads = new Map();
  for (const component of resolvedComponents) {
    const expected = component.resolution.pads.expectedCount;
    if (typeof expected === "number") expectedPads.set(component.ref_id, expected);
  }
  const padCheck = assertPadIntegrity(circuitJson, expectedPads);
  const netCheck = assertNetsRealized(circuitJson, {
    nets: upstream.nets ?? [],
  });

  // --- 2. schematic --------------------------------------------------------
  const { convertCircuitJsonToSchematicSvg, convertCircuitJsonToPcbSvg } = await import(
    "circuit-to-svg"
  );
  artifacts.schematic = {
    kind: "schematic",
    format: "svg",
    ...write(outDir, "schematic.svg", convertCircuitJsonToSchematicSvg(circuitJson)),
    additional: [],
  };

  try {
    const { CircuitJsonToKicadSchConverter } = await import("circuit-json-to-kicad");
    const converter = new CircuitJsonToKicadSchConverter(circuitJson);
    converter.runUntilFinished();
    artifacts.schematic.additional.push(
      write(outDir, "schematic.kicad_sch", converter.getOutputString())
    );
  } catch (error) {
    notes.push(`kicad_sch export failed: ${error.message}`);
  }

  // --- 3. PCB --------------------------------------------------------------
  const { CircuitJsonToKicadPcbConverter } = await import("circuit-json-to-kicad");
  const pcbConverter = new CircuitJsonToKicadPcbConverter(circuitJson);
  pcbConverter.runUntilFinished();

  artifacts.pcb = {
    kind: "pcb",
    format: "kicad_pcb",
    ...write(outDir, "board.kicad_pcb", pcbConverter.getOutputString()),
    additional: [write(outDir, "pcb.svg", convertCircuitJsonToPcbSvg(circuitJson))],
  };

  try {
    const {
      convertSoupToGerberCommands,
      stringifyGerberCommandLayers,
      convertSoupToExcellonDrillCommands,
      stringifyExcellonDrill,
    } = await import("circuit-json-to-gerber");

    const layers = stringifyGerberCommandLayers(convertSoupToGerberCommands(circuitJson));
    for (const [layerName, text] of Object.entries(layers)) {
      artifacts.pcb.additional.push(write(outDir, `gerbers/${layerName}.gbr`, text));
    }
    artifacts.pcb.additional.push(
      write(
        outDir,
        "gerbers/plated.drl",
        stringifyExcellonDrill(
          convertSoupToExcellonDrillCommands({ circuitJson, is_plated: true })
        )
      )
    );
  } catch (error) {
    notes.push(`gerber export failed: ${error.message}`);
  }

  // --- 4. 3D ---------------------------------------------------------------
  const cadComponents = circuitJson.filter((el) => el.type === "cad_component");
  try {
    const { convertCircuitJsonToGltf } = await import("circuit-json-to-gltf");
    const glb = await convertCircuitJsonToGltf(circuitJson, { format: "glb" });
    const buffer = Buffer.from(glb);
    const magic = buffer.subarray(0, 4).toString("ascii");
    if (magic !== "glTF") throw new Error(`bad glb magic "${magic}"`);

    artifacts.model3d = {
      kind: "model3d",
      format: "glb",
      ...write(outDir, "board.glb", buffer),
      cadComponentCount: cadComponents.length,
    };
  } catch (error) {
    notes.push(`glb export failed: ${error.message}`);
  }

  // --- netlist (the connectivity companion to the circuit diagram) --------
  try {
    const mod = await import("circuit-json-to-readable-netlist");
    const fn = mod.convertCircuitJsonToReadableNetlist ?? mod.default;
    artifacts.circuit.additional = [write(outDir, "netlist.txt", fn(circuitJson))];
  } catch (error) {
    notes.push(`netlist export failed: ${error.message}`);
  }

  const allErrors = [...issues.errors, ...padCheck.errors, ...netCheck.errors];

  return {
    artifacts,
    circuitJson,
    pinMaps,
    compileMs,
    tscircuitIssues: issues,
    assertions: {
      padIntegrity: padCheck,
      netsRealized: netCheck,
      passed: padCheck.ok && netCheck.ok,
    },
    errors: allErrors,
    notes,
    stats: {
      elements: circuitJson.length,
      pads: circuitJson.filter(
        (el) => el.type === "pcb_smtpad" || el.type === "pcb_plated_hole"
      ).length,
      traces: circuitJson.filter((el) => el.type === "pcb_trace").length,
      cadComponents: cadComponents.length,
    },
  };
}
