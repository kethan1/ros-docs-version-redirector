// Finds "the same page" in another distro. Runs in the background service
// worker (and under Node for the tests). Depends on distros.js.
//
// resolveTarget() returns { match, fallbacks } where
//   match:     { url, confidence, title? } or null
//              confidence: "exact"      same path exists in the target distro
//                          "moved"      page was moved/renamed; found by filename or title
//                          "fuzzy"      best similar page (title/filename similarity)
//                          "unverified" best guess; existence couldn't be checked
//   fallbacks: [{ label, url }] other places to go when there is no good match

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Network helpers

// docs.ros.org / docs.ros2.org sit behind Anubis bot protection, which answers
// some requests with a JS challenge page (HTTP 200) instead of the real page.
// Static files come with ETag/Last-Modified; challenge pages don't.
function isStaticFile(res) {
  return res.headers.has("etag") || res.headers.has("last-modified");
}

const CHALLENGE_MARKER = /\/\.within\.website\/|Making sure you(&#39;|')re not a bot/;
const isGone = (res) => res.status === 404 || res.status === 410;

// "yes" | "no" | "unknown"
async function probe(url) {
  const noHash = url.split("#")[0];
  const opts = { credentials: "omit", cache: "no-store" };
  try {
    const head = await fetch(noHash, { ...opts, method: "HEAD" });
    if (isGone(head)) return "no";
    if (head.ok && isStaticFile(head)) return "yes";
    // Generated pages (directory listings) also lack those headers, so look at
    // the body to tell them apart from a challenge.
    const res = await fetch(noHash, opts);
    if (isGone(res)) return "no";
    if (!res.ok) return "unknown";
    return CHALLENGE_MARKER.test(await res.text()) ? "unknown" : "yes";
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Sphinx search index (list of pages + titles) per distro, cached

const memIndexes = new Map(); // distro -> Promise<index>

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

async function fetchIndex(distro) {
  const res = await fetch(`https://docs.ros.org/en/${distro}/searchindex.js`, {
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`searchindex for ${distro}: HTTP ${res.status}`);
  const text = await res.text();
  // "Search.setIndex({...})" — anything else (e.g. a challenge page) fails to parse.
  const json = JSON.parse(text.slice(text.indexOf("(") + 1, text.lastIndexOf(")")));
  return { docnames: json.docnames, titles: json.titles.map(stripTags) };
}

const persistentStore = globalThis.chrome?.storage?.local;

async function loadIndex(distro) {
  const key = `index:${distro}`;
  const cached = persistentStore ? (await persistentStore.get(key))[key] : undefined;
  if (cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) return cached;
  try {
    const fresh = { ...(await fetchIndex(distro)), fetchedAt: Date.now() };
    await persistentStore?.set({ [key]: fresh });
    return fresh;
  } catch (e) {
    if (cached) return cached; // stale beats nothing
    throw e;
  }
}

function getIndex(distro) {
  if (!memIndexes.has(distro)) {
    const p = loadIndex(distro).then((idx) => ({
      ...idx,
      pos: new Map(idx.docnames.map((d, i) => [d, i])),
    }));
    p.catch(() => memIndexes.delete(distro));
    memIndexes.set(distro, p);
  }
  return memIndexes.get(distro);
}

// ---------------------------------------------------------------------------
// Matching a moved page

const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "from",
  "your", "using", "about", "ros", "ros2", "2",
]);

function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/c\+\+/g, "cpp")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t === "py" ? "python" : t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

const isPrefixPair = (a, b) => Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a));

// Dice coefficient over tokens; a prefix pair ("deb" ~ "debian") counts half.
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const used = new Set();
  let matched = 0;
  for (const x of a) {
    let j = b.findIndex((y, k) => !used.has(k) && y === x);
    let weight = 1;
    if (j < 0) {
      j = b.findIndex((y, k) => !used.has(k) && isPrefixPair(x, y));
      weight = 0.5;
    }
    if (j >= 0) {
      used.add(j);
      matched += weight;
    }
  }
  return (2 * matched) / (a.length + b.length);
}

const basename = (doc) => doc.slice(doc.lastIndexOf("/") + 1);
const dirsOf = (doc) => doc.toLowerCase().split("/").slice(0, -1);
const normTitle = (t) => (t || "").toLowerCase().replace(/\s+/g, " ").trim();
const languageOf = (toks) => (toks.includes("cpp") ? "cpp" : toks.includes("python") ? "python" : null);
// Pages that differ in these respects are different pages, however similar the names.
const conflicts = (a, b) => (a.lang && b.lang && a.lang !== b.lang) || a.negated !== b.negated;

