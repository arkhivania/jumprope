let instance;
let memory;
let exports;

self.onmessage = async (event) => {
  try {
    if (event.data.type === "init") {
      await initialize(event.data.bytes);
    } else if (event.data.type === "event") {
      dispatchEvent(event.data.event);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "WASM module failed." });
  }
};

async function initialize(bytes) {
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length !== 0) {
    throw new Error("WASM modules must not import host functions or memory.");
  }

  instance = await WebAssembly.instantiate(module, {});
  exports = instance.exports;
  memory = exports.memory;
  if (!(memory instanceof WebAssembly.Memory) ||
      typeof exports.ui_ptr !== "function" ||
      typeof exports.ui_len !== "function" ||
      typeof exports.alloc !== "function" ||
      typeof exports.handle_event !== "function" ||
      typeof exports.is_complete !== "function" ||
      typeof exports.result_ptr !== "function" ||
      typeof exports.result_len !== "function") {
    throw new Error("WASM module does not implement the Jumprope event-driven UI ABI.");
  }

  self.postMessage({ type: "ready", ui: readUi() });
}

function dispatchEvent(input) {
  const inputBytes = new TextEncoder().encode(input);
  if (inputBytes.length > 64 * 1024) {
    throw new Error("WASM event exceeds the 64 KB limit.");
  }

  const pointer = exports.alloc(inputBytes.length) >>> 0;
  ensureRange(pointer, inputBytes.length);
  new Uint8Array(memory.buffer, pointer, inputBytes.length).set(inputBytes);
  exports.handle_event(pointer, inputBytes.length);
  if (exports.is_complete() !== 0) {
    self.postMessage({ type: "result", result: readJson(exports.result_ptr(), exports.result_len(), 64 * 1024) });
  } else {
    self.postMessage({ type: "update", ui: readUi() });
  }
}

function readUi() {
  return readJson(exports.ui_ptr(), exports.ui_len(), 64 * 1024);
}

function readJson(pointerValue, lengthValue, maxLength) {
  const pointer = pointerValue >>> 0;
  const length = lengthValue >>> 0;
  if (length > maxLength) {
    throw new Error("WASM JSON output exceeds the 64 KB limit.");
  }
  ensureRange(pointer, length);
  const bytes = new Uint8Array(memory.buffer, pointer, length);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function ensureRange(pointer, length) {
  if (!memory || pointer + length > memory.buffer.byteLength) {
    throw new Error("WASM module returned an invalid memory range.");
  }
}
