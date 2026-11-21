(() => {
  if (window.__aiVideoTranslatorYoutubeAdFilterLoaded) {
    return;
  }
  window.__aiVideoTranslatorYoutubeAdFilterLoaded = true;

  const STYLE_ID = "__ai_video_translator_youtube_ad_filter";
  const AD_SELECTORS = [
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-promoted-sparkles-web-renderer",
    "ytd-compact-promoted-item-renderer",
    "#player-ads",
    ".ytp-ad-image-overlay",
    ".ytp-ad-text-overlay"
  ];
  const SKIP_BUTTON_SELECTORS = [
    ".ytp-ad-skip-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-skip-ad-button",
    "[class*='ytp-ad-skip']",
    "button[aria-label]",
    "[role='button'][aria-label]",
    "button[title]",
    "[role='button'][title]"
  ];
  const AD_SURFACE_SELECTORS = [
    "[class*='ytp-ad-badge']",
    ".ytp-ad-player-overlay-layout__ad-info-container",
    ".ytp-ad-player-overlay-layout__skip-or-preview-container",
    ".ytp-ad-persistent-progress-bar-container"
  ];
  const ANTI_ADBLOCK_SELECTORS = [
    "ytd-enforcement-message-view-model",
    "ytd-player-error-message-renderer",
    ".ytp-error"
  ];
  const MAIN_WORLD_TOGGLE_EVENT = "__ai_video_translator_youtube_filter_toggle__";
  const MIN_LEAK_VISIBLE_MS = 3000;
  const AD_PLAYBACK_RATE = 16;

  let enabled = false;
  let observer = null;
  let skipTimer = null;
  let adVisibleSince = null;
  let leakNoticeShown = false;
  let adPlaybackActive = false;
  let adVideo = null;
  let originalAdPlayback = null;
  const skipClickTimes = new WeakMap();

  function addStyle() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `${AD_SELECTORS.join(",")} { display: none !important; }
      #movie_player.ad-showing .html5-video-container,
      #movie_player.ad-showing video,
      #movie_player.ad-showing .ytp-ad-player-overlay,
      #movie_player.ad-showing .ytp-ad-image-overlay,
      .html5-video-player.ad-showing .html5-video-container,
      .html5-video-player.ad-showing video,
      .html5-video-player.ad-showing .ytp-ad-player-overlay,
      .html5-video-player.ad-showing .ytp-ad-image-overlay {
        visibility: hidden !important;
        opacity: 0 !important;
      }`;
    document.documentElement.appendChild(style);
  }

  function collectSkipCandidates(player) {
    const candidates = new Set();
    const selectors = SKIP_BUTTON_SELECTORS.join(",");
    const visit = (root) => {
      for (const element of root.querySelectorAll(selectors)) {
        candidates.add(element);
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) {
          visit(element.shadowRoot);
        }
      }
    };
    visit(player);
    return candidates;
  }

  function clickSkipButtons() {
    if (!enabled) {
      return;
    }
    const player = document.querySelector("#movie_player");
    if (!player?.classList.contains("ad-showing")) {
      return;
    }

    for (const button of collectSkipCandidates(player)) {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent
      ].filter(Boolean).join(" ");
      const className = typeof button.className === "string" ? button.className : "";
      const isKnownSkipButton = /ytp-ad-skip/i.test(className)
        || SKIP_BUTTON_SELECTORS.slice(0, 3).some((selector) => button.matches(selector));
      if (!isKnownSkipButton && !/(?:skip|bỏ\s+qua)/i.test(label)) {
        continue;
      }

      const lastClick = skipClickTimes.get(button) || 0;
      if (!button.disabled
        && button.getAttribute("aria-disabled") !== "true"
        && isVisible(button)
        && Date.now() - lastClick > 500) {
        skipClickTimes.set(button, Date.now());
        button.click();
        break;
      }
    }
  }

  function isVisible(element) {
    if (!element) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) > 0;
  }

  function checkAdLeakAndWarnings() {
    if (!enabled) {
      return;
    }
    const player = document.querySelector("#movie_player");
    const visibleAdSurface = AD_SURFACE_SELECTORS.some((selector) =>
      Array.from(player?.querySelectorAll(selector) || []).some(isVisible)
    );
    if (player?.classList.contains("ad-showing") && visibleAdSurface) {
      adVisibleSince ??= Date.now();
      if (!leakNoticeShown && Date.now() - adVisibleSince >= MIN_LEAK_VISIBLE_MS) {
        leakNoticeShown = true;
        console.warn("A YouTube ad surface remains visible; the filter will continue trying to skip or hide it.");
      }
    } else {
      adVisibleSince = null;
    }

    if (!leakNoticeShown) {
      const antiAdblockWarning = ANTI_ADBLOCK_SELECTORS.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((element) =>
          isVisible(element) && /ad[\s-]?block(?:er|ers)?|adblock/i.test(element.textContent || "")
        )
      );
      if (antiAdblockWarning) {
        leakNoticeShown = true;
        console.warn("YouTube is showing an anti-adblock warning.");
      }
    }
  }

  function notifyMainWorld(value) {
    window.dispatchEvent(new CustomEvent(MAIN_WORLD_TOGGLE_EVENT, {
      detail: { enabled: value }
    }));
  }

  function setAdPlaybackActive(value) {
    if (adPlaybackActive === value) {
      return;
    }
    adPlaybackActive = value;
    chrome.runtime.sendMessage({
      type: "YOUTUBE_AD_PLAYBACK_STATE",
      active: value
    }).then((response) => {
      if (!response?.ok) {
        console.warn("Unable to synchronize dubbing with YouTube ad playback:", response?.error);
      }
    }).catch((error) => {
      console.warn("Unable to synchronize dubbing with YouTube ad playback:", error);
    });
  }

  function restoreAdPlayback() {
    if (!adVideo || !originalAdPlayback) {
      adVideo = null;
      originalAdPlayback = null;
      return;
    }
    try {
      adVideo.playbackRate = originalAdPlayback.playbackRate;
      adVideo.muted = originalAdPlayback.muted;
    } catch (error) {
      console.warn("Unable to restore YouTube playback after an ad:", error);
    }
    adVideo = null;
    originalAdPlayback = null;
  }

  function accelerateInStreamAd() {
    const player = document.querySelector("#movie_player");
    const adShowing = player?.classList.contains("ad-showing") === true;
    setAdPlaybackActive(adShowing);
    const video = adShowing
      ? player.querySelector("video")
      : null;
    if (!video) {
      restoreAdPlayback();
      return;
    }
    if (video !== adVideo) {
      restoreAdPlayback();
      adVideo = video;
      originalAdPlayback = {
        playbackRate: video.playbackRate,
        muted: video.muted
      };
    }
    try {
      video.muted = true;
      if (video.playbackRate < AD_PLAYBACK_RATE) {
        video.playbackRate = AD_PLAYBACK_RATE;
      }
    } catch (error) {
      console.warn("Unable to speed up a YouTube ad:", error);
    }
  }

  function stop() {
    enabled = false;
    notifyMainWorld(false);
    setAdPlaybackActive(false);
    observer?.disconnect();
    observer = null;
    if (skipTimer !== null) {
      clearInterval(skipTimer);
      skipTimer = null;
    }
    restoreAdPlayback();
    adVisibleSince = null;
    document.getElementById(STYLE_ID)?.remove();
  }

  function start() {
    if (enabled) {
      return;
    }
    enabled = true;
    addStyle();
    observer = new MutationObserver(() => {
      addStyle();
      clickSkipButtons();
      accelerateInStreamAd();
      checkAdLeakAndWarnings();
    });
    observer.observe(document, { childList: true, subtree: true });
    clickSkipButtons();
    accelerateInStreamAd();
    checkAdLeakAndWarnings();
    skipTimer = setInterval(() => {
      addStyle();
      clickSkipButtons();
      accelerateInStreamAd();
      checkAdLeakAndWarnings();
    }, 500);
  }

  function setEnabled(value) {
    notifyMainWorld(value === true);
    if (value) {
      start();
    } else {
      stop();
    }
  }

  chrome.runtime.sendMessage({ type: "GET_YOUTUBE_AD_BLOCKING" })
    .then((response) => {
      if (!response?.ok) {
        throw new Error(response?.error || "Không thể đọc cài đặt chặn quảng cáo YouTube.");
      }
      setEnabled(response.enabled);
    })
    .catch((error) => console.warn("Unable to initialize YouTube ad filtering:", error));

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "YOUTUBE_AD_BLOCKING_CHANGED") {
      setEnabled(message.enabled === true);
    }
  });

  window.addEventListener("unload", stop, { once: true });
})();
