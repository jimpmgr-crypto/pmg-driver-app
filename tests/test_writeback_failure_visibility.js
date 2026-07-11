const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

const tidyStart = indexHtml.indexOf('function markDriverFailedWritebacksSavedLocally()');
const tidyEnd = indexHtml.indexOf('function setQueueState', tidyStart);
assert(tidyStart > 0 && tidyEnd > tidyStart, 'writeback tidy helper not found');
const tidyHelper = indexHtml.slice(tidyStart, tidyEnd);

assert(
  tidyHelper.includes("item.state === 'needs office review'"),
  'only explicit office-review rows should be tidied into saved-local'
);
assert(
  !tidyHelper.includes("item.state === 'failed' || item.state === 'needs office review'"),
  'failed Haultech/worker writebacks must not be silently downgraded to saved-local'
);

const syncStart = indexHtml.indexOf('function updateSyncUI()');
const syncEnd = indexHtml.indexOf('function updateSyncDot', syncStart);
assert(syncStart > 0 && syncEnd > syncStart, 'sync UI function not found');
const syncUi = indexHtml.slice(syncStart, syncEnd);

assert(
  indexHtml.includes('function needsWritebackAttention(item)'),
  'sync UI should have a named writeback-attention predicate'
);
assert(
  syncUi.includes("item.state === 'failed'"),
  'failed writebacks must keep the sync banner/dot in an attention state'
);
assert(
  syncUi.includes('Something did not send. Your work is saved'),
  'drivers should see a clear plain-English failed-writeback warning'
);

console.log('writeback failure visibility regression checks passed');
