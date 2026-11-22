(() => {
  const WATCH_DURATION_MS = 15000;
  const WATCH_KEY_PREFIX = "popupWatch:";
  const SAFE_POPUP_DOMAINS = [
    "google.com",
    "youtube.com",
    "facebook.com",
    "instagram.com",
    "whatsapp.com",
    "x.com",
    "twitter.com",
    "linkedin.com",
    "microsoft.com",
    "apple.com",
    "paypal.com",
    "github.com",
    "amazon.com",
    "discord.com",
    "reddit.com",
    "pinterest.com",
    "telegram.org",
    "t.me",
    "tiktok.com",
    "wikipedia.org",
    "yahoo.com",
    "bing.com"
  ];
  const EXTRA_AD_DOMAINS = [
    "popads.net",
    "popcash.net",
    "propellerads.com",
    "exoclick.com",
    "trafficjunky.net",
    "onclickads.net",
    "clickadu.com",
    "hilltopads.com",
    "monetag.com",
    "ad-maven.com",
    "richads.com",
    "juicyads.com"
  ];

  function isDomainOrSubdomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
  }

  function isRelatedHost(first, second) {
    return Boolean(first && second)
      && (isDomainOrSubdomain(first, second) || isDomainOrSubdomain(second, first));
  }

  function isSafeHost(host) {
    return SAFE_POPUP_DOMAINS.some((domain) => isDomainOrSubdomain(host, domain));
  }

  function matchesAdHost(host, adDomains) {
    return adDomains.some((domain) => isDomainOrSubdomain(host, domain));
  }

  function hasAdLikeHostLabel(host) {
    return host.split(".").some((label) => (
      /(^|[-_])(ad|ads|adserver|adservice|popup|popunder|click|tracking|track|promo|redirect|casino|bet|adult)([-_]|$)/i
        .test(label)
    ));
  }

  function getWatchKey(tabId) {
    return `${WATCH_KEY_PREFIX}${tabId}`;
  }

  async function getWebTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url || "");
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  }

  async function getSourceFrameHost(tabId, frameId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const frame = frames?.find((candidate) => candidate.frameId === frameId);
      return frame ? new URL(frame.url).hostname.toLowerCase() : "";
    } catch {
      return "";
    }
  }

  async function closeIfAdPopup(tabId, url, watch, adDomains) {
    if (Date.now() > watch.expiresAt || !/^https?:/i.test(url || "")) {
      return false;
    }
    let destination;
    try {
      destination = new URL(url);
    } catch {
      return false;
    }
    const host = destination.hostname.toLowerCase();
    if (isRelatedHost(host, watch.sourceHost) || isSafeHost(host)) {
      return false;
    }
    if (!watch.fromFrame
      && !matchesAdHost(host, adDomains)
      && !hasAdLikeHostLabel(host)) {
      return false;
    }

    await chrome.tabs.remove(tabId);
    await chrome.storage.session.remove(getWatchKey(tabId));
    console.info(`Blocked a pop-up navigation to ${host}.`);
    return true;
  }

  async function watchNewTab(details, adDomains, getSettings, isPageOrSitePaused) {
    if (!Number.isInteger(details.tabId) || !Number.isInteger(details.sourceTabId)
      || !Number.isInteger(details.sourceFrameId)) {
      return;
    }
    const sourceTabUrl = await getWebTab(details.sourceTabId);
    if (!sourceTabUrl) {
      return;
    }
    const settings = await getSettings();
    if (isPageOrSitePaused(sourceTabUrl.href, settings)) {
      return;
    }
    const sourceHost = await getSourceFrameHost(details.sourceTabId, details.sourceFrameId);
    const watch = {
      sourceHost,
      fromFrame: details.sourceFrameId > 0,
      sourceTabId: details.sourceTabId,
      sourcePageUrl: sourceTabUrl.href,
      expiresAt: Date.now() + WATCH_DURATION_MS
    };
    await chrome.storage.session.set({ [getWatchKey(details.tabId)]: watch });
    await closeIfAdPopup(details.tabId, details.url, watch, adDomains);
  }

  async function checkNewTabNavigation(details, adDomains, getSettings, isPageOrSitePaused) {
    if (details.frameId !== 0 || !Number.isInteger(details.tabId)) {
      return;
    }
    const key = getWatchKey(details.tabId);
    const stored = await chrome.storage.session.get(key);
    const watch = stored[key];
    if (!watch) {
      return;
    }
    if (Date.now() > watch.expiresAt) {
      await chrome.storage.session.remove(key);
      return;
    }
    const sourceTabUrl = await getWebTab(watch.sourceTabId);
    if (!sourceTabUrl || sourceTabUrl.origin !== new URL(watch.sourcePageUrl).origin) {
      await chrome.storage.session.remove(key);
      return;
    }
    const settings = await getSettings();
    if (isPageOrSitePaused(sourceTabUrl.href, settings)) {
      await chrome.storage.session.remove(key);
      return;
    }
    await closeIfAdPopup(details.tabId, details.url, watch, adDomains);
  }

  function init(adDomains = [], { getSettings, isPageOrSitePaused }) {
    const domains = [...new Set([...adDomains, ...EXTRA_AD_DOMAINS])]
      .filter((domain) => typeof domain === "string")
      .map((domain) => domain.toLowerCase());
    chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
      watchNewTab(details, domains, getSettings, isPageOrSitePaused)
        .catch((error) => console.warn("Unable to track a pop-up:", error));
    });
    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      checkNewTabNavigation(details, domains, getSettings, isPageOrSitePaused)
        .catch((error) => console.warn("Unable to inspect a pop-up redirect:", error));
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      chrome.storage.session.remove(getWatchKey(tabId))
        .catch((error) => console.warn("Unable to clean up pop-up tracking:", error));
    });
  }

  self.PopupProtection = { init };
})();
