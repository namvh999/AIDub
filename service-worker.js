let activeSession = null;
let offscreenCreation = null;
const pendingTabStops = new Map();

function tabSettingsKey(tabId) {
  return `enabledTab:${tabId}`;
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
    await chrome.storage.session.remove(tabSettingsKey(tabId));
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
        targetLanguageName: message.targetLanguageName
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

async function startDubbing(message, sender, streamIdPromise, replacementStop) {
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

  const streamId = await streamIdPromise;
  await replacementStop;
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    const replacementStop = stopActiveSession("replace");
    let streamIdPromise;
    try {
      streamIdPromise = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (error) {
      replacementStop
        .then(() => sendResponse({ ok: false, error: error.message }))
        .catch((stopError) => sendResponse({ ok: false, error: stopError.message }));
      return true;
    }
    startDubbing(message, sender, streamIdPromise, replacementStop)
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

  if (message.type === "DUBBING_TEXT") {
    notifyFrame(message.sessionId, "DUBBING_TEXT", message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DUBBING_ERROR") {
    console.error("Gemini live dubbing failed:", message.error);
    notifyFrame(message.sessionId, "TRANSLATION_ERROR", message.error)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.warn("Unable to display Gemini error:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabSettingsKey(tabId))
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
  if (changeInfo.status === "loading") {
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
    try {
      const currentTab = await chrome.tabs.get(tabId);
      origin = new URL(currentTab.url || tab.url).origin;
    } catch {
      await chrome.storage.session.remove(key);
      return;
    }
    if (origin !== settings.origin) {
      await chrome.storage.session.remove(key);
      return;
    }

    await enableAutoDubbing({
      tabId,
      targetLanguageCode: settings.targetLanguageCode,
      targetLanguageName: settings.targetLanguageName
    });
  })().catch((error) => {
    console.warn(`Unable to restore dubbing on reloaded tab ${tabId}:`, error);
  });
});
