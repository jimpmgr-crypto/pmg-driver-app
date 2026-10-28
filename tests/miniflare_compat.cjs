// Wrangler 4.154 uses the explicit Miniflare worker configuration API.
// Bundle fixture imports and retain the same real workerd, SQLite and KV tests.
const runtime = require('miniflare');
const esbuild = require('esbuild');
const path = require('node:path');

function convert(options) {
  const {kvPersist, durableObjectsPersist, modulesRules, scriptPath, modulesRoot, ...rest} = options;
  const bundled = esbuild.buildSync({entryPoints:[scriptPath], bundle:true, format:'esm', write:false,
    external:['cloudflare:workers']}).outputFiles[0].text;
  return runtime.convertV4MiniflareOptions({...rest,
    modules:[{type:'ESModule',path:scriptPath,contents:bundled}],
    modulesRoot:path.dirname(scriptPath),
    ...((kvPersist || durableObjectsPersist) ? {resourcePersistencePath:path.dirname(kvPersist || durableObjectsPersist)} : {})});
}

class Miniflare extends runtime.Miniflare {
  constructor(options) { super(convert(options)); }
}

module.exports = {...runtime, Miniflare};
