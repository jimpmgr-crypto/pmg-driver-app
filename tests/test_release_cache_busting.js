const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeCheck = fs.readFileSync(path.join(root, 'tools', 'driver_app_runtime_check.py'), 'utf8');
const postChangeCheck = fs.readFileSync(path.join(root, 'tools', 'driver_app_post_change_check.py'), 'utf8');
const releaseGuard = fs.readFileSync(path.join(root, 'tools', 'driver_release_guard.py'), 'utf8');

assert(runtimeCheck.includes('cache_buster = time.time_ns()'), 'runtime health must use a fresh cache buster on every run');
assert(runtimeCheck.includes('runtime_check={cache_buster}'), 'runtime URLs must carry the fresh cache buster');
assert(!runtimeCheck.includes('runtime_check=1'), 'runtime health must not reuse a cacheable fixed query');

assert(postChangeCheck.includes('cache_buster = time.time_ns()'), 'post-change check must use a fresh cache buster');
assert(postChangeCheck.includes('post_change_check={cache_buster}'), 'post-change app-version read must carry the fresh cache buster');
assert(!postChangeCheck.includes('post_change_check=1'), 'post-change check must not reuse a cacheable fixed query');

assert(releaseGuard.includes('release_token = time.time_ns()'), 'release guard must mint a fresh verification token');
assert(releaseGuard.includes('release_check={check_token}'), 'live release reads must carry the fresh verification token');

console.log('release verification cache-busting regression checks passed');
