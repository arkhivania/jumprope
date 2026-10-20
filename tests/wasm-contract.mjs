import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bytes = await readFile(new URL("./fixtures/event-driven-ui.wasm", import.meta.url));
const module = await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), [], "the module must not import host capabilities");

const instance = await WebAssembly.instantiate(module, {});
const wasm = instance.exports;
for (const name of ["memory", "alloc", "ui_ptr", "ui_len", "handle_event", "is_complete", "result_ptr", "result_len"]) {
  assert.ok(name in wasm, `missing Jumprope ABI export: ${name}`);
}

function readJson(pointer, length) {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, pointer, length)));
}

function dispatch(event) {
  const input = new TextEncoder().encode(JSON.stringify(event));
  const pointer = wasm.alloc(input.length);
  new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
  wasm.handle_event(pointer, input.length);
}

const initialUi = readJson(wasm.ui_ptr(), wasm.ui_len());
assert.equal(initialUi.version, 1);
assert.equal(initialUi.root.type, "column");
const cards = initialUi.root.children[1].children;
assert.equal(cards.length, 3);
assert.ok(cards.every((card) => card.type === "button" && card.children[0].type === "svg"));
assert.equal(initialUi.root.children[2].type, "checkbox");
assert.equal(wasm.is_complete(), 0);

dispatch({ type: "pointerenter", target: "hearts" });
let updatedUi = readJson(wasm.ui_ptr(), wasm.ui_len());
assert.equal(updatedUi.root.children[1].children[1].children[0].children[0].stroke, "#435ff0");
dispatch({ type: "pointerleave", target: "hearts" });
updatedUi = readJson(wasm.ui_ptr(), wasm.ui_len());
assert.equal(updatedUi.root.children[1].children[1].children[0].children[0].stroke, "#aab2c0");

dispatch({ type: "click", target: "submit" });
assert.equal(wasm.is_complete(), 0, "submission must wait for a selected and confirmed card");

dispatch({ type: "click", target: "hearts" });
updatedUi = readJson(wasm.ui_ptr(), wasm.ui_len());
assert.equal(updatedUi.root.children[1].children[1].selected, true);
assert.equal(updatedUi.root.children[3].disabled, true);

dispatch({ type: "change", target: "confirm", checked: true });
updatedUi = readJson(wasm.ui_ptr(), wasm.ui_len());
assert.equal(updatedUi.root.children[2].checked, true);
assert.equal(updatedUi.root.children[3].disabled, false);

dispatch({ type: "click", target: "submit" });
assert.equal(wasm.is_complete(), 1);
assert.deepEqual(readJson(wasm.result_ptr(), wasm.result_len()), { selectedCard: "king-hearts" });

console.log("Event-driven WASM UI fixture contract passed.");