function pageFeatures(doc, title) {
  const base = basename(doc);
  const baseTok = tokens(base);
  const titleTok = tokens(title);
  return {
    doc,
    baseLower: base.toLowerCase(),
    baseTok,
    titleTok,
    titleN: normTitle(title),
    dirs: dirsOf(doc),
    dirTok: tokens(dirsOf(doc).join(" ")),
    lang: languageOf([...baseTok, ...titleTok]),
    negated: [...baseTok, ...titleTok].includes("non"),
  };
}

const featureCache = new WeakMap(); // index -> features of each of its pages
function indexFeatures(idx) {
  if (!featureCache.has(idx)) {
    featureCache.set(idx, idx.docnames.map((d, i) => pageFeatures(d, idx.titles[i])));
  }
  return featureCache.get(idx);
}

// Finds where `doc` (with page title `title`) lives in the target index.
// Returns { doc, confidence: "moved" | "fuzzy" } or null.
function findMoved(doc, title, idx) {
  const src = pageFeatures(doc, title);
  const base = basename(doc);
  const titleTok = src.titleTok;
  const dirs = new Set(src.dirs);

  const scored = indexFeatures(idx).map((c) => {
    const baseEq = c.baseLower === src.baseLower;
    const titleEq = !!src.titleN && c.titleN === src.titleN;
    const baseSim = similarity(src.baseTok, c.baseTok);
    const titleSim = similarity(src.titleTok, c.titleTok);
    const overlap = c.dirs.filter((d) => dirs.has(d)).length;
    const dirSim = similarity(src.dirTok, c.dirTok);
    const score = conflicts(src, c)
      ? -1
      : (baseEq ? 10 : 0) + (titleEq ? 6 : 0) + 3 * baseSim + 3 * titleSim + 1.5 * dirSim;
    return { cand: c.doc, baseEq, titleEq, baseSim, titleSim, overlap, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score <= 0) return null;
  const margin = best.score - (second?.score ?? 0);
  if (margin < 0.25) return null; // too close to call

  // A shared filename is strong evidence unless the name is generic ("Cpp").
  const strongBase =
    best.baseEq && (base.includes("-") || best.titleSim >= 0.8 || best.overlap >= 1);
  const strongTitle =
    best.titleEq && (titleTok.length >= 2 || best.baseSim >= 0.6 || best.overlap >= 1);
  if (strongBase || strongTitle) return { doc: best.cand, confidence: "moved" };

  if (Math.max(best.baseSim, best.titleSim) >= 0.7 && margin >= 0.75) {
    return { doc: best.cand, confidence: "fuzzy" };
  }
  return null;
}

// "Tutorials/Foo.html" -> "Tutorials/Foo"; "" or "dir/" -> ".../index"; else null
function docnameOf(rest) {
  if (rest === "" || rest.endsWith("/")) return rest + "index";
  if (rest.endsWith(".html")) return rest.slice(0, -5);
  return null;
}

// ---------------------------------------------------------------------------
// Resolution per page kind

async function resolveDocsPage(page, target, smart) {
  const T = distroLabel(target);
  const base = `https://docs.ros.org/en/${target}/`;
  const tail = page.search + page.hash;
  const exactUrl = base + page.rest + tail;

  if (!getDistro(target)?.docs) return { match: null, fallbacks: [] };
  if (!smart) return { match: { url: exactUrl, confidence: "unverified" }, fallbacks: [] };

  const doc = docnameOf(page.rest);
  const [src, tgt] = await Promise.all([
    getIndex(page.distro).catch(() => null),
    getIndex(target).catch(() => null),
  ]);
  const title = src && doc != null && src.pos.has(doc) ? src.titles[src.pos.get(doc)] : null;

  const fallbacks = [];
  if (title) {
    fallbacks.push({
      label: `Search ${T} docs`,
      url: `${base}search.html?q=${encodeURIComponent(title)}`,
    });
  }
  fallbacks.push({ label: `${T} docs home`, url: `${base}index.html` });

  if (tgt && doc != null) {
    if (tgt.pos.has(doc)) {
      return { match: { url: exactUrl, confidence: "exact", title: tgt.titles[tgt.pos.get(doc)] }, fallbacks };
    }
    if (title != null) {
      // A real page in the source distro that isn't at the same path in the target.
      const m = findMoved(doc, title, tgt);
      if (!m) return { match: null, fallbacks };
      const url = base + (m.doc === "index" ? "index.html" : m.doc + ".html") + tail;
      return { match: { url, confidence: m.confidence, title: tgt.titles[tgt.pos.get(m.doc)] }, fallbacks };
    }
  }

  // Not a regular page (genindex, search, images, ...) or no index: check directly.
  const exists = await probe(exactUrl);
  if (exists === "no") return { match: null, fallbacks };
  return { match: { url: exactUrl, confidence: exists === "yes" ? "exact" : "unverified" }, fallbacks };
}

// Candidate URLs for a package page in the target distro, best first.
function packageCandidates(page, target) {
  const { pkg, rest, layout } = page;
  const tail = page.search + page.hash;
  const api = getDistro(target)?.api;

  if (api === "rosdoc2") {
    const root = `https://docs.ros.org/en/${target}/p/${pkg}/`;
    const index = `https://docs.ros.org/en/${target}/p/`;
    if (!rest || rest === "index.html" || rest === "index-msg.html") return { list: [root], root, index };
    if (layout === "rosdoc2") return { list: [root + rest + tail], root, index };
    // Legacy Doxygen/Sphinx docs -> rosdoc2. Message pages (msg/Foo.html) and
    // Python docs keep their paths; Doxygen pages moved under generated/
    // (Sphinx-rendered) and generated/doxygen/html/ (raw Doxygen, same anchors).
    const list = [root + rest + tail];
    if (!rest.includes("/")) {
      const sphinx = `${root}generated/${rest}${tail}`;
      const doxygen = `${root}generated/doxygen/html/${rest}${tail}`;
      const doxygenAnchor = /^#a[0-9a-f]{32}$/.test(page.hash);
      list.push(...(doxygenAnchor ? [doxygen, sphinx] : [sphinx, doxygen]));
    }
    return { list, root, index };
  }

  if (api === "legacy") {
    const root = `https://docs.ros2.org/${target}/api/${pkg}/`;
    const index = `https://docs.ros2.org/${target}/api/`;
    const r = layout === "rosdoc2" ? rest.replace(/^generated\/(doxygen\/html\/)?/, "") : rest;
    if (!r || r === "index.html") return { list: [root], root, index };
    return { list: [root + r + tail], root, index };
  }

  return null;
}

async function resolvePackagePage(page, target, smart) {
  const T = distroLabel(target);
  const c = packageCandidates(page, target);
  if (!c) return { match: null, fallbacks: [] };
  if (!smart) return { match: { url: c.list[0], confidence: "unverified" }, fallbacks: [] };

  let unverified = null;
  for (const url of c.list) {
    const exists = await probe(url);
    if (exists === "yes") return { match: { url, confidence: "exact" }, fallbacks: [] };
    if (exists === "unknown") unverified ??= url;
  }
  if (unverified) return { match: { url: unverified, confidence: "unverified" }, fallbacks: [] };

  const fallbacks = [];
  const isRootRequest = c.list[0] === c.root;
  if (!isRootRequest && (await probe(c.root)) !== "no") {
    fallbacks.push({ label: `${page.pkg} docs (${T})`, url: c.root });
  }
  fallbacks.push({ label: `All ${T} packages`, url: c.index });
  fallbacks.push({ label: `${page.pkg} on index.ros.org`, url: `https://index.ros.org/p/${page.pkg}/` });
  return { match: null, fallbacks };
}

async function resolvePackageIndex(target, smart) {
  const api = getDistro(target)?.api;
  const url = api === "rosdoc2" ? `https://docs.ros.org/en/${target}/p/` : `https://docs.ros2.org/${target}/api/`;
  if (!smart) return { match: { url, confidence: "unverified" }, fallbacks: [] };
  const exists = await probe(url);
  return { match: exists === "no" ? null : { url, confidence: exists === "yes" ? "exact" : "unverified" }, fallbacks: [] };
}

async function resolveTarget(page, target, { smart = true } = {}) {
  if (page.kind === "docs") return resolveDocsPage(page, target, smart);
  if (page.kind === "pkg") return resolvePackagePage(page, target, smart);
  return resolvePackageIndex(target, smart);
}
