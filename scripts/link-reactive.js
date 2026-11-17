// Makes `@reactive/src/...` imports resolve to the pinned reactive-lib-omni submodule.
// Hardhat treats `@reactive/src` as the package name, so node_modules/@reactive/src is a real
// package folder with its own package.json and links to the submodule's source directories.
// The submodule itself is left untouched.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcTarget = path.join(root, "vendor", "reactive-lib-omni", "src");
const pkgDir = path.join(root, "node_modules", "@reactive", "src");

if (!fs.existsSync(srcTarget)) {
  console.error("reactive-lib-omni submodule missing. Run: git submodule update --init");
  process.exit(1);
}
fs.rmSync(path.join(root, "node_modules", "@reactive"), { recursive: true, force: true });
fs.mkdirSync(pkgDir, { recursive: true });
fs.writeFileSync(
  path.join(pkgDir, "package.json"),
  JSON.stringify({ name: "@reactive/src", version: "3ade0dc" }, null, 2)
);
for (const entry of fs.readdirSync(srcTarget)) {
  const from = path.join(srcTarget, entry);
  if (fs.statSync(from).isDirectory()) {
    fs.symlinkSync(from, path.join(pkgDir, entry), "dir");
  }
}
console.log("linked @reactive/src ->", srcTarget);
