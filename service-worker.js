let activeSession = null;
let offscreenCreation = null;
const pendingTabStops = new Map();
const youtubeAdPlaybackTabs = new Set();
const recoveringSessions = new Set();
const YOUTUBE_AD_RULE_IDS = [62001, 62002, 62003, 62004];
const GENERAL_AD_RULE_IDS = [
  63001, 63002, 63003, 63004, 63005, 63006, 63007, 63008, 63009, 63010,
  63011, 63012, 63013, 63014, 63015, 63016, 63017, 63018, 63019, 63020
];
const PAGE_ALLOW_RULE_BASE = 1000000000;
const MAX_AD_FILTER_SITES = 100;
const MAX_CUSTOM_AD_RULES = 500;
const MAX_LOCAL_AD_REPORTS = 200;
let adStatsWriteQueue = Promise.resolve();
const AUTO_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const AUTO_RECOVERY_STABLE_SESSION_MS = 2 * 60 * 1000;
const MAX_AUTO_RELOADS = 2;
const GENERAL_AD_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "adsrvr.org",
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "pubmatic.com",
  "openx.net",
  "rubiconproject.com",
  "amazon-adsystem.com",
  "adform.net",
  "media.net",
  "smartadserver.com",
  "sharethrough.com",
  "casalemedia.com",
  "serving-sys.com",
  "lijit.com",
  "33across.com"
];
const YOUTUBE_AD_URL_FILTERS = [
  "||youtube.com/pagead/",
  "||youtube.com/youtubei/v1/player/ad_break",
  "||youtube.com/get_midroll_",
  "||youtube.com/get_video_info?*adunit"
];
const YOUTUBE_AD_SELECTORS = [
  "ytd-ad-slot-renderer",
  "ytd-in-feed-ad-layout-renderer",
  "ytd-banner-promo-renderer",
  "ytd-promoted-sparkles-web-renderer",
  "ytd-compact-promoted-item-renderer",
  "#player-ads",
  ".ytp-ad-image-overlay",
  ".ytp-ad-text-overlay"
];

