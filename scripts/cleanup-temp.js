#!/usr/bin/env node
/**
 * cleanup-temp.js
 * Remove everything inside the Temp folder, keep the Temp folder itself.
 *
 * Usage:
 *   node cleanup-temp.js [projectRoot]
 * Default projectRoot:
 *   C:\Users\user\Documents\NewManCollectionList
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, "..");
const projectRoot = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
const tempDir = path.join(projectRoot, "Temp");

function info(m){ console.log("[INFO] " + m); }
function warn(m){ console.warn("[WARN] " + m); }
function err (m){ console.error("[ERR ] " + m); }

function rmrf(p){
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) {
      rmrf(path.join(p, name));
    }
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

try {
  info("Project root: " + projectRoot);
  if (!fs.existsSync(tempDir)) {
    warn("Temp does not exist: " + tempDir);
    process.exit(0);
  }

  const entries = fs.readdirSync(tempDir);
  if (entries.length === 0) {
    info("Temp is already empty: " + tempDir);
    process.exit(0);
  }

  for (const name of entries) {
    const p = path.join(tempDir, name);
    try {
      const isDir = fs.statSync(p).isDirectory();
      info((isDir ? "Delete dir: " : "Delete file: ") + p);
      rmrf(p);
    } catch (e) {
      err("Failed to remove: " + p + " (" + e.message + ")");
    }
  }

  info("Temp cleaned: " + tempDir);
  process.exit(0);
} catch (e) {
  err(e.message || String(e));
  process.exit(1);
}
