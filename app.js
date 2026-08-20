(function(){
  var state = { testCases: [], filesScanned: 0, isScanning:false, search:'', priorityFilter:'all', statusFilter:'all', sortKey:null, sortDir:'asc', groupBySuite:false, collapsedSuites:[], trendSourceFilter:null, trendFileFilter:null, fullScanHistory:[], manualOverrides:{}, dupOnly:false, editedOnly:false, page:1, chartView:'trend' };

  // Everything that touches persistence goes through these two wrappers instead of
  // window.storage directly, so if that API is ever missing or disabled in some
  // embedding context, the app degrades to "works fine, just doesn't persist"
  // instead of throwing on the very first storage call during page load.
    var STORAGE_AVAILABLE = true;
  function warnStorageUnavailableOnce(){}
  function safeStorageGet(key, shared){
    try {
      return Promise.resolve({ value: localStorage.getItem(key) });
    } catch(e) {
      return Promise.resolve({ value: null });
    }
  }
  function safeStorageSet(key, value, shared){
    try {
      localStorage.setItem(key, value);
      return Promise.resolve();
    } catch(e) {
      return Promise.reject(e);
    }
  }

  var SPEC_RE = /\.(spec|specs|test|tests)\.(ts|tsx|js|jsx)$/i;
  var DATA_RE = /\.(json|jsonl|txt|xml)$/i;
  var DATA_BLACKLIST = /^(package(-lock)?|tsconfig.*|jsconfig.*|\.eslintrc.*|composer|manifest|playwright\.config)\.json$|^(pom|web|app)\.xml$/i;
  var EXCLUDED_DIR_RE = /(^|[\\/])(node_modules|\.git|\.svn|dist|build|coverage|\.next|\.nuxt|\.turbo|vendor|\.venv|venv|__pycache__|\.cache|out|target)([\\/]|$)/i;
  // Files that are very plausibly test results, but in a format we don't have a
  // native parser for (CSV exports, HTML reports, plain logs, TAP output, .NET
  // TRX). These get offered to Smart Import (AI) instead of silently dropped.
  var UNRECOGNIZED_CANDIDATE_RE = /\.(csv|html?|log|tap|trx)$/i;
  var ZIP_RE = /\.zip$/i;
  function isScannable(name){
    if (SPEC_RE.test(name)) return true;
    if (DATA_RE.test(name) && !DATA_BLACKLIST.test(name)) return true;
    return false;
  }
  function isExcludedPath(path){
    return EXCLUDED_DIR_RE.test(path);
  }

  // Extracts every file from a ZIP archive using only native browser APIs (no
  // external library — keeps this a true single-file artifact). Common for CI
  // "download all artifacts" bundles, and also for Playwright's own
  // --reporter=blob output: that's a ZIP containing report.jsonl, which
  // parseBlobJsonl() below reads once it's extracted here.
  async function unzipToEntries(arrayBuffer){
    var bytes = new Uint8Array(arrayBuffer);
    var view = new DataView(arrayBuffer);

    var eocdOffset = -1;
    var scanFloor = Math.max(0, bytes.length - 22 - 65536);
    for (var i = bytes.length - 22; i >= scanFloor; i--){
      if (view.getUint32(i, true) === 0x06054b50){ eocdOffset = i; break; }
    }
    if (eocdOffset === -1) throw new Error('not a valid ZIP (no end-of-central-directory record found)');

    var entryCount = view.getUint16(eocdOffset + 10, true);
    var centralDirOffset = view.getUint32(eocdOffset + 16, true);

    var entries = [];
    var ptr = centralDirOffset;
    for (var e = 0; e < entryCount; e++){
      if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('malformed ZIP central directory');
      var method = view.getUint16(ptr + 10, true);
      var compSize = view.getUint32(ptr + 20, true);
      var nameLen = view.getUint16(ptr + 28, true);
      var extraLen = view.getUint16(ptr + 30, true);
      var commentLen = view.getUint16(ptr + 32, true);
      var localHeaderOffset = view.getUint32(ptr + 42, true);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, localHeaderOffset: localHeaderOffset });
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    var results = [];
    for (var j = 0; j < entries.length; j++){
      var ent = entries[j];
      if (ent.name.endsWith('/')) continue;

      var lh = ent.localHeaderOffset;
      if (view.getUint32(lh, true) !== 0x04034b50) throw new Error('malformed ZIP local header for ' + ent.name);
      var lNameLen = view.getUint16(lh + 26, true);
      var lExtraLen = view.getUint16(lh + 28, true);
      var dataStart = lh + 30 + lNameLen + lExtraLen;
      var compBytes = bytes.subarray(dataStart, dataStart + ent.compSize);

      var outBytes;
      if (ent.method === 0){
        outBytes = compBytes;
      } else if (ent.method === 8){
        var ds = new DecompressionStream('deflate-raw');
        var writer = ds.writable.getWriter();
        writer.write(compBytes);
        writer.close();
        var chunks = [];
        var reader = ds.readable.getReader();
        while (true){
          var r = await reader.read();
          if (r.done) break;
          chunks.push(r.value);
        }
        var total = chunks.reduce(function(sum, c){ return sum + c.length; }, 0);
        outBytes = new Uint8Array(total);
        var off = 0;
        chunks.forEach(function(c){ outBytes.set(c, off); off += c.length; });
      } else {
        continue; // unsupported compression method for this entry — skip it, don't fail the whole archive
      }
      results.push({ path: ent.name, text: new TextDecoder('utf-8').decode(outBytes) });
    }
    return results;
  }

  // ---------- DOM refs ----------
  var scanLogEl = document.getElementById('scanLog');
  var statFiles = document.getElementById('statFiles');
  var statTests = document.getElementById('statTests');
  var tableWrap = document.getElementById('tableWrap');
  var resultsCount = document.getElementById('resultsCount');
  var searchInput = document.getElementById('searchInput');
  var priorityFilter = document.getElementById('priorityFilter');

  // ---------- Tabs ----------
  document.querySelectorAll('.tab-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
      document.querySelectorAll('.tab-pane').forEach(function(p){ p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('pane-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ---------- Scan log ----------
  function logLine(text, cls, quiet){
    if (!quiet) scanLogEl.classList.add('show');
    var div = document.createElement('div');
    div.className = 'line' + (cls ? ' ' + cls : '');
    div.textContent = '> ' + text;
    scanLogEl.appendChild(div);
    scanLogEl.scrollTop = scanLogEl.scrollHeight;
  }
  function logCursor(){
    var c = document.createElement('span');
    c.className = 'cursor';
    c.id = 'liveCursor';
    scanLogEl.appendChild(c);
    scanLogEl.scrollTop = scanLogEl.scrollHeight;
  }
  function removeCursor(){
    var c = document.getElementById('liveCursor');
    if (c) c.remove();
  }

  // ---------- Parser ----------
  function slugify(str){
    return str.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  }
  function stripQuotes(s){ return s.trim().replace(/^['"`]|['"`]$/g, ''); }
  function splitTopLevelArgs(s){
    var args = []; var cur = ''; var q = null;
    for (var i=0;i<s.length;i++){
      var c = s[i];
      if (q){ cur += c; if (c === q && s[i-1] !== '\\') q = null; }
      else if (c === '\'' || c === '"' || c === '`'){ q = c; cur += c; }
      else if (c === ','){ args.push(cur); cur = ''; }
      else cur += c;
    }
    if (cur.trim()) args.push(cur);
    return args.map(function(a){ return a.trim(); });
  }
  function readBalanced(str, openIdx, openCh, closeCh){
    var depth = 0;
    for (var i=openIdx;i<str.length;i++){
      if (str[i] === openCh) depth++;
      else if (str[i] === closeCh){ depth--; if (depth === 0) return { body: str.slice(openIdx+1, i), end: i+1 }; }
    }
    return { body: str.slice(openIdx+1), end: str.length };
  }

  // Discovers helper functions that call test.info().annotations.push(...), e.g.
  // function annotateValidationCase(id, requirement, priority) { test.info().annotations.push({type:'test-case',description:id}, ...) }
  function extractAnnotateFunctions(content){
    var fnDefs = {};
    var fnRe = /function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*[\w<>\[\].,\s|]+)?\s*\{/g;
    var fm;
    while ((fm = fnRe.exec(content)) !== null){
      var name = fm[1];
      var openIdx = fnRe.lastIndex - 1;
      var balanced = readBalanced(content, openIdx, '{', '}');
      var body = balanced.body;

      var params = splitTopLevelArgs(fm[2]).filter(Boolean).map(function(p){
        var nameM = p.match(/^\s*(\w+)/);
        var defM = p.match(/=\s*(['"`])((?:\\.|(?!\1).)*)\1/);
        return { name: nameM ? nameM[1] : null, default: defM ? defM[2] : null };
      });

      var annotations = [];
      var pushIdx = body.indexOf('annotations.push(');
      if (pushIdx !== -1){
        var parenOpen = body.indexOf('(', pushIdx);
        var argsBalanced = readBalanced(body, parenOpen, '(', ')');
        var objRe = /\{[^{}]*\}/g;
        var om;
        while ((om = objRe.exec(argsBalanced.body)) !== null){
          var obj = om[0];
          var typeM = obj.match(/type:\s*['"`]([^'"`]+)['"`]/);
          var descLiteralM = obj.match(/description:\s*['"`]([^'"`]*)['"`]/);
          var descIdentM = obj.match(/description:\s*(\w+)/);
          annotations.push({
            type: typeM ? typeM[1] : null,
            literal: descLiteralM ? descLiteralM[1] : null,
            param: (!descLiteralM && descIdentM) ? descIdentM[1] : null
          });
        }
      }
      if (annotations.length) fnDefs[name] = { params: params, annotations: annotations };
    }
    return fnDefs;
  }

  function resolveAnnotationsFromCall(fnDefs, fnName, argsStr){
    var fn = fnDefs[fnName];
    if (!fn) return null;
    var callArgs = splitTopLevelArgs(argsStr).map(stripQuotes);
    var valueMap = {};
    fn.params.forEach(function(p, idx){
      var val = (callArgs[idx] !== undefined && callArgs[idx] !== '') ? callArgs[idx] : p.default;
      if (p.name) valueMap[p.name] = val;
    });
    return fn.annotations.map(function(a){
      var val = a.literal !== null ? a.literal : (a.param ? valueMap[a.param] : null);
      return { type: a.type, value: val };
    });
  }

  function parseSpecFile(content, fileName, filePath){
    var found = [];
    var fnDefs = extractAnnotateFunctions(content);
    var fnNames = Object.keys(fnDefs);
    var callRe = fnNames.length ? new RegExp('\\b(' + fnNames.join('|') + ')\\s*\\(([^()]*)\\)', 'g') : null;
    var inlinePushRe = /test\.info\(\)\.annotations\.push\(/;

    // describe blocks: index + name (handles chained modifiers like describe.serial)
    var describeRe = /\bdescribe(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
    var describes = [];
    var dm;
    while ((dm = describeRe.exec(content)) !== null){
      describes.push({ index: dm.index, name: dm[2] });
    }
    function suiteFor(idx){
      var name = null;
      for (var i=0;i<describes.length;i++){
        if (describes[i].index < idx) name = describes[i].name; else break;
      }
      return name;
    }

    // test blocks (captures .only / .skip / .fixme modifier)
    var testRe = /\btest(\.only|\.skip|\.fixme)?\s*\(\s*(['"`])((?:\\.|(?!\2).)*?)\2\s*,\s*(?:(\{[^{}]*\})\s*,\s*)?async/g;
    var matches = [];
    var tm;
    while ((tm = testRe.exec(content)) !== null){
      matches.push({
        index: tm.index,
        end: testRe.lastIndex,
        modifier: tm[1] ? tm[1].replace('.', '') : null,
        title: tm[3],
        optionsStr: tm[4] || '',
        raw: content.slice(tm.index, Math.min(tm.index + 160, content.length))
      });
    }

    var stepRe = /test\.step\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;

    matches.forEach(function(m, i){
      var bodyStart = m.end;
      var bodyEnd = (i + 1 < matches.length) ? matches[i+1].index : content.length;
      var body = content.slice(bodyStart, bodyEnd);

      var steps = [];
      var sm;
      var localStepRe = new RegExp(stepRe.source, 'g');
      while ((sm = localStepRe.exec(body)) !== null){
        steps.push(sm[2]);
      }
      // Fallback: if the file doesn't use test.step(), fall back to standalone
      // // comment lines in the body as informal steps — common in specs that
      // annotate intent/rationale above each action instead of wrapping in steps.
      if (!steps.length){
        var commentRe = /^[ \t]*\/\/\s*(.+)$/gm;
        var cmMatch;
        while ((cmMatch = commentRe.exec(body)) !== null){
          var text = cmMatch[1].trim();
          if (text && !/^(eslint|@ts-|prettier-|TODO:?$)/i.test(text)) steps.push(text);
        }
      }

      // ---- Convention A: inline { tag: [...] } options ----
      var tags = [];
      var tagMatch = m.optionsStr.match(/['"`]([^'"`]+)['"`]/g);
      if (tagMatch){
        tags = tagMatch.map(function(t){ return t.replace(/['"`]/g, ''); }).filter(function(t){ return t.indexOf('@') === 0; });
      }
      var id = null;
      var priority = null;
      var requirement = null;
      var status = null;
      var displayTitle = m.title;

      tags.forEach(function(t){
        var pm = t.match(/priority-?(\w+)/i);
        if (pm && !priority) priority = pm[1].charAt(0).toUpperCase() + pm[1].slice(1).toLowerCase();
        else if (/^@?(high|medium|low)$/i.test(t) && !priority) priority = t.replace('@','').charAt(0).toUpperCase() + t.replace('@','').slice(1).toLowerCase();
      });
      var idTag = tags.find(function(t){ return /^@?id-/i.test(t); });
      if (idTag) id = idTag.replace(/^@?id-/i, '').toUpperCase();

      // ---- Convention B: test.info().annotations.push(...), directly or via a named helper ----
      var resolvedAnns = null;
      if (callRe){
        callRe.lastIndex = 0;
        var cm;
        while ((cm = callRe.exec(body)) !== null){
          var r = resolveAnnotationsFromCall(fnDefs, cm[1], cm[2]);
          if (r){ resolvedAnns = r; break; }
        }
      }
      if (!resolvedAnns && inlinePushRe.test(body)){
        var pushIdx = body.search(inlinePushRe);
        var parenOpen = body.indexOf('(', body.indexOf('push(', pushIdx) + 4);
        var argsBalanced = readBalanced(body, parenOpen, '(', ')');
        var objRe = /\{[^{}]*\}/g;
        var om; var inlineAnns = [];
        while ((om = objRe.exec(argsBalanced.body)) !== null){
          var obj = om[0];
          var typeM = obj.match(/type:\s*['"`]([^'"`]+)['"`]/);
          var descM = obj.match(/description:\s*['"`]([^'"`]*)['"`]/);
          inlineAnns.push({ type: typeM ? typeM[1] : null, value: descM ? descM[1] : null });
        }
        if (inlineAnns.length) resolvedAnns = inlineAnns;
      }
      if (resolvedAnns){
        resolvedAnns.forEach(function(a){
          if (a.type === 'test-case' && a.value) id = a.value.toUpperCase();
          if (a.type === 'priority' && a.value) priority = a.value.charAt(0).toUpperCase() + a.value.slice(1).toLowerCase();
          if (a.type === 'requirement' && a.value) requirement = a.value;
          if (a.type === 'status' && a.value) status = normalizeStatus(a.value);
        });
      }

      // ---- Convention C: metadata embedded in the title itself, e.g. "[TR-005] [Priority: Low] [Status: Failed] should ..." ----
      var titleMeta = m.title.match(/^\s*\[([^\]]+)\]\s*\[\s*Priority:\s*(High|Medium|Low)\s*\]\s*(?:\[\s*Status:\s*(\w+(?:\s+\w+)?)\s*\]\s*)?(.*)$/i);
      if (titleMeta){
        if (!id) id = titleMeta[1].trim().toUpperCase();
        if (!priority) priority = titleMeta[2].charAt(0).toUpperCase() + titleMeta[2].slice(1).toLowerCase();
        if (!status && titleMeta[3]) status = normalizeStatus(titleMeta[3]);
        displayTitle = titleMeta[4].trim() || m.title;
      }

      // ---- Fallbacks if nothing above resolved it ----
      if (!id) id = slugify(m.title) + '-' + (i+1);
      if (!priority) priority = 'Medium';
      if (!status) status = 'Unrun';

      found.push({
        uid: filePath + '::' + i,
        id: id,
        title: displayTitle,
        suite: suiteFor(m.index),
        steps: steps,
        priority: priority,
        status: status,
        modifier: m.modifier,
        requirement: requirement,
        tags: tags,
        file: filePath || fileName,
        raw: m.raw.replace(/\s+/g, ' ').trim() + ' ...',
        durationMs: null, startTime: null, endTime: null
      });
    });

    return found;
  }

  function normalizeStatus(raw){
    var s = String(raw).toLowerCase().replace(/[_-]/g, ' ').trim();
    if (/^(pass|passed|ok|success)$/.test(s)) return 'Passed';
    if (/^(fail|failed|failure|error|timedout|timed out|interrupted)$/.test(s)) return 'Failed';
    if (/^flaky$/.test(s)) return 'Flaky';
    if (/^(expected fail|xfail|expectedfail)$/.test(s)) return 'Expected Fail';
    if (/^(skip|skipped|pending|todo)$/.test(s)) return 'Skipped';
    return 'Unrun';
  }

  // Reads a JSON test manifest / exported test-case list. Accepts a top-level array,
  // or an object with a "tests"/"testCases"/"cases"/"specs" array, or the first
  // array-of-objects found one level deep — so it adapts to a few common export shapes.
  // Normalizes one loosely-shaped test object (from JSON, or from an AI-parsed
  // report) into the app's standard test-entry shape. Shared by parseJsonFile
  // and the Smart Import (AI) path so both produce identical, consistent rows.
  function buildTestEntryFromObject(item, i, filePath, fileName){
    if (typeof item === 'string'){
      return {
        uid: filePath + '::' + i, id: slugify(item) + '-' + (i+1), title: item, suite: null,
        steps: [], priority: 'Medium', status: 'Unrun', modifier: null, requirement: null,
        tags: [], file: filePath || fileName, raw: item,
        durationMs: null, startTime: null, endTime: null
      };
    }
    var title = item.title || item.fullTitle || item.name || item.testTitle || ('Untitled test ' + (i+1));
    var id = item.id || item.testId || item.test_case || item.ID || (slugify(title) + '-' + (i+1));
    var priorityRaw = item.priority || 'Medium';
    var priority = String(priorityRaw).charAt(0).toUpperCase() + String(priorityRaw).slice(1).toLowerCase();
    var stepsRaw = item.steps || item.step || [];
    var steps = Array.isArray(stepsRaw) ? stepsRaw.map(function(s){
      if (typeof s === 'string') return s;
      return s.description || s.name || s.step || JSON.stringify(s);
    }) : [];

    // Timing only shows up in real execution reports (Playwright JSON reporter,
    // AI-parsed logs with timestamps, etc), never in hand-written manifests —
    // so these stay null unless the source actually provides them.
    var durationMs = null;
    if (item.durationMs != null) durationMs = Number(item.durationMs);
    else if (item.duration != null) durationMs = Number(item.duration);
    var startTime = item.startTime || item.start || null;
    var endTime = item.endTime || item.end || null;
    var statusRaw = item.status || item.state || null;

    return {
      uid: filePath + '::' + i,
      id: String(id).toUpperCase(),
      title: String(title),
      suite: item.suite || item.group || null,
      steps: steps,
      priority: priority,
      status: statusRaw ? normalizeStatus(statusRaw) : 'Unrun',
      modifier: null,
      requirement: item.requirement || item.description || null,
      tags: Array.isArray(item.tags) ? item.tags : [],
      file: filePath || fileName,
      raw: JSON.stringify(item).slice(0, 160) + ' ...',
      durationMs: (durationMs != null && !isNaN(durationMs)) ? durationMs : null,
      startTime: startTime,
      endTime: endTime
    };
  }

  // Playwright's native JSON reporter output nests everything: suites can contain
  // sub-suites, each suite has specs, each spec has tests, each test has results
  // (one per retry). This walks that tree and flattens it into one row per spec,
  // using the last (most final) result for status/timing.
  function flattenPlaywrightSuites(suites, parentSuiteName){
    var out = [];
    (suites || []).forEach(function(suite){
      var suiteName = suite.title || parentSuiteName || null;
      (suite.specs || []).forEach(function(spec, i){
        var tests = spec.tests || [];
        var lastTest = tests[tests.length - 1] || {};
        var results = lastTest.results || [];
        var lastResult = results[results.length - 1] || {};
        out.push({
          id: spec.id || null,
          title: spec.title || ('Untitled test ' + (i+1)),
          suite: suiteName,
          status: lastResult.status || lastTest.status || null,
          durationMs: lastResult.duration != null ? lastResult.duration : null,
          startTime: lastResult.startTime || null,
          priority: null
        });
      });
      if (Array.isArray(suite.suites)){
        out = out.concat(flattenPlaywrightSuites(suite.suites, suiteName));
      }
    });
    return out;
  }

  // Reads a JSON test manifest / exported test-case list, or a real execution report.
  // Detects Playwright's native JSON reporter shape (suites/specs/tests/results) first;
  // otherwise accepts a top-level array, an object with a "tests"/"testCases"/"cases"/
  // "specs" array, or the first array-of-objects found one level deep.
  function parseJsonFile(content, fileName, filePath){
    var data;
    try { data = JSON.parse(content); } catch(e){ throw new Error('invalid JSON'); }

    if (data && typeof data === 'object' && Array.isArray(data.suites)){
      var flattened = flattenPlaywrightSuites(data.suites, null);
      return flattened.map(function(item, i){ return buildTestEntryFromObject(item, i, filePath, fileName); });
    }

    var list = null;
    if (Array.isArray(data)){
      list = data;
    } else if (data && typeof data === 'object'){
      var candidateKeys = ['tests', 'testCases', 'test_cases', 'cases', 'specs'];
      for (var k=0;k<candidateKeys.length;k++){
        if (Array.isArray(data[candidateKeys[k]])){ list = data[candidateKeys[k]]; break; }
      }
      if (!list){
        var keys = Object.keys(data);
        for (var j=0;j<keys.length;j++){
          var v = data[keys[j]];
          if (Array.isArray(v) && v.length && typeof v[0] === 'object'){ list = v; break; }
        }
      }
    }
    if (!list) return [];

    return list.map(function(item, i){ return buildTestEntryFromObject(item, i, filePath, fileName); });
  }

  // Reads a plain-text test outline: a title line followed by optional numbered
  // step lines ("1. ...", "2. ..."), blocks separated by blank lines or the next title.
  function parseTextFile(content, fileName, filePath){
    var lines = content.split(/\r?\n/);
    var tests = [];
    var current = null;
    var count = 0;
    lines.forEach(function(line){
      var trimmed = line.trim();
      if (!trimmed) return;
      var stepMatch = trimmed.match(/^(\d+)[\.\)]\s+(.*)$/);
      if (stepMatch && current){
        current.steps.push(stepMatch[2]);
      } else {
        if (current) tests.push(current);
        count++;
        var title = trimmed.replace(/^[-*]\s+/, '');
        current = {
          uid: filePath + '::' + count,
          id: slugify(title) + '-' + count,
          title: title,
          suite: null,
          steps: [],
          priority: 'Medium',
          status: 'Unrun',
          modifier: null,
          requirement: null,
          tags: [],
          file: filePath || fileName,
          raw: trimmed,
          durationMs: null, startTime: null, endTime: null
        };
      }
    });
    if (current) tests.push(current);
    return tests;
  }

  // Reads a JUnit XML report (the format emitted by Jenkins, GitLab CI, CircleCI,
  // GitHub Actions test reporters, pytest, JUnit itself, and many others).
  // Structure: <testsuite(s)><testcase name="..." classname="..." time="1.23">
  //   optional <failure>/<error>/<skipped> child marks the outcome.
  function parseJunitXml(content, fileName, filePath){
    var doc;
    try {
      var parser = new DOMParser();
      doc = parser.parseFromString(content, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('malformed XML');
    } catch(e){ throw new Error('invalid XML'); }

    var testcases = Array.prototype.slice.call(doc.getElementsByTagName('testcase'));
    if (!testcases.length) return [];

    return testcases.map(function(tc, i){
      var name = tc.getAttribute('name') || ('Untitled test ' + (i+1));
      var classname = tc.getAttribute('classname') || tc.getAttribute('class') || null;
      var timeSec = parseFloat(tc.getAttribute('time'));
      var durationMs = !isNaN(timeSec) ? Math.round(timeSec * 1000) : null;

      var status = 'Passed';
      var requirement = null;
      var failureEl = tc.getElementsByTagName('failure')[0];
      var errorEl = tc.getElementsByTagName('error')[0];
      var skippedEl = tc.getElementsByTagName('skipped')[0];
      if (failureEl){ status = 'Failed'; requirement = (failureEl.getAttribute('message') || failureEl.textContent || '').trim().slice(0, 200) || null; }
      else if (errorEl){ status = 'Failed'; requirement = (errorEl.getAttribute('message') || errorEl.textContent || '').trim().slice(0, 200) || null; }
      else if (skippedEl){ status = 'Skipped'; }

      return buildTestEntryFromObject({
        id: null,
        title: name,
        suite: classname,
        status: status,
        durationMs: durationMs,
        requirement: requirement,
        priority: 'Medium'
      }, i, filePath, fileName);
    });
  }

  // Reads a Playwright blob report's extracted report.jsonl — a newline-delimited
  // event log (onProject/onTestBegin/onTestEnd/onEnd) produced by --reporter=blob
  // and unpacked from its .zip via merge-reports or our own ZIP extraction above.
  // This is Playwright's internal event protocol, not a documented public schema,
  // so it's read defensively: any line or event shape it doesn't recognize is
  // skipped rather than treated as a parse failure.
  function parseBlobJsonl(content, fileName, filePath){
    var lines = content.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
    var events = [];
    lines.forEach(function(line){
      try { events.push(JSON.parse(line)); } catch(e){ /* skip malformed line */ }
    });
    if (!events.length) return [];

    var projectEvents = events.filter(function(e){ return e.method === 'onProject'; }).map(function(e){ return e.params.project; });
    if (!projectEvents.length) return []; // doesn't look like a blob event log

    var tests = {};
    function walk(entries, titleParts, projectName){
      (entries || []).forEach(function(entry){
        if (entry.testId){
          tests[entry.testId] = {
            id: entry.testId,
            suite: projectName,
            title: titleParts.concat([entry.title]).filter(Boolean).join(' › '),
            annotations: entry.annotations || []
          };
          return;
        }
        walk(entry.entries, titleParts.concat([entry.title]).filter(Boolean), projectName);
      });
    }
    projectEvents.forEach(function(project){
      walk(project.suites, [project.name].filter(Boolean), project.name || null);
    });

    var attemptsByTest = {};
    events.forEach(function(e){
      if (e.method !== 'onTestEnd') return;
      var testId = e.params.test.testId;
      if (!attemptsByTest[testId]) attemptsByTest[testId] = [];
      attemptsByTest[testId].push(e.params);
    });

    function failedLike(status){ return status === 'failed' || status === 'timedOut' || status === 'interrupted'; }
    function blobOutcome(attempts, expectedStatus){
      var final = attempts[attempts.length - 1];
      var finalStatus = (final && final.result && final.result.status) || 'skipped';
      var hadPriorFailure = attempts.slice(0, -1).some(function(a){ return failedLike(a.result && a.result.status); });
      if (finalStatus === 'skipped') return 'Skipped';
      if (expectedStatus === 'failed' && finalStatus === 'failed') return 'Expected Fail';
      if (finalStatus === expectedStatus){
        if (expectedStatus === 'passed' && hadPriorFailure) return 'Flaky';
        return 'Passed';
      }
      return 'Failed';
    }
    function blobFailureReason(attempt){
      var errors = (attempt && attempt.result && attempt.result.errors) || [];
      var error = errors[0] || (attempt && attempt.result && attempt.result.error);
      if (!error) return null;
      var text = String(error.message || error.stack || '').replace(/\u001b\[[0-9;]*m/g, '');
      var firstLine = text.split('\n').map(function(l){ return l.trim(); }).filter(Boolean)[0];
      return firstLine || null;
    }

    var found = [];
    var i = 0;
    Object.keys(tests).forEach(function(testId){
      var test = tests[testId];
      var attempts = attemptsByTest[testId] || [];
      var final = attempts[attempts.length - 1];
      var expectedStatus = (final && final.test && final.test.expectedStatus) || 'passed';
      var outcome = attempts.length ? blobOutcome(attempts, expectedStatus) : 'Unrun';
      var duration = attempts.reduce(function(sum, a){ return sum + ((a.result && a.result.duration) || 0); }, 0);
      var reason = (outcome === 'Failed' || outcome === 'Expected Fail') ? blobFailureReason(attempts[attempts.length - 1]) : null;

      // Same annotation convention already supported for .spec.ts files (test.info().
      // annotations.push({type:'test-case'|'priority'|'requirement', description})) —
      // blob reports preserve these verbatim since they come from the same API.
      var annoId = null, annoPriority = null, annoRequirement = null;
      (test.annotations || []).forEach(function(a){
        if (a.type === 'test-case' && a.description) annoId = a.description;
        if (a.type === 'priority' && a.description) annoPriority = a.description;
        if (a.type === 'requirement' && a.description) annoRequirement = a.description;
      });

      found.push(buildTestEntryFromObject({
        id: annoId,
        title: test.title,
        suite: test.suite,
        status: outcome,
        priority: annoPriority,
        durationMs: duration || null,
        requirement: annoRequirement || reason,
        startTime: (attempts[0] && attempts[0].result && attempts[0].result.startTime) || null
      }, i, filePath, fileName));
      i++;
    });

    return found;
  }

  function ingestFile(fileName, filePath, content){
    state.filesScanned++;
    var ext = (fileName.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
    var tests = [];
    try {
      if (ext === 'json') tests = parseJsonFile(content, fileName, filePath);
      else if (ext === 'jsonl') tests = parseBlobJsonl(content, fileName, filePath);
      else if (ext === 'txt') tests = parseTextFile(content, fileName, filePath);
      else if (ext === 'xml') tests = parseJunitXml(content, fileName, filePath);
      else tests = parseSpecFile(content, fileName, filePath);
    } catch(e){
      logLine('Failed to parse ' + filePath + ' (' + e.message + ')', 'err');
      return 0;
    }
    // Re-scanning a file should replace its previous entries, not duplicate them.
    state.testCases = state.testCases.filter(function(t){ return t.file !== filePath; });
    applyOverridesToList(tests);

    if (tests.length){
      state.testCases = state.testCases.concat(tests);
      logLine('Scanned ' + filePath + ' — found ' + tests.length + ' test' + (tests.length===1?'':'s'), 'ok');
    } else if (ext === 'json' || ext === 'jsonl' || ext === 'txt' || ext === 'xml'){
      logLine('Scanned ' + filePath + ' — no recognizable test entries, skipped', 'warn');
    } else {
      logLine('Scanned ' + filePath + ' — no test() blocks matched', 'warn');
    }
    refreshStats();
    renderTable();
    return tests.length;
  }

  function refreshStats(){
    statFiles.textContent = state.filesScanned;
    statTests.textContent = state.testCases.length;
    updateOverview();
    renderSourcesList();
    renderTrendChart(state.fullScanHistory);
  }

  function renderSourcesList(){
    var el = document.getElementById('sourcesList');
    if (!el) return;
    var counts = {};
    var order = [];
    state.testCases.forEach(function(t){
      if (!counts[t.file]){ counts[t.file] = 0; order.push(t.file); }
      counts[t.file]++;
    });
    if (!order.length){
      el.innerHTML = '<div class="empty">No sources scanned yet</div>';
      return;
    }
    el.innerHTML = order.map(function(f){
      var active = state.trendFileFilter === f;
      return '<div class="source-row' + (active ? ' active' : '') + '" data-file="' + escapeHtml(f) + '" tabindex="0" role="button" aria-pressed="' + active + '" title="Click to filter the trend chart to just this file">' +
        '<span class="source-path" title="' + escapeHtml(f) + '">' + escapeHtml(f) + '</span>' +
        '<span class="source-count">' + counts[f] + '</span>' +
        '<button class="source-remove" data-file="' + escapeHtml(f) + '" title="Remove this source and its tests" aria-label="Remove source ' + escapeHtml(f) + '">✕</button>' +
        '</div>';
    }).join('');
    el.querySelectorAll('.source-remove').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        var file = btn.dataset.file;
        var n = counts[file] || 0;
        showConfirmDialog('Remove ' + n + ' test case' + (n===1?'':'s') + ' discovered from "' + file + '"? This only removes them from this table — the source file itself is untouched.', function(){
          removeSource(file);
        });
      });
    });
    function toggleFileFilter(file){
      state.trendFileFilter = (state.trendFileFilter === file) ? null : file;
      renderSourcesList();
      renderTrendChart(state.fullScanHistory);
    }
    el.querySelectorAll('.source-row').forEach(function(row){
      row.addEventListener('click', function(){ toggleFileFilter(row.dataset.file); });
      row.addEventListener('keydown', function(e){
        if ((e.key === 'Enter' || e.key === ' ') && e.target === row){ e.preventDefault(); toggleFileFilter(row.dataset.file); }
      });
    });
  }

  function removeSource(file){
    state.testCases = state.testCases.filter(function(t){ return t.file !== file; });
    if (state.trendFileFilter === file) state.trendFileFilter = null;
    refreshStats();
    renderTable();
    persistTestCases();
    logLine('Removed source "' + file + '" and its discovered tests.', 'ok');
    scanLogEl.classList.add('show');
  }

  var STATUS_DEFS = [
    { key:'Passed', color:'green', icon:'✓' },
    { key:'Failed', color:'red', icon:'✕' },
    { key:'Flaky', color:'amber', icon:'!' },
    { key:'Expected Fail', color:'purple', icon:'?' },
    { key:'Skipped', color:'gray', icon:'»' },
    { key:'Unrun', color:'accent', icon:'▶' }
  ];

  function getStatusCounts(){
    var counts = {};
    STATUS_DEFS.forEach(function(s){ counts[s.key] = 0; });
    state.testCases.forEach(function(t){ counts[t.status] = (counts[t.status] || 0) + 1; });
    return counts;
  }

  function getStatusCountsByFile(){
    var byFile = {};
    state.testCases.forEach(function(t){
      if (!byFile[t.file]){
        byFile[t.file] = {};
        STATUS_DEFS.forEach(function(s){ byFile[t.file][s.key] = 0; });
      }
      byFile[t.file][t.status] = (byFile[t.file][t.status] || 0) + 1;
    });
    return byFile;
  }

  function updateOverview(){
    document.getElementById('ovFiles').textContent = state.filesScanned;
    document.getElementById('ovTests').textContent = state.testCases.length;

    var total = state.testCases.length;
    var counts = getStatusCounts();

    var html = STATUS_DEFS.map(function(s){
      var n = counts[s.key] || 0;
      var pct = total ? Math.round((n / total) * 100) : 0;
      return '<div class="status-card">' +
        '<div class="top"><span class="lbl">' + s.key + '</span>' +
        '<span class="icon" style="background:var(--' + s.color + '-soft); color:var(--' + s.color + ');">' + s.icon + '</span></div>' +
        '<div class="num">' + n + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%; background:var(--' + s.color + ');"></div></div>' +
        '<div class="pct">' + pct + '%</div>' +
        '</div>';
    }).join('');
    document.getElementById('statusRow').innerHTML = html;
  }

  var TREND_SERIES = [
    { key:'Passed', color:'var(--green)' },
    { key:'Failed', color:'var(--red)' },
    { key:'Flaky', color:'var(--amber)' },
    { key:'Expected Fail', color:'var(--purple)' },
    { key:'Skipped', color:'var(--gray)' }
  ];
  var EMPTY_CHART_HTML =
    '<div class="chart-empty">' +
      '<svg viewBox="0 0 400 120" preserveAspectRatio="none">' +
        '<line x1="0" y1="100" x2="400" y2="100" stroke="#E1E3DE" stroke-width="1"/>' +
        '<line x1="0" y1="60" x2="400" y2="60" stroke="#E1E3DE" stroke-width="1" stroke-dasharray="3 4"/>' +
        '<line x1="0" y1="20" x2="400" y2="20" stroke="#E1E3DE" stroke-width="1" stroke-dasharray="3 4"/>' +
      '</svg>' +
      '<div class="msg">No run history yet. Import a folder or repo below and this chart will start plotting your Passed / Failed / Flaky / Expected Fail / Skipped counts — a new point gets saved each time you scan.</div>' +
    '</div>';

  function renderTrendChart(history){
    state.fullScanHistory = history || [];
    var area = document.getElementById('trendChartArea');
    if (!area) return;
    // If there's nothing currently discovered, don't render a trend from stale
    // history — e.g. a source you later removed, or history left over from a
    // previous session's data that's since been cleared. The chart should only
    // ever look "live" when it corresponds to what's actually in the table now.
    if (!state.testCases.length || !history || !history.length){
      area.innerHTML = EMPTY_CHART_HTML;
      return;
    }

    var selectHtml = '';
    var points;
    var scopeLabel;

    if (state.trendFileFilter){
      // File filter takes priority over the source dropdown — show every
      // snapshot that has data for this specific file, regardless of which
      // scan action recorded it. Snapshots from before this feature existed
      // won't have a per-file breakdown, so they're excluded rather than
      // guessed at.
      var file = state.trendFileFilter;
      var filePoints = history.filter(function(pt){ return pt.byFile && pt.byFile[file]; });
      points = filePoints.map(function(pt){ return { ts: pt.ts, counts: pt.byFile[file] }; });
      scopeLabel = file;
      selectHtml = '<div class="trend-file-banner">Filtered to <strong>' + escapeHtml(file) + '</strong> — <button class="action-link" id="trendClearFileFilter" style="font-size:11.5px;">clear filter</button></div>';
    } else {
      var sources = [];
      history.forEach(function(pt){
        var src = pt.source || 'Unlabeled scan';
        if (sources.indexOf(src) === -1) sources.push(src);
      });
      var activeSource = (state.trendSourceFilter && sources.indexOf(state.trendSourceFilter) !== -1)
        ? state.trendSourceFilter
        : sources[sources.length - 1];
      state.trendSourceFilter = activeSource;

      points = sources.length > 1
        ? history.filter(function(pt){ return (pt.source || 'Unlabeled scan') === activeSource; })
        : history;
      scopeLabel = activeSource;

      if (sources.length > 1){
        selectHtml = '<select class="filter" id="trendSourceSelect" style="margin-bottom:10px; width:100%;">' +
          sources.map(function(s){ return '<option value="' + escapeHtml(s) + '"' + (s === activeSource ? ' selected' : '') + '>' + escapeHtml(s) + '</option>'; }).join('') +
          '</select>';
      }
    }

    var h = 120, pad = 16;
    var n = points.length;

    if (!n){
      area.innerHTML = selectHtml + '<div class="chart-empty"><div class="msg">No history recorded for this file yet — it will start building the next time you re-scan its source.</div></div>';
      wireTrendSourceSelect();
      wireTrendClearFileFilter();
      return;
    }

    // Width grows with the data instead of squeezing every snapshot into a fixed
    // box — each point gets a consistent pixel spacing, so as history builds up
    // the chart gets wider and the container scrolls horizontally, rather than
    // everything getting harder to read as more scans pile up.
    var POINT_SPACING = 40;
    var MIN_WIDTH = 380;
    var w = Math.max(MIN_WIDTH, pad * 2 + Math.max(n - 1, 0) * POINT_SPACING);

    var parts;
    if (state.chartView === 'stacked'){
      parts = buildStackedBarsSvg(points, w, h, pad, POINT_SPACING, n <= 1);
    } else {
      parts = buildTrendLineSvg(points, w, h, pad, POINT_SPACING, n <= 1);
    }

    var legend = TREND_SERIES.map(function(s){
      return '<div class="item"><span class="dot" style="background:' + s.color + ';"></span>' + s.key + '</div>';
    }).join('');

    var footer = n === 1
      ? 'Showing 1 scan snapshot for ' + escapeHtml(scopeLabel) + ' — the trend builds up as you scan again over time.'
      : n + ' scan snapshots for ' + escapeHtml(scopeLabel) + ' · ' + new Date(points[0].ts).toLocaleString() + ' → ' + new Date(points[n-1].ts).toLocaleString() + (w > MIN_WIDTH ? ' · scroll to see earlier history →' : '');

    area.innerHTML = selectHtml +
      '<div class="trend-legend">' + legend + '</div>' +
      '<div class="trend-chart-wrap" id="trendChartWrap"><svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + parts.join('') + '</svg></div>' +
      '<div class="trend-footer">' + footer + '</div>';

    wireTrendSourceSelect();
    wireTrendClearFileFilter();

    // Land on the most recent data by default — you scroll left/drag to go back
    // through history, rather than starting on the oldest point.
    var wrapEl = document.getElementById('trendChartWrap');
    if (wrapEl) wrapEl.scrollLeft = wrapEl.scrollWidth;
  }

  function buildTrendLineSvg(points, w, h, pad, spacing, single){
    var n = points.length;
    var maxVal = 1;
    points.forEach(function(pt){ TREND_SERIES.forEach(function(s){ maxVal = Math.max(maxVal, pt.counts[s.key] || 0); }); });
    function xFor(i){ return single ? w / 2 : pad + i * spacing; }
    function yFor(v){ return h - pad - (v / maxVal) * (h - pad * 2); }

    var parts = ['<line x1="0" y1="' + (h - pad) + '" x2="' + w + '" y2="' + (h - pad) + '" stroke="#E1E3DE" stroke-width="1"/>'];
    TREND_SERIES.forEach(function(s){
      if (n > 1){
        var pts = points.map(function(pt, i){ return xFor(i) + ',' + yFor(pt.counts[s.key] || 0); }).join(' ');
        parts.push('<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
      }
      points.forEach(function(pt, i){
        parts.push('<circle cx="' + xFor(i) + '" cy="' + yFor(pt.counts[s.key] || 0) + '" r="3" fill="' + s.color + '"/>');
      });
    });
    return parts;
  }

  function buildStackedBarsSvg(points, w, h, pad, spacing, single){
    var n = points.length;
    var maxTotal = 1;
    points.forEach(function(pt){
      var total = TREND_SERIES.reduce(function(sum, s){ return sum + (pt.counts[s.key] || 0); }, 0);
      maxTotal = Math.max(maxTotal, total);
    });

    var slot = single ? w : spacing;
    var barWidth = Math.max(4, slot * 0.6);
    var parts = ['<line x1="0" y1="' + (h - pad) + '" x2="' + w + '" y2="' + (h - pad) + '" stroke="#E1E3DE" stroke-width="1"/>'];

    points.forEach(function(pt, i){
      var slotStart = single ? 0 : pad + i * spacing - slot / 2;
      var x = slotStart + (slot - barWidth) / 2;
      var yCursor = h - pad;
      TREND_SERIES.forEach(function(s){
        var val = pt.counts[s.key] || 0;
        if (!val) return;
        var segHeight = (val / maxTotal) * (h - pad * 2);
        yCursor -= segHeight;
        parts.push('<rect x="' + x.toFixed(1) + '" y="' + yCursor.toFixed(1) + '" width="' + barWidth.toFixed(1) + '" height="' + segHeight.toFixed(1) + '" fill="' + s.color + '" rx="1.5"/>');
      });
    });
    return parts;
  }

  function wireTrendSourceSelect(){
    var sel = document.getElementById('trendSourceSelect');
    if (!sel) return;
    sel.addEventListener('change', function(e){
      state.trendSourceFilter = e.target.value;
      renderTrendChart(state.fullScanHistory);
    });
  }

  function wireTrendClearFileFilter(){
    var btn = document.getElementById('trendClearFileFilter');
    if (!btn) return;
    btn.addEventListener('click', function(){
      state.trendFileFilter = null;
      renderSourcesList();
      renderTrendChart(state.fullScanHistory);
    });
  }

  var TEST_CASES_KEY = 'test-cases';
  var MANUAL_OVERRIDES_KEY = 'manual-overrides';
  var LAST_UPDATED_KEY = 'last-updated';

  function persistTestCases(){
    try {
      var payload = JSON.stringify(state.testCases);
      safeStorageSet(TEST_CASES_KEY, payload, false)
        .catch(function(err){
          console.error('Could not save test cases', err);
          logLine('Could not save your discovered tests to browser storage (possibly over the 5MB limit at ' + state.testCases.length + ' tests). Your table is fine for this session, but it won\'t survive a reload until you free up space — try Clear All, or export what you have first.', 'err');
          scanLogEl.classList.add('show');
        });
      var now = Date.now();
      safeStorageSet(LAST_UPDATED_KEY, String(now), false)
        .then(function(){ showLastUpdated(now); })
        .catch(function(){});
    } catch(e){ console.error('Could not save test cases', e); }
  }

  function showLastUpdated(ts){
    var el = document.getElementById('lastUpdated');
    if (el) el.textContent = 'Last updated ' + new Date(ts).toLocaleString();
  }

  // Applies any saved manual priority/status corrections onto a freshly-parsed
  // list, keyed by test ID — so overrides survive re-scanning the same source.
  function applyOverridesToList(list){
    list.forEach(function(t){
      var o = state.manualOverrides[t.id];
      if (o){
        if (o.priority) t.priority = o.priority;
        if (o.status) t.status = o.status;
        t.overridden = true;
      }
    });
    return list;
  }

  function setManualOverride(id, patch){
    var existing = state.manualOverrides[id] || {};
    state.manualOverrides[id] = { priority: patch.priority || existing.priority, status: patch.status || existing.status };
    safeStorageSet(MANUAL_OVERRIDES_KEY, JSON.stringify(state.manualOverrides), false)
      .catch(function(err){ console.error('Could not save override', err); });
  }

  function clearManualOverride(id){
    delete state.manualOverrides[id];
    safeStorageSet(MANUAL_OVERRIDES_KEY, JSON.stringify(state.manualOverrides), false)
      .catch(function(err){ console.error('Could not clear override', err); });
  }

  function loadManualOverrides(){
    return safeStorageGet(MANUAL_OVERRIDES_KEY, false)
      .then(function(res){ state.manualOverrides = (res && res.value) ? JSON.parse(res.value) : {}; })
      .catch(function(){ state.manualOverrides = {}; });
  }

  function loadPersistedTestCases(){
    loadManualOverrides().then(function(){
      return safeStorageGet(TEST_CASES_KEY, false)
        .then(function(res){
          var saved = (res && res.value) ? JSON.parse(res.value) : [];
          if (saved.length){
            state.testCases = applyOverridesToList(saved);
            state.filesScanned = uniqueFileCount(saved);
            refreshStats();
            renderTable();
            logLine('Restored ' + saved.length + ' previously discovered test case' + (saved.length===1?'':'s') + ' from this browser.', 'ok', true);
          }
        })
        .catch(function(){ /* nothing saved yet — leave the empty state as-is */ });
    });
    safeStorageGet(LAST_UPDATED_KEY, false)
      .then(function(res){ if (res && res.value) showLastUpdated(Number(res.value)); })
      .catch(function(){});
  }

  function uniqueFileCount(list){
    var seen = {};
    list.forEach(function(t){ seen[t.file] = true; });
    return Object.keys(seen).length;
  }

  function clearAllData(){
    state.testCases = [];
    state.filesScanned = 0;
    state.trendSourceFilter = null;
    state.fullScanHistory = [];
    state.manualOverrides = {};
    refreshStats();
    renderTable();
    renderTrendChart([]);
    safeStorageSet(TEST_CASES_KEY, JSON.stringify([]), false).catch(function(){});
    safeStorageSet(SCAN_HISTORY_KEY, JSON.stringify([]), false).catch(function(){});
    safeStorageSet(MANUAL_OVERRIDES_KEY, JSON.stringify({}), false).catch(function(){});
    showLastUpdated(Date.now());
    logLine('Cleared all discovered tests and run history for this browser.', 'ok');
    scanLogEl.classList.add('show');
  }

  document.getElementById('clearAllBtn').addEventListener('click', function(){
    if (!state.testCases.length){ return; }
    showConfirmDialog('Clear all discovered tests and run history saved in this browser? This can\'t be undone.', clearAllData);
  });

  var SCAN_HISTORY_KEY = 'scan-history';

  function loadScanHistory(){
    safeStorageGet(SCAN_HISTORY_KEY, false)
      .then(function(res){
        var history = (res && res.value) ? JSON.parse(res.value) : [];
        renderTrendChart(history);
      })
      .catch(function(){ renderTrendChart([]); });
  }

  function recordScanSnapshot(source){
    var total = state.testCases.length;
    if (!total) return;
    var entry = { ts: Date.now(), counts: getStatusCounts(), byFile: getStatusCountsByFile(), total: total, source: source || 'Unlabeled scan' };
    safeStorageGet(SCAN_HISTORY_KEY, false)
      .then(function(res){ return (res && res.value) ? JSON.parse(res.value) : []; })
      .catch(function(){ return []; })
      .then(function(history){
        history.push(entry);
        if (history.length > 100) history = history.slice(history.length - 100);
        safeStorageSet(SCAN_HISTORY_KEY, JSON.stringify(history), false)
          .then(function(){ renderTrendChart(history); })
          .catch(function(err){ console.error('Could not save scan history', err); renderTrendChart(history); });
      });
  }

  // ---------- Local folder import ----------
  var dropzone = document.getElementById('dropzone');
  var folderInput = document.getElementById('folderInput');
  dropzone.addEventListener('click', function(){ folderInput.click(); });
  dropzone.addEventListener('dragover', function(e){ e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', function(){ dropzone.classList.remove('drag'); });
  dropzone.addEventListener('drop', function(e){
    e.preventDefault();
    dropzone.classList.remove('drag');

    var items = e.dataTransfer.items;
    var supportsEntries = items && items.length && typeof items[0].webkitGetAsEntry === 'function';

    if (supportsEntries){
      var entries = [];
      for (var i=0;i<items.length;i++){
        var entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      Promise.all(entries.map(function(entry){ return traverseFileTree(entry, ''); }))
        .then(function(results){
          handleFileEntries(results.reduce(function(a,b){ return a.concat(b); }, []));
        });
    } else {
      // Fallback for browsers without the directory-entries API: flat file list only.
      handleFileEntries(normalizeFileList(e.dataTransfer.files));
    }
  });
  folderInput.addEventListener('change', function(e){
    handleFileEntries(normalizeFileList(e.target.files));
  });

  var looseFilesInput = document.getElementById('looseFilesInput');
  document.getElementById('chooseFilesLink').addEventListener('click', function(e){
    e.stopPropagation();
    looseFilesInput.click();
  });
  looseFilesInput.addEventListener('click', function(e){ e.stopPropagation(); });
  looseFilesInput.addEventListener('change', function(e){
    handleFileEntries(normalizeFileList(e.target.files));
    looseFilesInput.value = '';
  });

  // Recursively walks a dropped FileSystemEntry (file or directory) at any depth,
  // so a "mother folder" containing nested subfolders is fully scanned — same
  // recursion the browser already does for the click-to-choose folder picker.
  function traverseFileTree(entry, path){
    return new Promise(function(resolve){
      if (entry.isFile){
        entry.file(function(file){
          resolve([{ file: file, path: path + entry.name }]);
        }, function(){ resolve([]); });
      } else if (entry.isDirectory){
        if (isExcludedPath(entry.name)){ resolve([]); return; }
        var reader = entry.createReader();
        var collected = [];
        (function readBatch(){
          reader.readEntries(function(batch){
            if (!batch.length){
              Promise.all(collected.map(function(child){ return traverseFileTree(child, path + entry.name + '/'); }))
                .then(function(results){ resolve(results.reduce(function(a,b){ return a.concat(b); }, [])); });
            } else {
              collected = collected.concat(batch);
              readBatch();
            }
          }, function(){ resolve([]); });
        })();
      } else {
        resolve([]);
      }
    });
  }

  function normalizeFileList(fileList){
    return Array.prototype.map.call(fileList, function(f){
      return { file: f, path: f.webkitRelativePath || f.name };
    });
  }

  function describeSelection(entries){
    if (!entries.length) return 'the selection';
    var first = entries[0].path;
    if (first.indexOf('/') !== -1) return '"' + first.split('/')[0] + '"';
    if (entries.length === 1) return '"' + first + '"';
    return entries.length + ' selected files';
  }

  var LARGE_SCAN_THRESHOLD = 300;

  function handleFileEntries(entries){
    var zipEntries = entries.filter(function(e){ return ZIP_RE.test(e.file.name); });
    var nonZipEntries = entries.filter(function(e){ return !ZIP_RE.test(e.file.name); });

    if (!zipEntries.length){
      processFileEntries(nonZipEntries);
      return;
    }

    scanLogEl.classList.add('show');
    logLine('Found ' + zipEntries.length + ' ZIP archive' + (zipEntries.length===1?'':'s') + ' — extracting...', '');

    var expandPromises = zipEntries.map(function(e){
      return e.file.arrayBuffer()
        .then(function(buf){ return unzipToEntries(buf); })
        .then(function(extracted){
          logLine('Extracted ' + extracted.length + ' file' + (extracted.length===1?'':'s') + ' from "' + e.file.name + '"', 'ok');
          return extracted.map(function(ex){
            var name = ex.path.split('/').pop();
            var syntheticFile = new File([ex.text], name, { type: 'text/plain' });
            return { file: syntheticFile, path: e.path.replace(/\.zip$/i, '') + '/' + ex.path };
          });
        })
        .catch(function(err){
          logLine('Could not extract "' + e.file.name + '" (' + err.message + '). If this is a Playwright --reporter=blob ZIP, its report.jsonl is now read natively once extracted — this error means the archive itself is corrupted or uses an unsupported compression method.', 'err');
          return [];
        });
    });

    Promise.all(expandPromises).then(function(results){
      var expanded = results.reduce(function(a, b){ return a.concat(b); }, []);
      processFileEntries(nonZipEntries.concat(expanded));
    });
  }

  function processFileEntries(entries){
    var selectionName = describeSelection(entries);
    var excludedCount = entries.filter(function(e){ return isExcludedPath(e.path); }).length;
    var candidates = entries.filter(function(e){ return !isExcludedPath(e.path); });
    var matched = candidates.filter(function(e){ return isScannable(e.file.name); });
    var unrecognized = candidates.filter(function(e){ return !isScannable(e.file.name) && UNRECOGNIZED_CANDIDATE_RE.test(e.file.name); });

    if (excludedCount){
      logLine('Skipped ' + excludedCount + ' file' + (excludedCount===1?'':'s') + ' inside node_modules/.git/dist/build/etc.', '');
    }
    if (!matched.length){
      if (unrecognized.length){
        logLine('No natively-recognized spec/test/JSON/XML files in ' + selectionName + ', but found ' + unrecognized.length + ' file' + (unrecognized.length===1?'':'s') + ' that look like they could be test results in a format I can\'t parse directly (CSV/HTML/log/TAP/TRX).', 'warn');
        scanLogEl.classList.add('show');
        offerSmartImportForFiles(unrecognized.map(function(e){ return e.file; }), selectionName);
      } else {
        logLine('No spec/test files (*.spec.ts, *.test.ts, *.spec.js, *.test.js) found in ' + selectionName + ', including subfolders.', 'warn');
        scanLogEl.classList.add('show');
      }
      return;
    }
    if (matched.length > LARGE_SCAN_THRESHOLD){
      scanLogEl.classList.add('show');
      showConfirmDialog(
        'Found ' + matched.length + ' candidate files in ' + selectionName + '. That\'s a lot to scan at once — continue?',
        function(){ runFileEntriesImport(matched, selectionName, unrecognized); },
        function(){ logLine('Scan of ' + selectionName + ' cancelled (' + matched.length + ' files).', 'warn'); }
      );
      return;
    }
    runFileEntriesImport(matched, selectionName, unrecognized);
  }

  var localJob = null;

  // After scanning gets through everything it can natively parse, this offers
  // to run whatever's left (unrecognized formats, or files that parsed to zero
  // tests) through Smart Import — reusing the same batch-confirm AI pipeline
  // used when you pick files directly on that tab.
  function offerSmartImportForFiles(files, selectionName){
    if (!files.length) return;
    showConfirmDialog(
      'Also try ' + files.length + ' unrecognized file' + (files.length===1?'':'s') + ' from ' + selectionName + ' with Smart Import (AI)? It reads almost any format and will show its own confirmation with the exact API call count before sending anything.',
      function(){
        if (smartJob){ logLine('Smart Import is already busy — try again once it finishes, or use the Smart Import tab directly.', 'warn'); return; }
        readAllSmartFiles(files);
      },
      function(){ logLine((files.length===1?'That file was':'Those files were') + ' left unscanned. Use the Smart Import tab any time to try them.', 'warn'); }
    );
  }

  function runFileEntriesImport(matched, selectionName, unrecognized){
    var job = { cancelled: false };
    localJob = job;
    var localProgress = document.getElementById('localProgress');
    var localProgressText = document.getElementById('localProgressText');
    localProgress.style.display = 'flex';

    logLine('Found ' + matched.length + ' candidate spec file' + (matched.length===1?'':'s') + ' in ' + selectionName + ' (subfolders included). Reading...', '');
    var total = matched.length;
    var done = 0;
    var ingested = 0;
    var zeroResultFiles = [];
    var pending = matched.length;
    matched.forEach(function(e){
      var reader = new FileReader();
      reader.onload = function(){
        done++;
        if (!job.cancelled){
          localProgressText.textContent = 'Reading ' + selectionName + ' — ' + done + '/' + total + '...';
          var found = ingestFile(e.file.name, e.path, reader.result);
          ingested++;
          var ext = (e.file.name.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
          if (!found && (ext === 'json' || ext === 'jsonl' || ext === 'xml')) zeroResultFiles.push(e.file);
        }
        pending--;
        if (pending === 0){
          localProgress.style.display = 'none';
          localJob = null;
          if (job.cancelled){
            logLine('Local import cancelled — kept ' + ingested + ' file' + (ingested===1?'':'s') + ' scanned before cancelling.', 'warn');
          } else {
            logLine('Local import complete.', 'ok');
          }
          recordScanSnapshot('Local: ' + selectionName);
          persistTestCases();
          maybeAutoSaveToLibrary();

          var leftover = (unrecognized || []).map(function(e){ return e.file; }).concat(zeroResultFiles);
          if (!job.cancelled && leftover.length){
            offerSmartImportForFiles(leftover, selectionName);
          }
        }
      };
      reader.onerror = function(){
        logLine('Could not read ' + e.file.name, 'err');
        pending--;
        if (pending === 0){ localProgress.style.display = 'none'; localJob = null; }
      };
      reader.readAsText(e.file);
    });
  }

  document.getElementById('localCancelBtn').addEventListener('click', function(){
    if (localJob) localJob.cancelled = true;
  });

  // ---------- GitHub repo import ----------
  var repoJob = null;

  function base64ToUtf8(b64){
    var binary = atob(b64.replace(/\n/g, ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  document.getElementById('scanRepoBtn').addEventListener('click', function(){
    var raw = document.getElementById('repoOwner').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
    var branch = document.getElementById('repoBranch').value.trim() || 'main';
    var token = document.getElementById('repoToken').value.trim();
    if (!raw || raw.indexOf('/') === -1){
      logLine('Enter a repo as owner/repo, e.g. playscout/portal-playwright', 'err');
      scanLogEl.classList.add('show');
      return;
    }
    var parts = raw.split('/');
    var owner = parts[0], repo = parts[1];
    var btn = document.getElementById('scanRepoBtn');
    var repoProgress = document.getElementById('repoProgress');
    var repoProgressText = document.getElementById('repoProgressText');
    var job = { cancelled: false };
    repoJob = job;
    btn.disabled = true;
    repoProgress.style.display = 'flex';
    repoProgressText.textContent = 'Connecting to ' + owner + '/' + repo + '...';
    logLine('Connecting to github.com/' + owner + '/' + repo + ' @ ' + branch + (token ? ' (authenticated)' : ''), '');
    logCursor();

    var authHeaders = token ? { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' } : { 'Accept': 'application/vnd.github+json' };

    function finishRepoScan(){
      repoProgress.style.display = 'none';
      btn.disabled = false;
      repoJob = null;
    }

    fetch('https://api.github.com/repos/' + owner + '/' + repo + '/git/trees/' + branch + '?recursive=1', { headers: authHeaders })
      .then(function(res){
        if (!res.ok){
          if (res.status === 404) throw new Error('repo, branch, or file not found (HTTP 404) — if it\'s private, check your token has access');
          if (res.status === 401 || res.status === 403) throw new Error('not authorized (HTTP ' + res.status + ') — check the token is valid and has repo access');
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function(data){
        removeCursor();
        if (job.cancelled){ logLine('Repo scan cancelled.', 'warn'); finishRepoScan(); return; }
        if (!data.tree){ throw new Error('empty tree response'); }
        var specFiles = data.tree.filter(function(item){
          return item.type === 'blob' && !isExcludedPath(item.path) && isScannable(item.path);
        });
        if (!specFiles.length){
          logLine('Repo tree scanned — no spec/test files matched.', 'warn');
          finishRepoScan();
          return;
        }
        logLine('Repo tree scanned — ' + specFiles.length + ' candidate file(s). Fetching contents...', 'ok');
        var limited = specFiles.slice(0, 60);
        if (specFiles.length > 60) logLine('Limiting to first 60 files to stay within API limits.', 'warn');

        var fetched = 0;
        var ingested = 0;
        var chain = Promise.resolve();
        limited.forEach(function(f){
          chain = chain.then(function(){
            if (job.cancelled) return;
            repoProgressText.textContent = 'Fetching ' + owner + '/' + repo + ' — ' + (fetched+1) + '/' + limited.length + '...';

            // With a token, private repos need the Git Blob API (raw.githubusercontent.com
            // doesn't reliably honor auth for private content). Without one, the plain
            // raw CDN URL is simpler and doesn't count against the API rate limit.
            var contentPromise = token
              ? fetch('https://api.github.com/repos/' + owner + '/' + repo + '/git/blobs/' + f.sha, { headers: authHeaders })
                  .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                  .then(function(blob){ return base64ToUtf8(blob.content); })
              : fetch('https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/' + f.path)
                  .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });

            return contentPromise
              .then(function(text){
                fetched++;
                if (job.cancelled) return;
                ingestFile(f.path.split('/').pop(), f.path, text);
                ingested++;
              })
              .catch(function(err){
                fetched++;
                logLine('Could not fetch ' + f.path + ' (' + err.message + ')', 'err');
              });
          });
        });
        chain.then(function(){
          if (job.cancelled){
            logLine('Repo scan cancelled — kept ' + ingested + ' file' + (ingested===1?'':'s') + ' fetched before cancelling.', 'warn');
          } else {
            logLine('Repo import complete.', 'ok');
          }
          recordScanSnapshot('Repo: ' + owner + '/' + repo);
          persistTestCases();
          maybeAutoSaveToLibrary();
          finishRepoScan();
        });
      })
      .catch(function(err){
        removeCursor();
        logLine('Repo scan failed: ' + err.message + '. If this is a private repo, add a Personal Access Token above. Otherwise try the Local Folder import instead.', 'err');
        finishRepoScan();
      });
  });

  document.getElementById('repoCancelBtn').addEventListener('click', function(){
    if (repoJob) repoJob.cancelled = true;
  });

  // ---------- Smart Import (AI) ----------
  var smartDropzone = document.getElementById('smartDropzone');
  var smartFileInput = document.getElementById('smartFileInput');
  var smartProgress = document.getElementById('smartProgress');
  var smartProgressText = document.getElementById('smartProgressText');
  var smartCancelBtn = document.getElementById('smartCancelBtn');
  var smartQueue = [];
  var smartJob = null; // { cancelled: bool } for the in-flight run

  smartDropzone.addEventListener('click', function(){ if (!smartJob) smartFileInput.click(); });
  smartDropzone.addEventListener('dragover', function(e){ e.preventDefault(); if (!smartJob) smartDropzone.classList.add('drag'); });
  smartDropzone.addEventListener('dragleave', function(){ smartDropzone.classList.remove('drag'); });
  smartDropzone.addEventListener('drop', function(e){
    e.preventDefault();
    smartDropzone.classList.remove('drag');
    if (smartJob) return;
    handleSmartFiles(e.dataTransfer.files);
  });
  smartFileInput.addEventListener('change', function(e){
    handleSmartFiles(e.target.files);
    smartFileInput.value = '';
  });
  smartCancelBtn.addEventListener('click', function(){
    if (smartJob) smartJob.cancelled = true;
    smartQueue = [];
    logLine('Smart Import cancelled by user.', 'warn');
  });

  function setSmartProgress(text){
    if (text){
      smartProgress.style.display = 'flex';
      smartProgressText.textContent = text;
    } else {
      smartProgress.style.display = 'none';
    }
  }

  function chunkText(text, size){
    var chunks = [];
    for (var i=0;i<text.length;i+=size){ chunks.push(text.slice(i, i+size)); }
    return chunks;
  }

  var SMART_CHUNK_SIZE = 6000;
  var SMART_MAX_CHUNKS = 6;

  function handleSmartFiles(fileList){
    var files = Array.prototype.slice.call(fileList);
    if (!files.length || smartJob) return;
    scanLogEl.classList.add('show');
    readAllSmartFiles(files);
  }

  function runSmartQueue(){
    var item = smartQueue.shift();
    if (!item) return;
    if (item.truncated){
      logLine('"' + item.fileName + '" is large — only scanning the first ' + item.chunks.length + ' of ' + item.totalChunksAvailable + ' chunks (~' + (SMART_CHUNK_SIZE * item.chunks.length) + ' characters).', 'warn');
    }
    processSmartContent(item.chunks, item.fileName);
  }

  // Reads every selected/dropped file up front (in parallel — FileReader text
  // reads are fast) so the whole batch's chunk/call count is known before asking
  // to proceed, instead of confirming and processing one file at a time.
  function readAllSmartFiles(files){
    var reads = files.map(function(file){
      return new Promise(function(resolve){
        var reader = new FileReader();
        reader.onload = function(){ resolve({ file: file, text: reader.result }); };
        reader.onerror = function(){ resolve({ file: file, text: null }); };
        reader.readAsText(file);
      });
    });
    Promise.all(reads).then(function(results){
      var plan = [];
      results.forEach(function(r){
        if (!r.text || !r.text.replace(/\s/g, '').length){
          logLine('"' + r.file.name + '" looks empty, or is a binary format (PDF/XLSX/etc) that can\'t be read as text yet. Try exporting it as CSV, JSON, or plain text first.', 'err');
          return;
        }
        var allChunks = chunkText(r.text, SMART_CHUNK_SIZE);
        var chunks = allChunks.slice(0, SMART_MAX_CHUNKS);
        plan.push({ fileName: r.file.name, chunks: chunks, truncated: allChunks.length > chunks.length, totalChunksAvailable: allChunks.length });
      });
      if (!plan.length) return;
      confirmAndRunSmartBatch(plan);
    });
  }

  function confirmAndRunSmartBatch(plan){
    var totalCalls = plan.reduce(function(sum, p){ return sum + p.chunks.length; }, 0);
    var lines = plan.map(function(p){
      return '• ' + p.fileName + ' — ' + p.chunks.length + ' call' + (p.chunks.length===1?'':'s') + (p.truncated ? ' (truncated from ' + p.totalChunksAvailable + ')' : '');
    });
    var msg = 'Send ' + plan.length + ' file' + (plan.length===1?'':'s') + ' to Claude for parsing? This will make ' + totalCalls + ' API call' + (totalCalls===1?'':'s') + ' total:\n' + lines.join('\n');
    showConfirmDialog(
      msg,
      function(){
        smartQueue = plan.slice();
        logLine('Starting Smart Import batch — ' + plan.length + ' file' + (plan.length===1?'':'s') + ', ' + totalCalls + ' API call' + (totalCalls===1?'':'s') + ' total.', '');
        runSmartQueue();
      },
      function(){
        logLine('Smart Import batch skipped (not confirmed).', 'warn');
      }
    );
  }

  function processSmartContent(chunks, fileName){
    var job = { cancelled: false };
    smartJob = job;
    setSmartProgress('Sending "' + fileName + '" — chunk 1/' + chunks.length + '...');
    logLine('Sending ' + chunks.length + ' chunk' + (chunks.length===1?'':'s') + ' of "' + fileName + '" to Claude for parsing...', '');

    var found = [];
    var chain = Promise.resolve();
    chunks.forEach(function(chunk, idx){
      chain = chain.then(function(){
        if (job.cancelled) return;
        setSmartProgress('Sending "' + fileName + '" — chunk ' + (idx+1) + '/' + chunks.length + '...');
        return callClaudeForTests(chunk)
          .then(function(items){
            if (job.cancelled) return;
            logLine('Chunk ' + (idx+1) + '/' + chunks.length + ' — found ' + items.length + ' test' + (items.length===1?'':'s'), items.length ? 'ok' : 'warn');
            items.forEach(function(item){
              found.push(buildTestEntryFromObject(item, found.length, fileName, fileName));
            });
          })
          .catch(function(err){
            if (job.cancelled) return;
            logLine('AI parsing failed on chunk ' + (idx+1) + ' of "' + fileName + '" (' + err.message + ')', 'err');
          });
      });
    });

    chain.then(function(){
      setSmartProgress(null);
      smartJob = null;
      if (job.cancelled){
        if (found.length){
          logLine('Cancelled partway through "' + fileName + '" — keeping ' + found.length + ' test case' + (found.length===1?'':'s') + ' found so far.', 'warn');
        }
      }
      state.filesScanned++;
      state.testCases = state.testCases.filter(function(t){ return t.file !== fileName; });
      applyOverridesToList(found);
      if (found.length){
        state.testCases = state.testCases.concat(found);
        refreshStats();
        renderTable();
        recordScanSnapshot('AI: ' + fileName);
        persistTestCases();
        maybeAutoSaveToLibrary();
        if (!job.cancelled) logLine('AI import complete for "' + fileName + '" — ' + found.length + ' test case' + (found.length===1?'':'s') + ' total.', 'ok');
      } else {
        refreshStats();
        renderTable();
        if (!job.cancelled) logLine('No test cases recognized in "' + fileName + '".', 'warn');
      }
      runSmartQueue();
    });
  }

  function callClaudeForTests(chunk){
    var instructions = 'You are a test-report parser. Extract every individual test case you can identify from the content below, regardless of its format (CSV, JUnit/XML, Markdown, HTML export, plain log, freeform notes, spreadsheet dump, etc). ' +
      'Respond with ONLY a raw JSON array — no markdown code fences, no preamble, no explanation, nothing before or after the array. ' +
      'Each element must have exactly these fields: ' +
      '"id" (short string — reuse an existing identifier from the source if present, otherwise omit it), ' +
      '"title" (string, the test name or description), ' +
      '"steps" (array of strings, the individual actions/assertions in order — empty array if none are identifiable), ' +
      '"priority" (one of "High", "Medium", "Low" — infer from context if not explicit, default "Medium"), ' +
      '"status" (one of "Passed", "Failed", "Flaky", "Expected Fail", "Skipped", "Unrun" — infer from pass/fail markers, symbols, or words if present, default "Unrun"), ' +
      '"requirement" (string or null, a one-line description of intent/purpose if present), ' +
      '"suite" (string or null, a grouping or section name if present), ' +
      '"durationMs" (number or null, execution duration in milliseconds if a timing value is present in the source), ' +
      '"startTime" (ISO 8601 string or null, if a start timestamp is present). ' +
      'If nothing resembling a test case is found in the content, respond with exactly: []' +
      '\n\n---CONTENT TO PARSE---\n\n' + chunk;

    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: instructions }]
      })
    })
    .then(function(res){
      if (!res.ok) throw new Error('API request failed (HTTP ' + res.status + ')');
      return res.json();
    })
    .then(function(data){
      var text = (data.content || []).map(function(block){ return block.text || ''; }).join('\n');
      var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      var parsed;
      try { parsed = JSON.parse(cleaned); }
      catch(e){ throw new Error('model response was not valid JSON'); }
      if (!Array.isArray(parsed)) throw new Error('unexpected response shape');
      return parsed;
    });
  }

  // ---------- Table rendering ----------
  function matchesFilters(t){
    var q = state.search.toLowerCase();
    var okSearch = !q ||
      t.title.toLowerCase().indexOf(q) !== -1 ||
      t.id.toLowerCase().indexOf(q) !== -1 ||
      t.file.toLowerCase().indexOf(q) !== -1 ||
      (t.requirement && t.requirement.toLowerCase().indexOf(q) !== -1) ||
      t.steps.some(function(s){ return s.toLowerCase().indexOf(q) !== -1; });
    var okPriority = state.priorityFilter === 'all' || t.priority.toLowerCase() === state.priorityFilter;
    var okStatus = state.statusFilter === 'all' || t.status === state.statusFilter;
    var okDup = !state.dupOnly || dupIdSet[t.id];
    var okEdited = !state.editedOnly || t.overridden;
    return okSearch && okPriority && okStatus && okDup && okEdited;
  }

  var PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
  var STATUS_ORDER = { 'Failed': 0, 'Flaky': 1, 'Expected Fail': 2, 'Unrun': 3, 'Skipped': 4, 'Passed': 5 };

  function sortRows(rows){
    if (!state.sortKey) return rows;
    var dir = state.sortDir === 'desc' ? -1 : 1;
    var key = state.sortKey;
    return rows.slice().sort(function(a, b){
      var av, bv;
      if (key === 'priority'){ av = PRIORITY_ORDER[a.priority.toLowerCase()]; bv = PRIORITY_ORDER[b.priority.toLowerCase()]; }
      else if (key === 'status'){ av = STATUS_ORDER[a.status] != null ? STATUS_ORDER[a.status] : 9; bv = STATUS_ORDER[b.status] != null ? STATUS_ORDER[b.status] : 9; }
      else { av = String(a[key] || '').toLowerCase(); bv = String(b[key] || '').toLowerCase(); }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function renderRowHtml(t){
    var idBadge = escapeHtml(t.id) + (dupIdSet[t.id] ? ' <span class="badge dup" title="This ID appears on more than one row">⚠ dup</span>' : '');
    var editedBadge = t.overridden ? ' <span class="badge edited" title="Priority/Status manually overridden">✎ edited</span>' : '';
    var inLibrary = !!librarySourceKeySet[t.file + '::' + t.id];
    var libBadge = inLibrary ? ' <span class="badge edited" style="background:var(--green-soft); color:var(--green);" title="Already saved to Library — saving again updates it">📚 in library</span>' : '';
    var rowLabel = t.id + ': ' + t.title + ', priority ' + t.priority + ', status ' + t.status + '. Activate to view details.';
    return '<tr data-uid="' + t.uid + '" tabindex="0" role="button" aria-label="' + escapeHtml(rowLabel) + '">' +
      '<td class="id-cell">' + idBadge + '</td>' +
      '<td class="title-cell">' + escapeHtml(t.title) + (t.modifier ? ' <span class="badge modifier" title="test.' + t.modifier + '()">.' + t.modifier + '</span>' : '') + editedBadge + libBadge + (t.suite ? '<span class="suite">' + escapeHtml(t.suite) + '</span>' : '') + '<span class="file-tag">' + escapeHtml(t.file) + '</span></td>' +
      '<td class="steps-cell">' + (t.steps.length ? '<ol>' + t.steps.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ol>' : '<span class="none">No steps found</span>') + '</td>' +
      '<td><span class="badge ' + t.priority.toLowerCase() + '">' + escapeHtml(t.priority) + '</span></td>' +
      '<td><span class="badge status">' + t.status + '</span>' + (t.durationMs != null ? '<span class="file-tag">' + formatDuration(t.durationMs) + '</span>' : '') + '</td>' +
      '<td><button class="action-link" data-uid="' + t.uid + '" aria-label="View details for ' + escapeHtml(t.id) + '">View</button> · <button class="action-link" data-action="save-lib" data-uid="' + t.uid + '" aria-label="Save ' + escapeHtml(t.id) + ' to Library">' + (inLibrary ? 'Update' : 'Save') + '</button></td>' +
      '</tr>';
  }

  var SORT_HEADERS = [
    { key:'id', label:'ID', width:'110px' },
    { key:'title', label:'Test Title', width:'220px' },
    { key:null, label:'Steps', width:'280px' },
    { key:'priority', label:'Priority', width:'90px' },
    { key:'status', label:'Status', width:'100px' },
    { key:null, label:'Actions', width:'110px' }
  ];

  function renderTableHead(){
    return '<thead><tr>' + SORT_HEADERS.map(function(h){
      if (!h.key) return '<th style="width:' + h.width + ';">' + h.label + '</th>';
      var arrow = state.sortKey === h.key ? '<span class="sort-arrow">' + (state.sortDir === 'desc' ? '▼' : '▲') + '</span>' : '';
      var ariaSort = state.sortKey === h.key ? (state.sortDir === 'desc' ? 'descending' : 'ascending') : 'none';
      return '<th class="sortable" data-sort="' + h.key + '" style="width:' + h.width + ';" tabindex="0" role="button" aria-sort="' + ariaSort + '" aria-label="Sort by ' + h.label + '">' + h.label + arrow + '</th>';
    }).join('') + '</tr></thead>';
  }

  var dupIdSet = {};
  function computeDupIds(){
    var counts = {};
    state.testCases.forEach(function(t){ counts[t.id] = (counts[t.id] || 0) + 1; });
    dupIdSet = {};
    Object.keys(counts).forEach(function(id){ if (counts[id] > 1) dupIdSet[id] = true; });
  }

  var librarySourceKeySet = {};
  function computeLibrarySourceKeys(){
    librarySourceKeySet = {};
    (state.library.items || []).forEach(function(it){
      if (it.sourceKey) librarySourceKeySet[it.sourceKey] = true;
    });
  }

  var PAGE_SIZE = 50;

  function renderTable(){
    computeDupIds();
    computeLibrarySourceKeys();
    var rows = sortRows(state.testCases.filter(matchesFilters));
    resultsCount.textContent = rows.length + ' test case' + (rows.length===1?'':'s') + (state.testCases.length !== rows.length ? ' (of ' + state.testCases.length + ')' : '');

    if (!state.testCases.length){
      tableWrap.innerHTML = '<div class="empty-state"><div class="glyph">// </div><div class="title">No tests discovered yet</div><div class="sub">Import a local folder or scan a GitHub repo above to find and plot your Playwright test cases.</div></div>';
      return;
    }
    if (!rows.length){
      tableWrap.innerHTML = '<div class="empty-state"><div class="glyph">// </div><div class="title">No matches</div><div class="sub">Nothing matches your search or filter. Try clearing them.</div></div>';
      return;
    }

    var totalPages = 1;
    var pageRows = rows;
    if (!state.groupBySuite){
      totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (state.page > totalPages) state.page = totalPages;
      if (state.page < 1) state.page = 1;
      var startIdx = (state.page - 1) * PAGE_SIZE;
      pageRows = rows.slice(startIdx, startIdx + PAGE_SIZE);
    }

    var html = '<div class="table-scroll"><table>' + renderTableHead() + '<tbody>';

    if (state.groupBySuite){
      var groups = {};
      var order = [];
      rows.forEach(function(t){
        var key = t.suite || 'No suite';
        if (!groups[key]){ groups[key] = []; order.push(key); }
        groups[key].push(t);
      });
      order.forEach(function(suiteName){
        var members = groups[suiteName];
        var collapsed = state.collapsedSuites.indexOf(suiteName) !== -1;
        html += '<tr class="group-header" data-suite="' + escapeHtml(suiteName) + '" tabindex="0" role="button" aria-expanded="' + (!collapsed) + '" aria-label="' + escapeHtml(suiteName) + ', ' + members.length + ' tests, ' + (collapsed ? 'collapsed' : 'expanded') + '. Activate to toggle."><td colspan="6"><span class="caret' + (collapsed ? ' collapsed' : '') + '">▾</span>' + escapeHtml(suiteName) + ' (' + members.length + ')</td></tr>';
        if (!collapsed){
          members.forEach(function(t){ html += renderRowHtml(t); });
        }
      });
    } else {
      pageRows.forEach(function(t){ html += renderRowHtml(t); });
    }

    html += '</tbody></table></div>';

    if (!state.groupBySuite && totalPages > 1){
      html += '<div class="pagination">' +
        '<button class="btn btn-ghost" id="pagePrevBtn"' + (state.page<=1?' disabled':'') + '>‹ Prev</button>' +
        '<span class="page-info">Page ' + state.page + ' of ' + totalPages + ' (' + rows.length + ' rows)</span>' +
        '<button class="btn btn-ghost" id="pageNextBtn"' + (state.page>=totalPages?' disabled':'') + '>Next ›</button>' +
        '</div>';
    }

    tableWrap.innerHTML = html;

    function toggleSort(key){
      if (state.sortKey === key){ state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; }
      else { state.sortKey = key; state.sortDir = 'asc'; }
      state.page = 1;
      renderTable();
    }
    tableWrap.querySelectorAll('thead th.sortable').forEach(function(th){
      th.addEventListener('click', function(){ toggleSort(th.dataset.sort); });
      th.addEventListener('keydown', function(e){
        if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleSort(th.dataset.sort); }
      });
    });

    function toggleGroup(suiteName){
      var idx = state.collapsedSuites.indexOf(suiteName);
      if (idx === -1) state.collapsedSuites.push(suiteName);
      else state.collapsedSuites.splice(idx, 1);
      renderTable();
    }
    tableWrap.querySelectorAll('tr.group-header').forEach(function(tr){
      tr.addEventListener('click', function(){ toggleGroup(tr.dataset.suite); });
      tr.addEventListener('keydown', function(e){
        if (e.key === 'Enter' || e.key === ' '){ e.preventDefault(); toggleGroup(tr.dataset.suite); }
      });
    });

    tableWrap.querySelectorAll('tr[data-uid]').forEach(function(tr){
      tr.addEventListener('click', function(e){
        if (e.target.tagName === 'BUTTON') return;
        openDrawer(tr.dataset.uid);
      });
      tr.addEventListener('keydown', function(e){
        if ((e.key === 'Enter' || e.key === ' ') && e.target === tr){ e.preventDefault(); openDrawer(tr.dataset.uid); }
      });
    });
    tableWrap.querySelectorAll('.action-link').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        if (btn.dataset.action === 'save-lib'){
          var t = state.testCases.find(function(x){ return x.uid === btn.dataset.uid; });
          if (t) openSaveToLibraryDialog([t]);
          return;
        }
        openDrawer(btn.dataset.uid);
      });
    });
    var prevBtn = document.getElementById('pagePrevBtn');
    if (prevBtn) prevBtn.addEventListener('click', function(){ state.page--; renderTable(); });
    var nextBtn = document.getElementById('pageNextBtn');
    if (nextBtn) nextBtn.addEventListener('click', function(){ state.page++; renderTable(); });
  }

  function formatDuration(ms){
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    var m = Math.floor(s / 60);
    var rem = Math.round(s % 60);
    return m + 'm ' + rem + 's';
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }

  // ---------- Drawer ----------
  var overlay = document.getElementById('overlay');
  var drawer = document.getElementById('drawer');
  var currentDrawerUid = null;

  function openDrawer(uid){
    var t = state.testCases.find(function(x){ return x.uid === uid; });
    if (!t) return;
    currentDrawerUid = uid;
    document.getElementById('drawerTitle').textContent = t.title;
    document.getElementById('drawerSuite').textContent = t.suite || 'No suite';
    document.getElementById('drawerId').textContent = t.id;
    document.getElementById('drawerPriority').value = t.priority;
    document.getElementById('drawerStatus').value = t.status;
    document.getElementById('drawerModifier').textContent = t.modifier ? '.' + t.modifier : '—';
    document.getElementById('drawerFile').textContent = t.file;
    document.getElementById('drawerRaw').textContent = t.raw;
    document.getElementById('drawerOverrideNote').style.display = t.overridden ? '' : 'none';

    var reqHeader = document.getElementById('drawerReqHeader');
    var reqBox = document.getElementById('drawerRequirement');
    if (t.requirement){
      reqHeader.style.display = '';
      reqBox.style.display = '';
      reqBox.textContent = t.requirement;
    } else {
      reqHeader.style.display = 'none';
      reqBox.style.display = 'none';
    }

    var timingHeader = document.getElementById('drawerTimingHeader');
    var timingGrid = document.getElementById('drawerTimingGrid');
    if (t.durationMs != null || t.startTime || t.endTime){
      timingHeader.style.display = '';
      timingGrid.style.display = '';
      document.getElementById('drawerStarted').textContent = t.startTime ? new Date(t.startTime).toLocaleString() : '—';
      document.getElementById('drawerEnded').textContent = t.endTime ? new Date(t.endTime).toLocaleString() : '—';
      document.getElementById('drawerDuration').textContent = t.durationMs != null ? formatDuration(t.durationMs) : '—';
    } else {
      timingHeader.style.display = 'none';
      timingGrid.style.display = 'none';
    }

    var tagsEl = document.getElementById('drawerTags');
    tagsEl.innerHTML = t.tags.length ? t.tags.map(function(tag){ return '<span class="tag-chip">' + escapeHtml(tag) + '</span>'; }).join('') : '<span class="tag-chip">No tags</span>';

    var stepsEl = document.getElementById('drawerSteps');
    stepsEl.innerHTML = t.steps.length ? t.steps.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('') : '<li>No test.step() calls found — this test may run as a single block.</li>';

    overlay.classList.add('show');
    drawer.classList.add('show');
  }
  function closeDrawer(){
    overlay.classList.remove('show');
    drawer.classList.remove('show');
  }
  overlay.addEventListener('click', closeDrawer);
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);

  // ---------- Custom confirm dialog ----------
  // Uses an in-app modal instead of the native confirm(), which can be silently
  // blocked inside a sandboxed iframe (artifacts run in one) — a blocked confirm()
  // returns false immediately with no dialog shown, which looks like a broken button.
  var confirmOverlay = document.getElementById('confirmOverlay');
  var confirmModal = document.getElementById('confirmModal');
  var confirmMessage = document.getElementById('confirmMessage');
  var confirmOkBtn = document.getElementById('confirmOkBtn');
  var confirmCancelBtn = document.getElementById('confirmCancelBtn');
  var pendingConfirmCallback = null;
  var pendingCancelCallback = null;

  function showConfirmDialog(message, onConfirm, onCancel){
    confirmMessage.textContent = message;
    pendingConfirmCallback = onConfirm;
    pendingCancelCallback = onCancel || null;
    confirmOverlay.classList.add('show');
    confirmModal.classList.add('show');
  }
  function closeConfirmDialog(){
    confirmOverlay.classList.remove('show');
    confirmModal.classList.remove('show');
    pendingConfirmCallback = null;
    pendingCancelCallback = null;
  }
  confirmOkBtn.addEventListener('click', function(){
    var cb = pendingConfirmCallback;
    closeConfirmDialog();
    if (cb) cb();
  });
  function cancelConfirmDialog(){
    var cb = pendingCancelCallback;
    closeConfirmDialog();
    if (cb) cb();
  }
  confirmCancelBtn.addEventListener('click', cancelConfirmDialog);
  confirmOverlay.addEventListener('click', cancelConfirmDialog);

  document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    if (confirmModal.classList.contains('show')){ cancelConfirmDialog(); return; }
    if (typeof libraryFormModal !== 'undefined' && libraryFormModal.classList.contains('show')){ closeLibraryForm(); return; }
    if (drawer.classList.contains('show')) closeDrawer();
  });

  function applyDrawerEdit(field, value){
    if (!currentDrawerUid) return;
    var t = state.testCases.find(function(x){ return x.uid === currentDrawerUid; });
    if (!t) return;
    t[field] = value;
    t.overridden = true;
    var patch = {}; patch[field] = value;
    setManualOverride(t.id, patch);
    document.getElementById('drawerOverrideNote').style.display = '';
    refreshStats();
    renderTable();
    persistTestCases();
  }
  document.getElementById('drawerPriority').addEventListener('change', function(e){ applyDrawerEdit('priority', e.target.value); });
  document.getElementById('drawerStatus').addEventListener('change', function(e){ applyDrawerEdit('status', e.target.value); });
  document.getElementById('drawerResetOverride').addEventListener('click', function(){
    if (!currentDrawerUid) return;
    var t = state.testCases.find(function(x){ return x.uid === currentDrawerUid; });
    if (!t) return;
    clearManualOverride(t.id);
    // Re-derive detected values by re-running this file's parser is out of scope here,
    // so we just drop the override flag; the next re-scan of the source file will
    // restore the originally detected priority/status since no override remains.
    t.overridden = false;
    document.getElementById('drawerOverrideNote').style.display = 'none';
    refreshStats();
    renderTable();
    persistTestCases();
    logLine('Override cleared for ' + t.id + ' — re-scan its source file to restore the originally detected values.', 'ok');
    scanLogEl.classList.add('show');
  });

  // ---------- Filters ----------
  var searchDebounceTimer = null;
  searchInput.addEventListener('input', function(){
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function(){
      state.search = searchInput.value;
      state.page = 1;
      renderTable();
    }, 180);
  });
  priorityFilter.addEventListener('change', function(){
    state.priorityFilter = priorityFilter.value;
    state.page = 1;
    renderTable();
  });
  document.getElementById('statusFilter').addEventListener('change', function(e){
    state.statusFilter = e.target.value;
    state.page = 1;
    renderTable();
  });

  var chartViewTrendBtn = document.getElementById('chartViewTrendBtn');
  var chartViewStackedBtn = document.getElementById('chartViewStackedBtn');
  function setChartView(view){
    state.chartView = view;
    chartViewTrendBtn.classList.toggle('active', view === 'trend');
    chartViewStackedBtn.classList.toggle('active', view === 'stacked');
    renderTrendChart(state.fullScanHistory);
  }
  chartViewTrendBtn.addEventListener('click', function(){ setChartView('trend'); });
  chartViewStackedBtn.addEventListener('click', function(){ setChartView('stacked'); });

  var groupToggleBtn = document.getElementById('groupToggleBtn');
  groupToggleBtn.addEventListener('click', function(){
    state.groupBySuite = !state.groupBySuite;
    groupToggleBtn.classList.toggle('active', state.groupBySuite);
    state.page = 1;
    renderTable();
  });

  var dupOnlyBtn = document.getElementById('dupOnlyBtn');
  dupOnlyBtn.addEventListener('click', function(){
    state.dupOnly = !state.dupOnly;
    dupOnlyBtn.classList.toggle('active', state.dupOnly);
    state.page = 1;
    renderTable();
  });

  var editedOnlyBtn = document.getElementById('editedOnlyBtn');
  editedOnlyBtn.addEventListener('click', function(){
    state.editedOnly = !state.editedOnly;
    editedOnlyBtn.classList.toggle('active', state.editedOnly);
    state.page = 1;
    renderTable();
  });

  // ---------- Export ----------
  function csvEscape(v){
    var s = String(v == null ? '' : v);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadBlob(content, filename, mime){
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  function getExportRows(){
    return sortRows(state.testCases.filter(matchesFilters));
  }

  document.getElementById('exportJsonBtn').addEventListener('click', function(){
    var rows = getExportRows();
    if (!rows.length) return;
    downloadBlob(JSON.stringify(rows, null, 2), 'test-cases.json', 'application/json');
  });

  document.getElementById('exportCsvBtn').addEventListener('click', function(){
    var rows = getExportRows();
    if (!rows.length) return;
    var header = ['ID', 'Title', 'Suite', 'Priority', 'Status', 'Steps', 'Requirement', 'Duration (ms)', 'File'];
    var lines = [header.map(csvEscape).join(',')];
    rows.forEach(function(t){
      lines.push([
        t.id, t.title, t.suite || '', t.priority, t.status,
        t.steps.map(function(s, i){ return (i+1) + '. ' + s; }).join(' | '),
        t.requirement || '', t.durationMs != null ? t.durationMs : '', t.file
      ].map(csvEscape).join(','));
    });
    downloadBlob(lines.join('\r\n'), 'test-cases.csv', 'text/csv');
  });

  // ==================== Library module ====================
  // A curated, independently-editable workspace: folders you create, test cases
  // you save into them (from Discovery or written from scratch), fully editable
  // and deletable. None of this is tied to live scan results — saving a copy
  // here doesn't link back to Discovery, and re-scanning never touches it.
  state.library = { folders: [], items: [], selectedFolderId: 'all', search: '', editingUid: null };
  var LIBRARY_FOLDERS_KEY = 'library-folders';
  var LIBRARY_ITEMS_KEY = 'library-items';

  function genUid(prefix){
    return (prefix || 'item') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function persistLibraryFolders(){
    safeStorageSet(LIBRARY_FOLDERS_KEY, JSON.stringify(state.library.folders), false)
      .catch(function(err){ console.error('Could not save library folders', err); });
  }
  function persistLibraryItems(){
    safeStorageSet(LIBRARY_ITEMS_KEY, JSON.stringify(state.library.items), false)
      .catch(function(err){
        console.error('Could not save library items', err);
        logLine('Could not save the Library to browser storage (possibly over the 5MB limit at ' + state.library.items.length + ' items). Your changes are fine for this session, but won\'t survive a reload — try exporting the Library, or trimming some items.', 'err');
        scanLogEl.classList.add('show');
      });
  }
  function loadLibrary(){
    safeStorageGet(LIBRARY_FOLDERS_KEY, false)
      .then(function(res){ state.library.folders = (res && res.value) ? JSON.parse(res.value) : []; })
      .catch(function(){ state.library.folders = []; })
      .then(function(){
        return safeStorageGet(LIBRARY_ITEMS_KEY, false)
          .then(function(res){ state.library.items = (res && res.value) ? JSON.parse(res.value) : []; })
          .catch(function(){ state.library.items = []; });
      })
      .then(function(){
        renderFolderList();
        renderLibraryTable();
        renderTable();
      });
  }

  // ---------- View switching ----------
  var discoveryViewEl = document.getElementById('discoveryView');
  var libraryViewEl = document.getElementById('libraryView');
  var navDiscoveryEl = document.getElementById('navDiscovery');
  var navLibraryEl = document.getElementById('navLibrary');
  function switchView(view){
    discoveryViewEl.style.display = view === 'discovery' ? '' : 'none';
    libraryViewEl.style.display = view === 'library' ? '' : 'none';
    navDiscoveryEl.classList.toggle('active', view === 'discovery');
    navLibraryEl.classList.toggle('active', view === 'library');
    if (view === 'library'){ renderFolderList(); renderLibraryTable(); }
  }
  navDiscoveryEl.addEventListener('click', function(){ switchView('discovery'); });
  navLibraryEl.addEventListener('click', function(){ switchView('library'); });

  // ---------- Folders ----------
  function folderItemCount(folderId){
    if (folderId === 'all') return state.library.items.length;
    if (folderId === 'unfiled') return state.library.items.filter(function(i){ return !i.folderId; }).length;
    return state.library.items.filter(function(i){ return i.folderId === folderId; }).length;
  }

  function renderFolderList(){
    var el = document.getElementById('folderList');
    if (!el) return;
    var html = '';
    [{ id:'all', name:'All Items' }, { id:'unfiled', name:'Unfiled' }].forEach(function(f){
      var active = state.library.selectedFolderId === f.id;
      html += '<div class="folder-item' + (active ? ' active' : '') + '" data-folder="' + f.id + '" tabindex="0" role="button">' +
        '<span class="fname">' + f.name + '</span><span class="fcount">' + folderItemCount(f.id) + '</span></div>';
    });
    state.library.folders.forEach(function(f){
      var active = state.library.selectedFolderId === f.id;
      html += '<div class="folder-item' + (active ? ' active' : '') + '" data-folder="' + f.id + '" tabindex="0" role="button">' +
        '<span class="fname" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<span class="fcount">' + folderItemCount(f.id) + '</span>' +
        '<button class="fedit" data-action="rename" data-folder="' + f.id + '" title="Rename folder" aria-label="Rename ' + escapeHtml(f.name) + '">✎</button>' +
        '<button class="fedit" data-action="delete" data-folder="' + f.id + '" title="Delete folder" aria-label="Delete ' + escapeHtml(f.name) + '">✕</button>' +
        '</div>';
    });
    el.innerHTML = html;

    el.querySelectorAll('.folder-item').forEach(function(row){
      row.addEventListener('click', function(e){
        if (e.target.closest('.fedit')) return;
        state.library.selectedFolderId = row.dataset.folder;
        renderFolderList();
        renderLibraryTable();
      });
      row.addEventListener('keydown', function(e){
        if ((e.key === 'Enter' || e.key === ' ') && e.target === row){
          e.preventDefault();
          state.library.selectedFolderId = row.dataset.folder;
          renderFolderList();
          renderLibraryTable();
        }
      });
    });
    el.querySelectorAll('.fedit[data-action="rename"]').forEach(function(btn){
      btn.addEventListener('click', function(e){ e.stopPropagation(); startRenameFolder(btn.dataset.folder); });
    });
    el.querySelectorAll('.fedit[data-action="delete"]').forEach(function(btn){
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        var folder = state.library.folders.find(function(f){ return f.id === btn.dataset.folder; });
        if (!folder) return;
        var n = folderItemCount(folder.id);
        showConfirmDialog(
          'Delete folder "' + folder.name + '"? ' + (n ? n + ' item' + (n===1?'':'s') + ' inside will move to Unfiled, not be deleted.' : 'It\'s empty.'),
          function(){
            state.library.items.forEach(function(it){ if (it.folderId === folder.id) it.folderId = null; });
            state.library.folders = state.library.folders.filter(function(f){ return f.id !== folder.id; });
            if (state.library.selectedFolderId === folder.id) state.library.selectedFolderId = 'all';
            persistLibraryFolders();
            persistLibraryItems();
            renderFolderList();
            renderLibraryTable();
          }
        );
      });
    });
  }

  function startRenameFolder(folderId){
    var folder = state.library.folders.find(function(f){ return f.id === folderId; });
    if (!folder) return;
    var row = document.querySelector('.folder-item[data-folder="' + folderId + '"]');
    if (!row) return;
    var nameEl = row.querySelector('.fname');
    var input = document.createElement('input');
    input.type = 'text';
    input.value = folder.name;
    input.maxLength = 60;
    input.style.cssText = 'flex:1; min-width:0; font-size:13px; padding:3px 6px; border:1px solid var(--accent); border-radius:5px; font-family:var(--font-body);';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    function commit(){
      var val = input.value.trim();
      if (val) folder.name = val;
      persistLibraryFolders();
      renderFolderList();
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ e.preventDefault(); input.blur(); }
      if (e.key === 'Escape'){ e.preventDefault(); renderFolderList(); }
    });
    input.addEventListener('click', function(e){ e.stopPropagation(); });
  }

  document.getElementById('newFolderBtn').addEventListener('click', function(){
    var row = document.getElementById('newFolderRow');
    var show = row.style.display === 'none';
    row.style.display = show ? 'flex' : 'none';
    if (show) document.getElementById('newFolderInput').focus();
  });
  function commitNewFolder(){
    var input = document.getElementById('newFolderInput');
    var name = input.value.trim();
    if (!name) return;
    var folder = { id: genUid('folder'), name: name };
    state.library.folders.push(folder);
    persistLibraryFolders();
    input.value = '';
    document.getElementById('newFolderRow').style.display = 'none';
    state.library.selectedFolderId = folder.id;
    renderFolderList();
    renderLibraryTable();
  }
  document.getElementById('newFolderConfirm').addEventListener('click', commitNewFolder);
  document.getElementById('newFolderInput').addEventListener('keydown', function(e){
    if (e.key === 'Enter'){ e.preventDefault(); commitNewFolder(); }
    if (e.key === 'Escape'){ e.preventDefault(); document.getElementById('newFolderRow').style.display = 'none'; }
  });

  // ---------- Item table ----------
  function libraryFilteredItems(){
    var q = (state.library.search || '').toLowerCase();
    return state.library.items.filter(function(it){
      var folderOk = state.library.selectedFolderId === 'all' ||
        (state.library.selectedFolderId === 'unfiled' ? !it.folderId : it.folderId === state.library.selectedFolderId);
      var searchOk = !q || it.title.toLowerCase().indexOf(q) !== -1 || (it.id || '').toLowerCase().indexOf(q) !== -1;
      return folderOk && searchOk;
    });
  }

  function libraryFolderName(folderId){
    if (!folderId) return 'Unfiled';
    var f = state.library.folders.find(function(x){ return x.id === folderId; });
    return f ? f.name : 'Unfiled';
  }

  function renderLibraryTable(){
    var wrap = document.getElementById('libraryTableWrap');
    if (!wrap) return;
    var items = libraryFilteredItems();
    var countEl = document.getElementById('libraryResultsCount');
    if (countEl) countEl.textContent = items.length + ' item' + (items.length===1?'':'s');

    if (!state.library.items.length){
      wrap.innerHTML = '<div class="empty-state"><div class="glyph">// </div><div class="title">Your library is empty</div><div class="sub">Save test cases here from Test Discovery\'s detail panel, or create one from scratch with "+ New Test Case".</div></div>';
      return;
    }
    if (!items.length){
      wrap.innerHTML = '<div class="empty-state"><div class="glyph">// </div><div class="title">No matches</div><div class="sub">Nothing here matches your search or the selected folder.</div></div>';
      return;
    }

    var html = '<div class="table-scroll"><table><thead><tr>' +
      '<th style="width:110px;">ID</th><th style="width:220px;">Title</th><th style="width:260px;">Steps</th>' +
      '<th style="width:90px;">Priority</th><th style="width:100px;">Status</th><th style="width:120px;">Folder</th><th style="width:120px;">Actions</th>' +
      '</tr></thead><tbody>';
    items.forEach(function(it){
      html += '<tr>' +
        '<td class="id-cell">' + escapeHtml(it.id || '—') + '</td>' +
        '<td class="title-cell">' + escapeHtml(it.title) + '</td>' +
        '<td class="steps-cell">' + (it.steps && it.steps.length ? '<ol>' + it.steps.map(function(s){ return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ol>' : '<span class="none">No steps</span>') + '</td>' +
        '<td><span class="badge ' + it.priority.toLowerCase() + '">' + escapeHtml(it.priority) + '</span></td>' +
        '<td><span class="badge status">' + escapeHtml(it.status) + '</span></td>' +
        '<td class="file-tag" style="display:block; font-size:11.5px;">' + escapeHtml(libraryFolderName(it.folderId)) + '</td>' +
        '<td><button class="action-link" data-action="edit" data-uid="' + it.uid + '">Edit</button> · <button class="action-link" data-action="delete" data-uid="' + it.uid + '" style="color:var(--red);">Delete</button></td>' +
        '</tr>';
    });
    html += '</tbody></table></div>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('[data-action="edit"]').forEach(function(btn){
      btn.addEventListener('click', function(){ openLibraryForm(btn.dataset.uid); });
    });
    wrap.querySelectorAll('[data-action="delete"]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var item = state.library.items.find(function(i){ return i.uid === btn.dataset.uid; });
        if (!item) return;
        showConfirmDialog('Delete "' + item.title + '" from the library? This can\'t be undone.', function(){
          state.library.items = state.library.items.filter(function(i){ return i.uid !== item.uid; });
          persistLibraryItems();
          renderFolderList();
          renderLibraryTable();
          renderTable();
        });
      });
    });
  }

  var librarySearchDebounceTimer = null;
  document.getElementById('librarySearch').addEventListener('input', function(e){
    var val = e.target.value;
    clearTimeout(librarySearchDebounceTimer);
    librarySearchDebounceTimer = setTimeout(function(){
      state.library.search = val;
      renderLibraryTable();
    }, 180);
  });

  document.getElementById('exportLibraryJsonBtn').addEventListener('click', function(){
    var items = libraryFilteredItems();
    if (!items.length) return;
    var withFolderNames = items.map(function(it){
      var copy = {};
      Object.keys(it).forEach(function(k){ copy[k] = it[k]; });
      copy.folder = libraryFolderName(it.folderId);
      return copy;
    });
    downloadBlob(JSON.stringify(withFolderNames, null, 2), 'library.json', 'application/json');
  });

  document.getElementById('exportLibraryCsvBtn').addEventListener('click', function(){
    var items = libraryFilteredItems();
    if (!items.length) return;
    var header = ['ID', 'Title', 'Folder', 'Priority', 'Status', 'Steps', 'Requirement', 'Tags'];
    var lines = [header.map(csvEscape).join(',')];
    items.forEach(function(it){
      lines.push([
        it.id || '', it.title, libraryFolderName(it.folderId), it.priority, it.status,
        (it.steps || []).map(function(s, i){ return (i+1) + '. ' + s; }).join(' | '),
        it.requirement || '', (it.tags || []).join('; ')
      ].map(csvEscape).join(','));
    });
    downloadBlob(lines.join('\r\n'), 'library.csv', 'text/csv');
  });

  // ---------- Add/edit form ----------
  var libraryFormOverlay = document.getElementById('libraryFormOverlay');
  var libraryFormModal = document.getElementById('libraryFormModal');

  function populateFolderSelect(selectedFolderId, targetEl){
    var sel = targetEl || document.getElementById('lfFolder');
    sel.innerHTML = '<option value="">Unfiled</option>' + state.library.folders.map(function(f){
      return '<option value="' + f.id + '"' + (f.id === selectedFolderId ? ' selected' : '') + '>' + escapeHtml(f.name) + '</option>';
    }).join('');
  }

  function openLibraryForm(uid){
    state.library.editingUid = uid || null;
    var item = uid ? state.library.items.find(function(i){ return i.uid === uid; }) : null;
    document.getElementById('libraryFormTitle').textContent = item ? 'Edit Test Case' : 'New Test Case';
    document.getElementById('lfTitle').value = item ? item.title : '';
    document.getElementById('lfId').value = item ? (item.id || '') : '';
    document.getElementById('lfPriority').value = item ? item.priority : 'Medium';
    document.getElementById('lfStatus').value = item ? item.status : 'Unrun';
    document.getElementById('lfSteps').value = item && item.steps ? item.steps.join('\n') : '';
    document.getElementById('lfRequirement').value = item ? (item.requirement || '') : '';
    document.getElementById('lfTags').value = item && item.tags ? item.tags.join(', ') : '';
    var defaultFolder = item ? item.folderId : ((state.library.selectedFolderId !== 'all' && state.library.selectedFolderId !== 'unfiled') ? state.library.selectedFolderId : '');
    populateFolderSelect(defaultFolder || '');
    libraryFormOverlay.classList.add('show');
    libraryFormModal.classList.add('show');
    document.getElementById('lfTitle').focus();
  }
  function closeLibraryForm(){
    libraryFormOverlay.classList.remove('show');
    libraryFormModal.classList.remove('show');
    state.library.editingUid = null;
  }
  document.getElementById('newLibraryItemBtn').addEventListener('click', function(){ openLibraryForm(null); });
  document.getElementById('libraryFormClose').addEventListener('click', closeLibraryForm);
  document.getElementById('lfCancelBtn').addEventListener('click', closeLibraryForm);
  libraryFormOverlay.addEventListener('click', closeLibraryForm);

  document.getElementById('lfSaveBtn').addEventListener('click', function(){
    var title = document.getElementById('lfTitle').value.trim();
    if (!title){ document.getElementById('lfTitle').focus(); return; }
    var steps = document.getElementById('lfSteps').value.split('\n').map(function(s){ return s.trim(); }).filter(Boolean);
    var tags = document.getElementById('lfTags').value.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
    var folderVal = document.getElementById('lfFolder').value || null;
    var idVal = document.getElementById('lfId').value.trim();
    var priority = document.getElementById('lfPriority').value;
    var status = document.getElementById('lfStatus').value;
    var requirement = document.getElementById('lfRequirement').value.trim() || null;

    if (state.library.editingUid){
      var item = state.library.items.find(function(i){ return i.uid === state.library.editingUid; });
      if (item){
        item.title = title;
        item.id = idVal || item.id;
        item.priority = priority;
        item.status = status;
        item.steps = steps;
        item.requirement = requirement;
        item.tags = tags;
        item.folderId = folderVal;
        item.updatedAt = Date.now();
      }
    } else {
      state.library.items.push({
        uid: genUid('item'),
        id: idVal || (slugify(title) + '-' + (state.library.items.length + 1)),
        title: title, priority: priority, status: status, steps: steps,
        requirement: requirement, tags: tags, folderId: folderVal,
        createdAt: Date.now(), updatedAt: Date.now()
      });
    }
    persistLibraryItems();
    closeLibraryForm();
    renderFolderList();
    renderLibraryTable();
  });

  // ---------- Save from Discovery ----------
  // Upserts rather than always appending: a test saved before (matched by its
  // source file + ID) gets its content refreshed in place instead of creating a
  // duplicate row every time you re-scan or re-save. Its existing folder is left
  // alone unless it's currently Unfiled, in which case the chosen folder applies.
  // Manually-created library items (no sourceKey) are never touched by this.
  function saveTestsToLibrary(tests, folderId){
    var created = 0, updated = 0;
    tests.forEach(function(t){
      var sourceKey = t.file + '::' + t.id;
      var existing = state.library.items.find(function(it){ return it.sourceKey === sourceKey; });
      if (existing){
        existing.title = t.title;
        existing.priority = t.priority;
        existing.status = t.status;
        existing.steps = (t.steps || []).slice();
        existing.requirement = t.requirement || null;
        existing.tags = (t.tags || []).slice();
        existing.updatedAt = Date.now();
        if (!existing.folderId && folderId) existing.folderId = folderId;
        updated++;
      } else {
        state.library.items.push({
          uid: genUid('item'), id: t.id, title: t.title, priority: t.priority, status: t.status,
          steps: (t.steps || []).slice(), requirement: t.requirement || null, tags: (t.tags || []).slice(),
          folderId: folderId, sourceKey: sourceKey, sourceFile: t.file,
          createdAt: Date.now(), updatedAt: Date.now()
        });
        created++;
      }
    });
    persistLibraryItems();
    renderFolderList();
    renderLibraryTable();
    renderTable();
    return { created: created, updated: updated };
  }

  var saveToLibraryOverlay = document.getElementById('saveToLibraryOverlay');
  var saveToLibraryModal = document.getElementById('saveToLibraryModal');
  var pendingSaveTests = [];

  function openSaveToLibraryDialog(tests){
    if (!tests.length) return;
    pendingSaveTests = tests;
    document.getElementById('saveToLibraryMessage').textContent =
      'Save ' + tests.length + ' test case' + (tests.length===1?'':'s') + ' to the Library — which folder? Anything already saved from the same source updates in place instead of duplicating.';
    populateFolderSelect(state.autoSaveLibraryFolderId || '', document.getElementById('saveToLibraryFolderSelect'));
    saveToLibraryOverlay.classList.add('show');
    saveToLibraryModal.classList.add('show');
  }
  function closeSaveToLibraryDialog(){
    saveToLibraryOverlay.classList.remove('show');
    saveToLibraryModal.classList.remove('show');
    pendingSaveTests = [];
  }
  document.getElementById('saveToLibraryCancelBtn').addEventListener('click', closeSaveToLibraryDialog);
  saveToLibraryOverlay.addEventListener('click', closeSaveToLibraryDialog);
  document.getElementById('saveToLibraryConfirmBtn').addEventListener('click', function(){
    var folderId = document.getElementById('saveToLibraryFolderSelect').value || null;
    var tests = pendingSaveTests;
    var result = saveTestsToLibrary(tests, folderId);
    closeSaveToLibraryDialog();
    logLine('Library: saved ' + result.created + ' new, updated ' + result.updated + ' existing.', 'ok');
    scanLogEl.classList.add('show');
  });

  document.getElementById('drawerSaveToLibrary').addEventListener('click', function(){
    if (!currentDrawerUid) return;
    var t = state.testCases.find(function(x){ return x.uid === currentDrawerUid; });
    if (!t) return;
    openSaveToLibraryDialog([t]);
  });

  document.getElementById('saveAllToLibraryBtn').addEventListener('click', function(){
    var rows = sortRows(state.testCases.filter(matchesFilters));
    if (!rows.length){ logLine('Nothing currently visible to save — adjust your filters first.', 'warn'); scanLogEl.classList.add('show'); return; }
    openSaveToLibraryDialog(rows);
  });

  // ---------- Auto-save on scan ----------
  var AUTOSAVE_SETTINGS_KEY = 'autosave-library-settings';
  state.autoSaveLibrary = false;
  state.autoSaveLibraryFolderId = null;

  function persistAutoSaveSettings(){
    safeStorageSet(AUTOSAVE_SETTINGS_KEY, JSON.stringify({ enabled: state.autoSaveLibrary, folderId: state.autoSaveLibraryFolderId }), false)
      .catch(function(err){ console.error('Could not save auto-save settings', err); });
  }
  function loadAutoSaveSettings(){
    safeStorageGet(AUTOSAVE_SETTINGS_KEY, false)
      .then(function(res){
        var parsed = (res && res.value) ? JSON.parse(res.value) : null;
        if (parsed){
          state.autoSaveLibrary = !!parsed.enabled;
          state.autoSaveLibraryFolderId = parsed.folderId || null;
        }
        document.getElementById('autoSaveLibraryToggle').checked = state.autoSaveLibrary;
        var folderSel = document.getElementById('autoSaveFolderSelect');
        folderSel.style.display = state.autoSaveLibrary ? '' : 'none';
        populateFolderSelect(state.autoSaveLibraryFolderId || '', folderSel);
      })
      .catch(function(){});
  }
  document.getElementById('autoSaveLibraryToggle').addEventListener('change', function(e){
    state.autoSaveLibrary = e.target.checked;
    document.getElementById('autoSaveFolderSelect').style.display = state.autoSaveLibrary ? '' : 'none';
    persistAutoSaveSettings();
  });
  document.getElementById('autoSaveFolderSelect').addEventListener('change', function(e){
    state.autoSaveLibraryFolderId = e.target.value || null;
    persistAutoSaveSettings();
  });

  // Called after every completed local/repo/Smart Import scan when the toggle is on.
  function maybeAutoSaveToLibrary(){
    if (!state.autoSaveLibrary || !state.testCases.length) return;
    var result = saveTestsToLibrary(state.testCases, state.autoSaveLibraryFolderId);
    logLine('Auto-saved to Library: ' + result.created + ' new, ' + result.updated + ' updated.', 'ok', true);
  }

  renderTable();
  updateOverview();
  renderSourcesList();
  loadScanHistory();
  loadPersistedTestCases();
  loadLibrary();
  loadAutoSaveSettings();
})();