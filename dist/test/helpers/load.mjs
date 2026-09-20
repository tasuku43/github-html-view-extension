// Extension scripts are IIFEs that expose APIs through window. Load them with a fake
// window so these tests do not need a bundler.
//
// Use new Function instead of vm so values stay in the same realm. Arrays and objects
// created inside vm.createContext are not the same constructors used by the test runner,
// which causes deepStrictEqual to fail even when their structure matches.
import fs from 'node:fs';

// Callers provide only a file name. This helper owns the search paths so reorganizing the
// source tree does not change what the tests load.
const SCRIPT_DIRS = ['', 'src/', 'src/lib/', 'src/github/'];

function resolve(fileName) {
  for (const dir of SCRIPT_DIRS) {
    const path = new URL('../../' + dir + fileName, import.meta.url);
    if (fs.existsSync(path)) {
      return path;
    }
  }
  throw new Error('Script not found: ' + fileName);
}

/**
 * Load multiple scripts into one window in the supplied order. Split scripts discover
 * each other through window.GHPREVIEW, so separate windows would hide their dependencies.
 * The order should match manifest.json.
 */
export function loadScripts(fileNames, extraGlobals = {}) {
  const sandbox = { ...extraGlobals };
  sandbox.window = sandbox.window || {};

  const names = Object.keys(sandbox);
  fileNames.forEach(fileName => {
    const path = resolve(fileName);
    const code = fs.readFileSync(path, 'utf8') + '\n//# sourceURL=' + fileName;
    // Pass globalThis explicitly so scripts that support environments without window use
    // the fake window in these tests.
    const run = new Function(...names, 'globalThis', code);
    run(...names.map(name => sandbox[name]), sandbox.window);
  });
  return sandbox;
}

export function loadScript(fileName, extraGlobals = {}) {
  return loadScripts([fileName], extraGlobals);
}