function normalizeAdFilterPage(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeAdFilterSite(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  try {
    return new URL(`https://${value.trim().replace(/^\.+/, "")}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function getPageAllowRuleId(tabId) {
  return PAGE_ALLOW_RULE_BASE + tabId;
}

async function getAdFilterSettings() {
  return chrome.storage.local.get({
    adFilterPausedSites: [],
    adFilterPausedPages: [],
    adFilterCustomRules: [],
    adFilterStats: { totalCount: 0, byPage: {} },
    adFilterReports: []
  });
}

function buildGeneralAdRules(pausedSites) {
  return GENERAL_AD_DOMAINS.map((domain, index) => ({
    id: GENERAL_AD_RULE_IDS[index],
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: `||${domain}^`,
      domainType: "thirdParty",
      ...(pausedSites.length ? { excludedInitiatorDomains: pausedSites } : {})
    }
  }));
}

function buildYoutubeAdRules(pausedSites) {
  return YOUTUBE_AD_URL_FILTERS.map((urlFilter, index) => ({
    id: YOUTUBE_AD_RULE_IDS[index],
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter,
      initiatorDomains: ["youtube.com"],
      resourceTypes: ["xmlhttprequest", "image", "script", "sub_frame"],
      ...(pausedSites.length ? { excludedInitiatorDomains: pausedSites } : {})
    }
  }));
}

function buildPageAllowRule(tabId) {
  return {
    id: getPageAllowRuleId(tabId),
    priority: 1000,
    action: { type: "allow" },
    condition: { tabIds: [tabId] }
  };
}

async function updateAdBlockingRules() {
  const settings = await getAdFilterSettings();
  const pausedSites = settings.adFilterPausedSites
    .map(normalizeAdFilterSite)
    .filter(Boolean)
    .slice(0, MAX_AD_FILTER_SITES);
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const pausedPageRules = tabs
    .filter((tab) => typeof tab.id === "number"
      && settings.adFilterPausedPages.includes(normalizeAdFilterPage(tab.url || "")))
    .map((tab) => buildPageAllowRule(tab.id));
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules();
  const ownedRuleIds = new Set([...YOUTUBE_AD_RULE_IDS, ...GENERAL_AD_RULE_IDS]);
  const removeRuleIds = currentRules
    .filter((rule) => ownedRuleIds.has(rule.id)
      || (rule.id >= PAGE_ALLOW_RULE_BASE && rule.id < PAGE_ALLOW_RULE_BASE + 100000000))
    .map((rule) => rule.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: [
      ...buildGeneralAdRules(pausedSites),
      ...buildYoutubeAdRules(pausedSites),
      ...pausedPageRules
    ]
  });
}

async function updatePageAllowRule(tabId, pageUrl) {
  const ruleId = getPageAllowRuleId(tabId);
  const settings = await getAdFilterSettings();
  const shouldAllow = settings.adFilterPausedPages.includes(normalizeAdFilterPage(pageUrl || ""));
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: shouldAllow ? [buildPageAllowRule(tabId)] : []
  });
}

async function broadcastAdFilterConfig() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(tabs.map(async (tab) => {
    if (typeof tab.id !== "number") {
      return;
    }
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {}
      });
      await Promise.all(frames.map((frame) =>
        sendToFrame(tab.id, frame.frameId, { type: "AD_FILTER_CONFIG_CHANGED" }).catch(() => {})
      ));
    } catch (error) {
      console.warn(`Unable to refresh local ad-filter settings in tab ${tab.id}:`, error);
    }
  }));
}

async function broadcastYoutubeAdBlocking(enabled) {
  const settings = await getAdFilterSettings();
  const tabs = await chrome.tabs.query({ url: ["https://youtube.com/*", "https://*.youtube.com/*"] });
  await Promise.all(tabs.map(async (tab) => {
    if (typeof tab.id !== "number") {
      return;
    }
    const url = normalizeAdFilterPage(tab.url || "");
    if (!url) {
      return;
    }
    const paused = isPageOrSitePaused(url, settings);
    const tabEnabled = enabled && !paused;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "YOUTUBE_AD_BLOCKING_CHANGED", enabled: tabEnabled });
    } catch {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: ["youtube-main-world.js"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["youtube-ad-filter.js"]
        });
        await chrome.tabs.sendMessage(tab.id, { type: "YOUTUBE_AD_BLOCKING_CHANGED", enabled: tabEnabled });
      } catch (error) {
        console.warn(`Unable to update YouTube ad blocking in tab ${tab.id}:`, error);
      }
    }
  }));
}

async function syncAdFilterRules() {
  await chrome.storage.local.set({
    youtubeAdBlockingEnabled: true,
    adFilterPausedSites: [],
    adFilterPausedPages: []
  });
  await updateAdBlockingRules();
  await broadcastYoutubeAdBlocking(true);
  await broadcastAdFilterConfig();
}

function isPageOrSitePaused(url, settings) {
  const page = normalizeAdFilterPage(url);
  if (!page) {
    return false;
  }
  const host = new URL(page).hostname.toLowerCase();
  return settings.adFilterPausedPages.includes(page)
    || Boolean(findMatchingPausedSite(host, settings.adFilterPausedSites));
}

function findMatchingPausedSite(hostname, pausedSites) {
  return pausedSites
    .map(normalizeAdFilterSite)
    .filter((site) => site && (hostname === site || hostname.endsWith(`.${site}`)))
    .sort((first, second) => second.length - first.length)[0] || "";
}

async function getAdFilterStatus(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Không xác định được tab hiện tại.");
  }
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = normalizeAdFilterPage(tab.url || "");
  if (!pageUrl) {
    throw new Error("Trang này không hỗ trợ lọc quảng cáo.");
  }
  const settings = await getAdFilterSettings();
  const hostname = new URL(pageUrl).hostname.toLowerCase();
  const pausedSite = findMatchingPausedSite(hostname, settings.adFilterPausedSites);
  const sitePaused = Boolean(pausedSite);
  const pagePaused = settings.adFilterPausedPages.includes(pageUrl);
  const pageStats = settings.adFilterStats.byPage?.[pageUrl] || { count: 0 };
  const siteReports = settings.adFilterReports.filter((report) => report.host === hostname).length;
  return {
    pageUrl,
    hostname,
    sitePaused,
    pausedSite,
    pagePaused,
    pageCount: pageStats.count || 0,
    totalCount: settings.adFilterStats.totalCount || 0,
    reportCount: siteReports
  };
}

async function toggleAdFilterException(message) {
  if (!Number.isInteger(message.tabId) || typeof message.paused !== "boolean"
    || !["page", "site"].includes(message.scope)) {
    throw new Error("Cài đặt ngoại lệ lọc quảng cáo không hợp lệ.");
  }
  const tab = await chrome.tabs.get(message.tabId);
  const page = normalizeAdFilterPage(tab.url || "");
  if (!page) {
    throw new Error("Trang này không hỗ trợ lọc quảng cáo.");
  }
  const values = await getAdFilterSettings();
  const isSite = message.scope === "site";
  const settingKey = isSite ? "adFilterPausedSites" : "adFilterPausedPages";
  const hostname = new URL(page).hostname.toLowerCase();
  const value = isSite
    ? (message.paused ? hostname : findMatchingPausedSite(hostname, values[settingKey]) || hostname)
    : page;
  let entries = values[settingKey].filter((entry) => isSite
    ? normalizeAdFilterSite(entry) !== value
    : entry !== value);
  if (message.paused) {
    if (isSite && entries.length >= MAX_AD_FILTER_SITES) {
      throw new Error(`Đã đạt giới hạn ${MAX_AD_FILTER_SITES} website được tạm dừng.`);
    }
    entries.push(value);
  }
  await chrome.storage.local.set({ [settingKey]: [...new Set(entries)] });
  await updateAdBlockingRules();
  await broadcastAdFilterConfig();
  await broadcastYoutubeAdBlocking(true);
  return getAdFilterStatus(message.tabId);
}

async function savePickedAdElement(message, sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || !["block", "report"].includes(message.mode)
    || typeof message.selector !== "string" || !message.selector.trim()
    || message.selector.length > 500) {
    throw new Error("Thông tin phần tử quảng cáo không hợp lệ.");
  }
  const pageUrl = normalizeAdFilterPage(sender.url || message.pageUrl || "");
  if (!pageUrl) {
    throw new Error("Không xác định được trang chứa phần tử quảng cáo.");
  }
  const host = new URL(pageUrl).hostname.toLowerCase();
  const settings = await getAdFilterSettings();
  if (message.mode === "block") {
    const rules = settings.adFilterCustomRules.filter((rule) =>
      rule.host !== host || rule.selector !== message.selector
    );
    if (rules.length >= MAX_CUSTOM_AD_RULES) {
      throw new Error(`Đã đạt giới hạn ${MAX_CUSTOM_AD_RULES} bộ chọn quảng cáo.`);
    }
    rules.push({ host, selector: message.selector, createdAt: Date.now() });
    await chrome.storage.local.set({ adFilterCustomRules: rules });
    await broadcastAdFilterConfig();
    return { ok: true, message: "Đã lưu bộ chọn quảng cáo cục bộ." };
  }

  const reports = [
    ...settings.adFilterReports,
    {
      host,
      pageUrl,
      selector: message.selector,
      excerpt: typeof message.text === "string" ? message.text.slice(0, 160) : "",
      createdAt: Date.now()
    }
  ].slice(-MAX_LOCAL_AD_REPORTS);
  await chrome.storage.local.set({ adFilterReports: reports });
  return { ok: true, message: "Đã lưu báo cáo quảng cáo trên thiết bị này." };
}

function updateAdFilterStats(message, sender) {
  const pageUrl = normalizeAdFilterPage(message.pageUrl || sender.url || "");
  const count = Math.max(0, Math.min(500, Math.floor(message.count || 0)));
  if (!pageUrl || count === 0 || !Number.isInteger(sender.tab?.id)) {
    throw new Error("Dữ liệu thống kê lọc quảng cáo không hợp lệ.");
  }
  const update = adStatsWriteQueue.then(async () => {
    const { adFilterStats = { totalCount: 0, byPage: {} } } = await chrome.storage.local.get("adFilterStats");
    const byPage = { ...(adFilterStats.byPage || {}) };
    byPage[pageUrl] = {
      count: (byPage[pageUrl]?.count || 0) + count,
      updatedAt: Date.now()
    };
    const pages = Object.entries(byPage)
      .sort(([, first], [, second]) => second.updatedAt - first.updatedAt)
      .slice(0, 100);
    const nextStats = {
      totalCount: (adFilterStats.totalCount || 0) + count,
      byPage: Object.fromEntries(pages)
    };
    await chrome.storage.local.set({ adFilterStats: nextStats });
    return nextStats;
  });
  adStatsWriteQueue = update.catch(() => {});
  return update;
}

chrome.runtime.onInstalled.addListener(() => {
  syncAdFilterRules().catch((error) => console.error("Unable to initialize local ad rules:", error));
});
chrome.runtime.onStartup.addListener(() => {
  syncAdFilterRules().catch((error) => console.error("Unable to restore local ad rules:", error));
});

function tabSettingsKey(tabId) {
  return `enabledTab:${tabId}`;
}

function autoRecoveryKey(tabId) {
  return `autoRecovery:${tabId}`;
}

chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch((error) => console.error("Unable to restrict extension storage access:", error));

async function sendToFrame(tabId, frameId, message) {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture tab audio and relay Gemini's live dubbed speech to the user."
    }).finally(() => {
      offscreenCreation = null;
    });
  }
  await offscreenCreation;
}

async function stopActiveSession(reason = "user") {
  const previous = activeSession || await chrome.storage.session.get("activeSession").then((value) => value.activeSession);
  activeSession = null;
  await chrome.storage.session.remove("activeSession");

  try {
    await chrome.runtime.sendMessage({
      type: "STOP_LIVE_TRANSLATION",
      sessionId: previous?.sessionId
    });
  } catch (error) {
    console.warn("Unable to stop the Gemini audio session:", error);
  }

  if (previous) {
    try {
      await sendToFrame(previous.tabId, previous.frameId, {
        type: "STOP_OVERLAY",
        sessionId: previous.sessionId,
        resumeVideo: false
      });
    } catch (error) {
      console.warn("Unable to remove the video status overlay:", error);
    }
  }
}

async function stopTranslation(message = {}) {
  await stopActiveSession("user");

  const currentTabId = typeof message.tabId === "number" ? message.tabId : null;
  const sessionTabId = typeof activeSession?.tabId === "number" ? activeSession.tabId : null;
  const tabIds = [...new Set([currentTabId, sessionTabId].filter((id) => id !== null))];

  for (const tabId of tabIds) {
    await chrome.storage.session.remove([tabSettingsKey(tabId), autoRecoveryKey(tabId)]);
    try {
      let frames;
      try {
        frames = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {}
        });
      } catch {
        frames = [];
      }
      const frameIds = frames.length > 0 ? [...new Set(frames.map((frame) => frame.frameId))] : [0];
      await Promise.all(frameIds.map((frameId) =>
        sendToFrame(tabId, frameId, { type: "DISABLE_AUTO_DUBBING" }).catch(() => {})
      ));
    } catch (error) {
      console.warn(`Could not notify tab ${tabId} of disable:`, error);
    }
  }
}

async function enableAutoDubbing(message) {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (!geminiApiKey) {
    throw new Error("Hãy nhập Gemini API key trước.");
  }
  if (!message.targetLanguageCode || !message.targetLanguageName) {
    throw new Error("Hãy chọn ngôn ngữ lồng tiếng.");
  }

  const tab = await chrome.tabs.get(message.tabId);
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("Trang này không cho phép extension truy cập.");
  }

  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId: message.tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (error) {
    console.warn("Could not inject into every frame; enabling the main page instead:", error);
    frames = await chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      files: ["content.js"]
    });
  }

  const frameIds = [...new Set(frames.map((frame) => frame.frameId))];
  const enabled = await Promise.all(frameIds.map(async (frameId) => {
    try {
      const response = await sendToFrame(message.tabId, frameId, {
        type: "ENABLE_AUTO_DUBBING",
        targetLanguageCode: message.targetLanguageCode,
        targetLanguageName: message.targetLanguageName,
        recovery: frameId === 0 ? message.recovery : undefined
      });
      return response?.ok === true;
    } catch (error) {
      console.warn(`Could not enable auto dubbing in frame ${frameId}:`, error);
      return false;
    }
  }));
  if (!enabled.some(Boolean)) {
    throw new Error("Không thể bật lồng tiếng trên trang này.");
  }

  let session = activeSession;
  if (!session) {
    const stored = await chrome.storage.session.get("activeSession");
    session = stored.activeSession || null;
  }
  if (session?.tabId === message.tabId && session.targetLanguageCode !== message.targetLanguageCode) {
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_LIVE_LANGUAGE",
      sessionId: session.sessionId,
      targetLanguageCode: message.targetLanguageCode,
      targetLanguageName: message.targetLanguageName
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Không thể đổi ngôn ngữ lồng tiếng.");
    }
    session = {
      ...session,
      targetLanguageCode: message.targetLanguageCode,
      targetLanguageName: message.targetLanguageName
    };
    activeSession = session;
    await chrome.storage.session.set({ activeSession: session });
    await sendToFrame(session.tabId, session.frameId, {
      type: "LANGUAGE_UPDATED",
      sessionId: session.sessionId,
      targetLanguageName: session.targetLanguageName
    });
  }

  await chrome.storage.session.set({
    [tabSettingsKey(message.tabId)]: {
      origin: new URL(tab.url).origin,
      targetLanguageCode: message.targetLanguageCode,
      targetLanguageName: message.targetLanguageName
    }
  });
}

async function getTabDubbingStatus(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Không xác định được tab hiện tại.");
  }
  const key = tabSettingsKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const settings = stored[key];
  if (!settings) {
    return { enabled: false };
  }

  const tab = await chrome.tabs.get(tabId);
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    await chrome.storage.session.remove(key);
    return { enabled: false };
  }
  if (origin !== settings.origin) {
    await chrome.storage.session.remove(key);
    return { enabled: false };
  }
  return {
    enabled: true,
    targetLanguageCode: settings.targetLanguageCode,
    targetLanguageName: settings.targetLanguageName
  };
}

async function startDubbing(message, sender) {
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (typeof tabId !== "number" || typeof frameId !== "number") {
    throw new Error("Không xác định được tab video.");
  }

  const { geminiApiKey, targetLanguageCode, targetLanguageName } = await chrome.storage.local.get([
    "geminiApiKey",
    "targetLanguageCode",
    "targetLanguageName"
  ]);
  if (!geminiApiKey) {
    throw new Error("Hãy nhập Gemini API key trong cửa sổ extension.");
  }
  const languageCode = (message.targetLanguageCode || targetLanguageCode || "").trim();
  const languageName = (message.targetLanguageName || targetLanguageName || "").trim();
  if (!languageCode || !languageName) {
    throw new Error("Hãy chọn ngôn ngữ lồng tiếng trong extension.");
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("Trang này không cho phép extension thu âm.");
  }

  await stopActiveSession("replace");
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const session = {
    sessionId: crypto.randomUUID(),
    tabId,
    frameId,
    targetLanguageCode: languageCode,
    targetLanguageName: languageName
  };
  activeSession = session;
  await chrome.storage.session.set({ activeSession: session });

  try {
    const overlay = await sendToFrame(tabId, frameId, {
      type: "START_OVERLAY",
      sessionId: session.sessionId,
      targetLanguageName: languageName,
      pauseVideo: message.pauseVideo !== false
    });
    if (!overlay?.ok) {
      throw new Error(overlay?.error || "Không thể bật trạng thái lồng tiếng cho video.");
    }

    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
      type: "START_LIVE_TRANSLATION",
      sessionId: session.sessionId,
      streamId,
      tabId,
      frameId,
      geminiApiKey,
      targetLanguageCode: languageCode,
      targetLanguageName: languageName
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Không thể kết nối Gemini Live.");
    }
    if (youtubeAdPlaybackTabs.has(tabId)) {
      const adStateResponse = await chrome.runtime.sendMessage({
        type: "SET_YOUTUBE_AD_PLAYBACK",
        sessionId: session.sessionId,
        tabId,
        active: true
      });
      if (!adStateResponse?.ok) {
        throw new Error(adStateResponse?.error || "Không thể đồng bộ lồng tiếng với quảng cáo YouTube.");
      }
    }
    const recoveryKey = autoRecoveryKey(tabId);
    const storedRecovery = await chrome.storage.session.get(recoveryKey);
    const recovery = storedRecovery[recoveryKey];
    if (recovery) {
      await chrome.storage.session.set({
        [recoveryKey]: {
          ...recovery,
          currentTime: null,
          wasPlaying: false,
          lastStartedAt: Date.now()
        }
      });
    }
    await sendToFrame(tabId, frameId, { type: "RESUME_VIDEO", sessionId: session.sessionId });
  } catch (error) {
    await stopActiveSession("error");
    throw error;
  }
}

async function notifyFrame(sessionId, type, text) {
  let session = activeSession;
  if (!session) {
    const stored = await chrome.storage.session.get("activeSession");
    session = stored.activeSession || null;
    activeSession = session;
  }
  if (session && session.sessionId === sessionId) {
    await sendToFrame(session.tabId, session.frameId, { type, text: text || "", sessionId });
  }
}

async function handleDubbingFailure(message) {
  let session = activeSession;
  if (!session) {
    const stored = await chrome.storage.session.get("activeSession");
    session = stored.activeSession || null;
    activeSession = session;
  }
  if (!session || session.sessionId !== message.sessionId) {
    return { ok: true };
  }
  if (recoveringSessions.has(session.sessionId)) {
    return { ok: true, reloading: true };
  }
  recoveringSessions.add(session.sessionId);

  try {
    const settingsKey = tabSettingsKey(session.tabId);
    const storedSettings = await chrome.storage.session.get(settingsKey);
    const settings = storedSettings[settingsKey];
    if (!settings) {
      await notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error);
      return { ok: true };
    }

    let tab;
    try {
      tab = await chrome.tabs.get(session.tabId);
    } catch (error) {
      console.warn("Unable to retrieve the tab for automatic dubbing recovery:", error);
      await notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error);
      return { ok: true };
    }
    const currentUrl = tab.url || "";
    let currentOrigin;
    try {
      currentOrigin = new URL(currentUrl).origin;
    } catch {
      await notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error);
      return { ok: true };
    }
    if (currentOrigin !== settings.origin) {
      await notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error);
      return { ok: true };
    }

    let playbackState = null;
    try {
      const response = await sendToFrame(session.tabId, session.frameId, {
        type: "GET_DUBBING_RECOVERY_STATE",
        sessionId: session.sessionId
      });
      if (response?.ok) {
        playbackState = response;
      }
    } catch (error) {
      console.warn("Unable to capture video position before automatic reload:", error);
    }

    const recoveryKey = autoRecoveryKey(session.tabId);
    const previousState = (await chrome.storage.session.get(recoveryKey))[recoveryKey];
    const now = Date.now();
    const samePage = previousState?.url === currentUrl;
    let reloadTimes = samePage && Array.isArray(previousState.reloadTimes)
      ? previousState.reloadTimes.filter((timestamp) => now - timestamp < AUTO_RECOVERY_WINDOW_MS)
      : [];
    if (samePage && previousState.lastStartedAt
      && now - previousState.lastStartedAt >= AUTO_RECOVERY_STABLE_SESSION_MS) {
      reloadTimes = [];
    }

    if (reloadTimes.length >= MAX_AUTO_RELOADS) {
      await notifyFrame(
        message.sessionId,
        "TRANSLATION_ERROR",
        `Lồng tiếng đã dừng và tự khôi phục ${MAX_AUTO_RELOADS} lần nhưng vẫn lỗi. ${message.error || ""}`.trim()
      );
      activeSession = null;
      await chrome.storage.session.remove("activeSession");
      try {
        await chrome.runtime.sendMessage({ type: "STOP_LIVE_TRANSLATION", sessionId: session.sessionId });
      } catch (error) {
        console.warn("Unable to clean up the failed dubbing session:", error);
      }
      return { ok: true };
    }

    const nextRecovery = {
      url: currentUrl,
      reloadTimes: [...reloadTimes, now],
      currentTime: playbackState?.currentTime,
      wasPlaying: playbackState?.wasPlaying === true,
      lastStartedAt: null
    };
    await chrome.storage.session.set({ [recoveryKey]: nextRecovery });
    await notifyFrame(
      message.sessionId,
      "DUBBING_TEXT",
      `Gemini bị ngắt. Đang tự tải lại trang để khôi phục (${nextRecovery.reloadTimes.length}/${MAX_AUTO_RELOADS})…`
    );
    await new Promise((resolve) => setTimeout(resolve, 750));

    if (activeSession?.sessionId !== session.sessionId) {
      return { ok: true };
    }
    try {
      const latestTab = await chrome.tabs.get(session.tabId);
      if (latestTab.url !== currentUrl) {
        await chrome.storage.session.remove(recoveryKey);
        await notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error);
        return { ok: true };
      }
      await stopActiveSession("automatic-recovery");
      await chrome.tabs.reload(session.tabId);
      return { ok: true, reloading: true };
    } catch (error) {
      console.error("Unable to reload the tab for automatic dubbing recovery:", error);
      await chrome.storage.session.remove(recoveryKey);
      await notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error);
      return { ok: true };
    }
  } finally {
    recoveringSessions.delete(session.sessionId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "YOUTUBE_AD_PLAYBACK_STATE") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number" || typeof message.active !== "boolean") {
      sendResponse({ ok: false, error: "Trạng thái quảng cáo YouTube không hợp lệ." });
      return false;
    }
    if (message.active) {
      youtubeAdPlaybackTabs.add(tabId);
    } else {
      youtubeAdPlaybackTabs.delete(tabId);
    }
    (async () => {
      let session = activeSession;
      if (!session) {
        const stored = await chrome.storage.session.get("activeSession");
        session = stored.activeSession || null;
        activeSession = session;
      }
      if (!session || session.tabId !== tabId) {
        return { ok: true };
      }
      const response = await chrome.runtime.sendMessage({
        type: "SET_YOUTUBE_AD_PLAYBACK",
        sessionId: session.sessionId,
        tabId,
        active: message.active
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Không thể đồng bộ lồng tiếng với quảng cáo YouTube.");
      }
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_YOUTUBE_AD_BLOCKING") {
    (async () => {
      const settings = await getAdFilterSettings();
      const pageUrl = sender.tab?.url || "";
      return { ok: true, enabled: !isPageOrSitePaused(pageUrl, settings) };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_AD_FILTER_CONFIG") {
    getAdFilterSettings()
      .then((settings) => sendResponse({
        ok: true,
        pausedSites: settings.adFilterPausedSites,
        pausedPages: settings.adFilterPausedPages,
        customRules: settings.adFilterCustomRules
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_AD_FILTER_STATUS") {
    getAdFilterStatus(message.tabId)
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "TOGGLE_AD_FILTER_EXCEPTION") {
    toggleAdFilterException(message)
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "START_AD_ELEMENT_PICKER") {
    (async () => {
      if (!Number.isInteger(message.tabId) || !["block", "report"].includes(message.mode)) {
        throw new Error("Không thể bắt đầu chọn phần tử quảng cáo.");
      }
      const tab = await chrome.tabs.get(message.tabId);
      if (!normalizeAdFilterPage(tab.url || "")) {
        throw new Error("Trang này không hỗ trợ chọn phần tử.");
      }
      try {
        await sendToFrame(message.tabId, 0, {
          type: "START_AD_ELEMENT_PICKER",
          mode: message.mode
        });
      } catch {
        await chrome.scripting.executeScript({
          target: { tabId: message.tabId },
          files: ["ad-filter.js"]
        });
        await sendToFrame(message.tabId, 0, {
          type: "START_AD_ELEMENT_PICKER",
          mode: message.mode
        });
      }
      return { ok: true };
    })()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "AD_FILTER_ELEMENT_SELECTED") {
    savePickedAdElement(message, sender)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "AD_FILTER_HIT_COUNT") {
    try {
      updateAdFilterStats(message, sender)
        .then((stats) => sendResponse({ ok: true, totalCount: stats.totalCount }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return true;
  }

  if (message.type === "TOGGLE_AD_FILTER_PLACEHOLDER") {
    sendResponse({ ok: true, enabled: true });
    return false;
  }

  if (message.type === "ENABLE_AUTO_DUBBING") {
    enableAutoDubbing(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "GET_TAB_DUBBING_STATUS") {
    getTabDubbingStatus(message.tabId)
      .then((status) => sendResponse({ ok: true, ...status }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "START_DUBBING") {
    const tabId = sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "Không xác định được tab video." });
      return false;
    }
    startDubbing(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_TRANSLATION") {
    stopTranslation(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "VIDEO_STOPPED") {
    const senderTabId = sender.tab?.id;
    (async () => {
      if (!activeSession) {
        const stored = await chrome.storage.session.get("activeSession");
        activeSession = stored.activeSession || null;
      }
      if (activeSession?.sessionId === message.sessionId
        && activeSession.tabId === senderTabId
        && activeSession.frameId === sender.frameId) {
        await stopActiveSession("video-stop");
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "VIDEO_SEEKING" || message.type === "VIDEO_SEEKED") {
    const senderTabId = sender.tab?.id;
    (async () => {
      if (!activeSession) {
        const stored = await chrome.storage.session.get("activeSession");
        activeSession = stored.activeSession || null;
      }
      if (activeSession?.sessionId !== message.sessionId
        || activeSession.tabId !== senderTabId
        || activeSession.frameId !== sender.frameId) {
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type: "HANDLE_VIDEO_SEEK",
        sessionId: message.sessionId,
        phase: message.type === "VIDEO_SEEKING" ? "start" : "end"
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Không thể đồng bộ lồng tiếng sau khi tua.");
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "VIDEO_PAUSED" || message.type === "VIDEO_PLAYING") {
    const senderTabId = sender.tab?.id;
    (async () => {
      if (!activeSession) {
        const stored = await chrome.storage.session.get("activeSession");
        activeSession = stored.activeSession || null;
      }
      if (activeSession?.sessionId !== message.sessionId
        || activeSession.tabId !== senderTabId
        || activeSession.frameId !== sender.frameId) {
        return;
      }
      const response = await chrome.runtime.sendMessage({
        type: "SET_VIDEO_PLAYBACK_STATE",
        sessionId: message.sessionId,
        paused: message.type === "VIDEO_PAUSED",
        sequence: message.sequence
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Không thể đồng bộ âm thanh lồng tiếng với trạng thái video.");
      }
    })()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DUBBING_TEXT") {
    notifyFrame(message.sessionId, "DUBBING_TEXT", message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DUBBING_ERROR") {
    console.error("Gemini live dubbing failed:", message.error);
    handleDubbingFailure(message)
      .then(sendResponse)
      .catch((error) => {
        console.error("Unable to recover the dubbing session:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  youtubeAdPlaybackTabs.delete(tabId);
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [getPageAllowRuleId(tabId)]
  }).catch((error) => console.warn("Unable to remove a page filter exception:", error));
  chrome.storage.session.remove([tabSettingsKey(tabId), autoRecoveryKey(tabId)])
    .catch((error) => console.warn("Unable to remove tab dubbing settings:", error));
  stopSessionForTab(tabId, "navigation")
    .catch((error) => console.error("Unable to stop dubbing after tab close:", error));
});

async function stopSessionForTab(tabId, reason) {
  if (!activeSession) {
    const stored = await chrome.storage.session.get("activeSession");
    activeSession = stored.activeSession || null;
  }
  if (activeSession?.tabId === tabId) {
    await stopActiveSession(reason);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") {
    updatePageAllowRule(tabId, changeInfo.url || tab.url || "")
      .catch((error) => console.warn(`Unable to update page ad-filter exception for tab ${tabId}:`, error));
  }
  if (changeInfo.status === "loading") {
    youtubeAdPlaybackTabs.delete(tabId);
    const stopPromise = stopSessionForTab(tabId, "navigation")
      .catch((error) => console.error("Unable to stop dubbing during page reload:", error));
    pendingTabStops.set(tabId, stopPromise);
    stopPromise.finally(() => {
      if (pendingTabStops.get(tabId) === stopPromise) {
        pendingTabStops.delete(tabId);
      }
    });
  }
  if (changeInfo.status !== "complete") {
    return;
  }

  (async () => {
    const key = tabSettingsKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const settings = stored[key];
    if (!settings) {
      return;
    }
    await pendingTabStops.get(tabId);

    let origin;
    let currentTab;
    try {
      currentTab = await chrome.tabs.get(tabId);
      origin = new URL(currentTab.url || tab.url).origin;
    } catch {
      await chrome.storage.session.remove(key);
      return;
    }
    if (origin !== settings.origin) {
      await chrome.storage.session.remove(key);
      return;
    }

    let recovery;
    const recoveryKey = autoRecoveryKey(tabId);
    const storedRecovery = await chrome.storage.session.get(recoveryKey);
    const recoveryState = storedRecovery[recoveryKey];
    if (recoveryState) {
      if (recoveryState.url === (currentTab.url || tab.url)) {
        recovery = {
          currentTime: recoveryState.currentTime,
          wasPlaying: recoveryState.wasPlaying
        };
      } else {
        await chrome.storage.session.remove(recoveryKey);
      }
    }

    await enableAutoDubbing({
      tabId,
      targetLanguageCode: settings.targetLanguageCode,
      targetLanguageName: settings.targetLanguageName,
      recovery
    });
  })().catch((error) => {
    console.warn(`Unable to restore dubbing on reloaded tab ${tabId}:`, error);
  });
});
