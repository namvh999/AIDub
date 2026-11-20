(() => {
  if (window.__aiVideoTranslatorLoaded) {
    return;
  }
  window.__aiVideoTranslatorLoaded = true;

  let autoDubbingEnabled = false;
  let isDubbingActive = false;
  let isStartPending = false;
  let targetLanguageCode = "";
  let targetLanguageName = "";
  let activeSessionId = null;
  let isStopPending = false;
  let isSeeking = false;
  let pendingPlayingVideo = null;
  let video = null;
  let selectedVideo = null;
  let shouldResumeVideo = false;
  let videoListeners = null;
  let statusHost = null;
  let statusLabel = null;

  function setStatus(text, isError = false) {
    if (!statusHost) {
      return;
    }
    statusLabel.textContent = text;
    statusLabel.dataset.error = String(isError);
    statusHost.hidden = !text;
  }

  function createStatusHost() {
    if (statusHost) {
      return;
    }
    statusHost = document.createElement("div");
    statusHost.style.cssText = "all:initial;position:fixed;top:14px;right:14px;z-index:2147483647;pointer-events:none";
    const shadow = statusHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .status { max-width: min(440px, calc(100vw - 28px)); padding: 9px 13px; border: 1px solid #45415f; border-radius: 9px; background: rgba(19, 20, 32, .94); color: #eeeaff; font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 5px 22px #0008; }
      .status[data-error="true"] { border-color: #a94c56; color: #ffd2d2; }
    `;
    statusLabel = document.createElement("div");
    statusLabel.className = "status";
    statusLabel.setAttribute("role", "status");
    shadow.append(style, statusLabel);
    document.documentElement.append(statusHost);
  }

  function findVideoFromClick(event) {
    for (const element of event.composedPath()) {
      if (element instanceof HTMLVideoElement) {
        return element;
      }
    }
    if (event.target instanceof HTMLVideoElement) {
      return event.target;
    }
    return Array.from(document.querySelectorAll("video"))
      .filter((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && event.clientX >= rect.left
          && event.clientX <= rect.right
          && event.clientY >= rect.top
          && event.clientY <= rect.bottom;
      })
      .sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaA - areaB;
      })[0] || null;
  }

  function findActiveVideo() {
    const videos = Array.from(document.querySelectorAll("video")).filter((candidate) => {
      if (!candidate.isConnected) {
        return false;
      }
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    if (videos.length === 0) {
      return null;
    }

    // 1. If previously selected video is currently playing, prioritize it
    if (selectedVideo?.isConnected && !selectedVideo.paused && !selectedVideo.ended) {
      const rect = selectedVideo.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return selectedVideo;
      }
    }

    // 2. Any currently playing video (largest)
    const playing = videos.filter((v) => !v.paused && !v.ended);
    if (playing.length > 0) {
      return playing.sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaB - areaA;
      })[0];
    }

    // 3. If previously selected video was paused, reuse it
    if (selectedVideo?.isConnected) {
      const rect = selectedVideo.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return selectedVideo;
      }
    }

    // 4. Any video that has played before (currentTime > 0)
    const withProgress = videos.filter((v) => v.currentTime > 0);
    if (withProgress.length > 0) {
      return withProgress.sort((a, b) => {
        const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
        const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
        return areaB - areaA;
      })[0];
    }

    // 5. Largest visible video
    return videos.sort((a, b) => {
      const areaA = a.getBoundingClientRect().width * a.getBoundingClientRect().height;
      const areaB = b.getBoundingClientRect().width * b.getBoundingClientRect().height;
      return areaB - areaA;
    })[0];
  }

  function startOverlay(languageName, pauseVideo = true) {
    detachVideoListeners();
    video = selectedVideo?.isConnected ? selectedVideo : null;
    if (!video) {
      throw new Error("Không tìm thấy video vừa được bấm.");
    }
    targetLanguageName = languageName;
    if (pauseVideo) {
      video.pause();
    }
    createStatusHost();
    setStatus(`Đang kết nối Gemini để lồng tiếng ${languageName}…`);
  }

  function resumeVideo() {
    if (shouldResumeVideo && selectedVideo?.isConnected) {
      selectedVideo.play().catch((error) => {
        console.warn("Unable to resume the selected video:", error);
        setStatus("Không thể tự phát lại video. Hãy bấm Play để tiếp tục.", true);
      });
    }
    shouldResumeVideo = false;
  }

  function clearOverlay(resume = false) {
    detachVideoListeners();
    if (resume) {
      resumeVideo();
    }
    video = null;
    activeSessionId = null;
    isDubbingActive = false;
    statusHost?.remove();
    statusHost = null;
    statusLabel = null;
  }

  function detachVideoListeners() {
    isSeeking = false;
    if (!video || !videoListeners) {
      videoListeners = null;
      return;
    }
    for (const [eventName, listener] of videoListeners) {
      video.removeEventListener(eventName, listener);
    }
    videoListeners = null;
  }

  function stopWhenVideoChanges() {
    if (!isDubbingActive || !activeSessionId) {
      return;
    }
    const stoppedSessionId = activeSessionId;
    isDubbingActive = false;
    isStopPending = true;
    detachVideoListeners();
    chrome.runtime.sendMessage({
      type: "VIDEO_STOPPED",
      sessionId: stoppedSessionId
    }).then((response) => {
      if (!response?.ok) {
        console.warn("Unable to stop dubbing after video playback stopped:", response?.error);
      }
    }).catch((error) => {
      console.warn("Unable to stop dubbing after video playback stopped:", error);
    }).finally(() => {
      isStopPending = false;
      const nextVideo = pendingPlayingVideo;
      pendingPlayingVideo = null;
      if (autoDubbingEnabled && nextVideo?.isConnected && !nextVideo.paused) {
        requestDubbing(nextVideo, false);
      }
    });
  }

  function notifyVideoSeek(type, sessionId) {
    chrome.runtime.sendMessage({ type, sessionId })
      .then((response) => {
        if (!response?.ok) {
          console.warn(`Unable to notify the dubbing session about ${type}:`, response?.error);
        }
      })
      .catch((error) => console.warn(`Unable to notify the dubbing session about ${type}:`, error));
  }

  function attachVideoListeners() {
    detachVideoListeners();
    if (!video) {
      return;
    }
    videoListeners = ["pause", "ended", "emptied", "loadstart", "error"].map((eventName) => {
      const listener = () => stopWhenVideoChanges();
      video.addEventListener(eventName, listener);
      return [eventName, listener];
    });
    const onSeeking = () => {
      if (!isDubbingActive || !activeSessionId || isSeeking) {
        return;
      }
      isSeeking = true;
      notifyVideoSeek("VIDEO_SEEKING", activeSessionId);
    };
    const onSeeked = () => {
      if (!isDubbingActive || !activeSessionId || !isSeeking) {
        return;
      }
      isSeeking = false;
      notifyVideoSeek("VIDEO_SEEKED", activeSessionId);
    };
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    videoListeners.push(["seeking", onSeeking], ["seeked", onSeeked]);
  }

  async function requestDubbing(clickedVideo, pauseVideo = true) {
    if (!autoDubbingEnabled) {
      return;
    }
    if (isStartPending) {
      if (!pauseVideo && clickedVideo !== selectedVideo) {
        pendingPlayingVideo = clickedVideo;
      }
      return;
    }
    if (isDubbingActive && clickedVideo === video) {
      return;
    }
    if (isStopPending) {
      pendingPlayingVideo = clickedVideo;
      return;
    }
    selectedVideo = clickedVideo;
    shouldResumeVideo = pauseVideo;
    if (pauseVideo) {
      clickedVideo.pause();
    }
    video = clickedVideo;
    isStartPending = true;
    createStatusHost();
    setStatus(`Đang kết nối Gemini để lồng tiếng ${targetLanguageName}…`);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "START_DUBBING",
        targetLanguageCode,
        targetLanguageName,
        pauseVideo
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Không thể bắt đầu lồng tiếng.");
      }
      isDubbingActive = true;
      attachVideoListeners();
      setStatus(`Đang lồng tiếng ${targetLanguageName}`);
    } catch (error) {
      createStatusHost();
      resumeVideo();
      setStatus(error.message, true);
    } finally {
      isStartPending = false;
      const nextVideo = pendingPlayingVideo;
      pendingPlayingVideo = null;
      if (autoDubbingEnabled && nextVideo?.isConnected && !nextVideo.paused) {
        requestDubbing(nextVideo, false);
      }
    }
  }

  document.addEventListener("playing", (event) => {
    const playingVideo = event.target;
    if (!(playingVideo instanceof HTMLVideoElement) || !playingVideo.isConnected) {
      return;
    }
    const rect = playingVideo.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      requestDubbing(playingVideo, false);
    }
  }, true);

  document.addEventListener("click", (event) => {
    const clickedVideo = findVideoFromClick(event);
    if (clickedVideo) {
      requestDubbing(clickedVideo);
    }
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "ENABLE_AUTO_DUBBING") {
      autoDubbingEnabled = true;
      targetLanguageCode = message.targetLanguageCode;
      targetLanguageName = message.targetLanguageName;
      sendResponse({ ok: true });

      setTimeout(() => {
        if (!autoDubbingEnabled || isDubbingActive || isStartPending) {
          return;
        }
        const activeVideo = findActiveVideo();
        if (activeVideo) {
          const shouldAutoStart = !activeVideo.paused || activeVideo === selectedVideo || activeVideo.currentTime > 0;
          if (shouldAutoStart) {
            requestDubbing(activeVideo, activeVideo.paused);
          }
        }
      }, 50);
      return false;
    }
    if (message.type === "DISABLE_AUTO_DUBBING") {
      autoDubbingEnabled = false;
      targetLanguageCode = "";
      targetLanguageName = "";
      pendingPlayingVideo = null;
      isStartPending = false;
      isStopPending = false;
      clearOverlay(false);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "START_OVERLAY") {
      try {
        startOverlay(message.targetLanguageName, message.pauseVideo !== false);
        activeSessionId = message.sessionId;
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (message.type === "RESUME_VIDEO") {
      if (message.sessionId !== activeSessionId) {
        sendResponse({ ok: false, error: "Phiên lồng tiếng đã thay đổi." });
        return false;
      }
      resumeVideo();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "STOP_OVERLAY") {
      if (message.sessionId && message.sessionId !== activeSessionId) {
        sendResponse({ ok: true });
        return false;
      }
      clearOverlay(message.resumeVideo === true);
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "DUBBING_TEXT") {
      if (message.sessionId === activeSessionId && message.text) {
        setStatus(message.text);
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "TRANSLATION_ERROR") {
      if (message.sessionId === activeSessionId) {
        isDubbingActive = false;
        detachVideoListeners();
        setStatus(message.text, true);
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "LANGUAGE_UPDATED") {
      if (message.sessionId === activeSessionId) {
        targetLanguageName = message.targetLanguageName;
        setStatus(`Đang lồng tiếng ${targetLanguageName}`);
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
