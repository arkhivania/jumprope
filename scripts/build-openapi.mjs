import { copyFile, readFile, writeFile } from "node:fs/promises";

const templatePath = new URL("../openapi.template.json", import.meta.url);
const skillPath = new URL("../skill.md", import.meta.url);
const outputPath = new URL("../src/Jumprope.Server/wwwroot/openapi.json", import.meta.url);
const skillOutputPath = new URL("../src/Jumprope.Server/wwwroot/skill.md", import.meta.url);
const wasmInteropPath = new URL("../wasm_interop.md", import.meta.url);
const wasmInteropOutputPath = new URL("../src/Jumprope.Server/wwwroot/wasm_interop.md", import.meta.url);

const [templateText, skill] = await Promise.all([
  readFile(templatePath, "utf8"),
  readFile(skillPath, "utf8")
]);

const document = JSON.parse(templateText);
document.info.description = skill;
document.info["x-agent-skill"] = skill;

await Promise.all([
  writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`),
  copyFile(skillPath, skillOutputPath),
  copyFile(wasmInteropPath, wasmInteropOutputPath)
]);

console.log("Generated OpenAPI document with embedded agent skill.");
