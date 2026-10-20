import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

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

const displayBytes = await readFile(new URL("./fixtures/display-only.wasm", import.meta.url));
const displayModule = await WebAssembly.compile(displayBytes);
assert.deepEqual(WebAssembly.Module.imports(displayModule), [], "display-only WASM must not import host capabilities");
const displayExports = WebAssembly.Module.exports(displayModule).map((entry) => entry.name);
for (const name of ["memory", "ui_len", "ui_ptr"]) {
  assert.ok(displayExports.includes(name), `display-only module is missing ${name}`);
}
for (const name of ["alloc", "handle_event", "is_complete", "result_ptr", "result_len"]) {
  assert.ok(!displayExports.includes(name), `display-only module should not need ${name}`);
}
const displayInstance = await WebAssembly.instantiate(displayModule, {});
const displayWasm = displayInstance.exports;
const displayUi = JSON.parse(new TextDecoder().decode(
  new Uint8Array(displayWasm.memory.buffer, displayWasm.ui_ptr(), displayWasm.ui_len())
));
assert.equal(displayUi.root.children[0].value, "This fixture only displays content.");

const workerSource = await readFile(new URL("../src/Jumprope.Server/wwwroot/wasm-worker.js", import.meta.url), "utf8");
const workerMessages = [];
const workerSelf = { postMessage: (message) => workerMessages.push(message) };
const workerContext = {
  self: workerSelf,
  WebAssembly,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  JSON,
  Error
};
runInNewContext(workerSource, workerContext);
await workerSelf.onmessage({ data: { type: "init", bytes: displayBytes, interactive: false } });
assert.equal(workerMessages[0].type, "ready");
assert.equal(workerMessages[0].ui.title, "Static WASM UI");

console.log("Display-only WASM contract passed.");
