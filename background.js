importScripts("distros.js", "resolver.js");

// Existence checks identify themselves instead of sending Chrome's user agent.
// docs.ros.org's bot protection (Anubis) challenges anything that claims to be
// a browser, which would make every check come back "unknown"; it serves
// self-identified tools normally. Applies only to this extension's own
// requests (tabId -1), never to pages you browse.
const CHECKER_UA = "ROS2DocsVersionRedirect/1.0 (browser extension; checks which docs pages exist)";
const ready = chrome.declarativeNetRequest
  .updateSessionRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "User-Agent", operation: "set", value: CHECKER_UA }],
        },
        condition: {
          requestDomains: ["docs.ros.org", "docs.ros2.org"],
          tabIds: [-1],
          resourceTypes: ["xmlhttprequest"],
        },
      },
    ],
  })
  .catch((e) => console.warn("Could not install user-agent rule:", e));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

// Per-tab state (cleared when the browser closes):
//   stayed: distros the user chose to stay on in this tab
//   note:   info about an automatic redirect, shown on the destination page
const tabKey = (tabId) => `tab:${tabId}`;
const NOTE_MAX_AGE_MS = 30_000;

async function getTabState(tabId) {
  const key = tabKey(tabId);
  return (await chrome.storage.session.get(key))[key] ?? { stayed: [] };
}

async function setTabState(tabId, state) {
  await chrome.storage.session.set({ [tabKey(tabId)]: state });
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

const handlers = {
  // { url, target, smart } -> { match, fallbacks } | null
  async resolve({ url, target, smart }) {
    await ready;
    const page = parseDocsUrl(url);
    return page ? resolveTarget(page, target, { smart }) : null;
  },

  // -> { stayed, note }
  async tabState(_msg, tabId) {
    const { stayed = [], note } = await getTabState(tabId);
    return { stayed, note: note && Date.now() - note.at < NOTE_MAX_AGE_MS ? note : null };
  },

  async clearNote(_msg, tabId) {
    const { note, ...rest } = await getTabState(tabId);
    await setTabState(tabId, rest);
  },

  async stay({ distro }, tabId) {
    const state = await getTabState(tabId);
    state.stayed = [...new Set([...(state.stayed ?? []), distro])];
    await setTabState(tabId, state);
  },

  async setNote({ note }, tabId) {
    const state = await getTabState(tabId);
    await setTabState(tabId, { ...state, note: { ...note, at: Date.now() } });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler || sender.tab?.id == null) return;
  handler(msg, sender.tab.id).then(
    (result) => sendResponse(result ?? null),
    (e) => {
      console.error(e);
      sendResponse(null);
    }
  );
  return true; // async reply
});
