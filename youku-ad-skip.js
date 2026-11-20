/**
 * Youku Ad Skip v6 — prototype override + instant mute + anti-flicker curtain
 *
 * Chạy ở MAIN world (document_start) để override prototype trước khi
 * Youku player khởi tạo.
 *
 * Cải tiến v6:
 *  - Màn che đen mount vào <body> (fixed, fullscreen) → không cần tìm parent
 *  - Chỉ tạo curtain MỘT LẦN, tái sử dụng → không re-mount gây nháy
 *  - Debounce hideCurtain để tránh màn che biến mất rồi lại hiện khi nhiều
 *    clip quảng cáo nối tiếp
 *  - Ẩn opacity video quảng cáo ngay lập tức
 */
(() => {
  if (window.__youkuAdSkipLoaded) return;
  window.__youkuAdSkipLoaded = true;

  const LOG = (...a) => console.info("[AIDub/YoukuAdSkip v6]", ...a);

  /* ─── Set lưu các video đang bị chặn ─────────────────────────── */
  const adVideos = new WeakSet();
  let activeAdCount = 0; // đếm số quảng cáo đang chạy để quản lý curtain

  /* ─── Màn che chống nháy (Anti-flicker Curtain) ──────────────── */
  // Inject CSS spinner một lần duy nhất
  const styleEl = document.createElement("style");
  styleEl.textContent = `
    @keyframes __yk_spin { to { transform: rotate(360deg); } }
    #__youku_ad_curtain {
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      background: #0a0a0a !important;
      z-index: 2147483647 !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      pointer-events: none !important;
      opacity: 0;
      transition: opacity 0.12s ease !important;
    }
    #__youku_ad_curtain.visible {
      opacity: 1 !important;
    }
    #__youku_ad_curtain .yk-ad-pill {
      display: flex;
      align-items: center;
      gap: 10px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 24px;
      padding: 10px 20px;
      color: #ccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      letter-spacing: 0.4px;
    }
    #__youku_ad_curtain .yk-ad-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: #fff;
      border-radius: 50%;
      animation: __yk_spin 0.8s linear infinite;
      flex-shrink: 0;
    }
  `;
  document.head?.appendChild(styleEl)
    || document.documentElement.appendChild(styleEl);

  // Tạo curtain element duy nhất, gắn vào body khi cần
  const curtainEl = document.createElement("div");
  curtainEl.id = "__youku_ad_curtain";
  curtainEl.innerHTML = `
    <div class="yk-ad-pill">
      <div class="yk-ad-spinner"></div>
      <span>Đang tự động bỏ qua quảng cáo...</span>
    </div>
  `;

  let hideTimer = null;

  function showCurtain() {
    // Hủy timer ẩn nếu đang chờ → tránh nháy giữa 2 clip quảng cáo liên tiếp
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    // Mount vào body nếu chưa có
    if (!curtainEl.isConnected) {
      (document.body || document.documentElement).appendChild(curtainEl);
    }
    // Show (dùng requestAnimationFrame để transition CSS hoạt động)
    requestAnimationFrame(() => curtainEl.classList.add("visible"));
  }

  function hideCurtain() {
    // Trì hoãn 400ms trước khi ẩn → tránh màn che bị xóa rồi lại hiện
    // ngay lập tức khi clip quảng cáo tiếp theo bắt đầu
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      curtainEl.classList.remove("visible");
      // Sau transition 120ms mới remove khỏi DOM
      setTimeout(() => {
        if (!curtainEl.classList.contains("visible") && curtainEl.isConnected) {
          curtainEl.remove();
        }
      }, 150);
      hideTimer = null;
    }, 400);
  }

  /* ─── Override HTMLMediaElement prototype ────────────────────── */
  const proto = HTMLMediaElement.prototype;

  // --- playbackRate ---
  const prPlaybackRate = Object.getOwnPropertyDescriptor(proto, "playbackRate");
  if (prPlaybackRate?.set) {
    Object.defineProperty(proto, "playbackRate", {
      get: prPlaybackRate.get,
      set(val) {
        if (adVideos.has(this) && val > 0 && val < 16) return;
        prPlaybackRate.set.call(this, val);
      },
      configurable: true,
    });
  }

  // --- volume ---
  const prVolume = Object.getOwnPropertyDescriptor(proto, "volume");
  if (prVolume?.set) {
    Object.defineProperty(proto, "volume", {
      get: prVolume.get,
      set(val) {
        if (adVideos.has(this)) return;
        prVolume.set.call(this, val);
      },
      configurable: true,
    });
  }

  // --- muted ---
  const prMuted = Object.getOwnPropertyDescriptor(proto, "muted");
  if (prMuted?.set) {
    Object.defineProperty(proto, "muted", {
      get: prMuted.get,
      set(val) {
        if (adVideos.has(this) && val === false) return;
        prMuted.set.call(this, val);
      },
      configurable: true,
    });
  }

  /* ─── Hàm áp dụng / gỡ chế độ ad ───────────────────────────── */
  function markAsAd(video) {
    if (adVideos.has(video)) return;
    adVideos.add(video);
    activeAdCount++;

    // Ẩn thị giác video quảng cáo ngay lập tức
    try {
      video.style.setProperty("opacity", "0", "important");
      video.style.setProperty("visibility", "hidden", "important");
    } catch {}

    // Bật màn che (chỉ gọi show, không tạo lại)
    showCurtain();

    // Tăng tốc + mute âm thanh
    prPlaybackRate?.set.call(video, 16);
    prVolume?.set.call(video, 0);
    prMuted?.set.call(video, true);
    LOG("🔇 [v6] Ad detected → mute + 16x + curtain. duration:", video.duration?.toFixed(1));
  }

  function unmarkAsAd(video) {
    if (!adVideos.has(video)) return;
    adVideos.delete(video);
    activeAdCount = Math.max(0, activeAdCount - 1);

    // Khôi phục hiển thị video chính
    try {
      video.style.removeProperty("opacity");
      video.style.removeProperty("visibility");
    } catch {}

    // Chỉ ẩn curtain khi không còn quảng cáo nào đang chạy
    if (activeAdCount === 0) {
      hideCurtain();
    }

    prPlaybackRate?.set.call(video, 1);
    prVolume?.set.call(video, 1);
    prMuted?.set.call(video, false);
    LOG("▶ [v6] Ad ended → restored normal playback.");
  }

  /* ─── Phát hiện ad qua seekable / duration ───────────────────── */
  function isAdVideo(video) {
    if (!video || !video.isConnected) return false;
    // Tín hiệu 1: duration ngắn < 3 phút → thường là ad Youku
    if (isFinite(video.duration) && video.duration > 0 && video.duration < 180) return true;
    // Tín hiệu 2: seekable bị chặn hoàn toàn
    if (video.seekable && video.seekable.length === 0) return true;
    if (video.seekable && video.seekable.length > 0 && video.seekable.end(0) < 1) return true;
    return false;
  }

  /* ─── Intercept play() ───────────────────────────────────────── */
  const nativePlay = proto.play;
  proto.play = function () {
    const video = this;
    const result = nativePlay.call(video);
    checkVideoAfterPlay(video, 0);
    checkVideoAfterPlay(video, 80);
    checkVideoAfterPlay(video, 200);
    checkVideoAfterPlay(video, 400);
    return result;
  };

  function checkVideoAfterPlay(video, delay) {
    setTimeout(() => {
      if (video.paused || video.ended) return;
      if (isAdVideo(video)) markAsAd(video);
    }, delay);
  }

  /* ─── Tìm nút Skip ───────────────────────────────────────────── */
  function findSkipButton() {
    for (const el of document.querySelectorAll("button, span, div, a")) {
      const text = el.textContent?.trim() || "";
      if (!text || text.length > 20) continue;
      if (text.includes("跳过") || text.toLowerCase().startsWith("skip")) {
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;
        if (parseFloat(st.opacity || "1") < 0.1) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
    }
    return null;
  }

  /* ─── Ẩn overlay quảng cáo tạm dừng ──────────────────────────── */
  function hideOverlays() {
    document.querySelectorAll(
      "div[class*='ad'], div[class*='Ad'], div[id*='ad'], div[id*='Ad'], div[class*='pause'], div[class*='Pause']"
    ).forEach((el) => {
      if (el.id === "__youku_ad_curtain" || el.querySelector("video")) return;
      const st = window.getComputedStyle(el);
      if (st.display === "none") return;
      const rect = el.getBoundingClientRect();
      if (rect.width > window.innerWidth * 0.25 && (st.position === "absolute" || st.position === "fixed")) {
        el.style.setProperty("display", "none", "important");
      }
    });
  }

  /* ─── Polling 300ms ──────────────────────────────────────────── */
  function tick() {
    hideOverlays();

    const skipBtn = findSkipButton();
    if (skipBtn) {
      LOG("⏭ Click skip:", skipBtn.textContent.trim());
      skipBtn.click();
    }

    let currentlyHasAd = false;

    document.querySelectorAll("video").forEach((video) => {
      if (video.paused || video.ended || !video.isConnected) {
        if (adVideos.has(video)) unmarkAsAd(video);
        return;
      }
      if (isAdVideo(video)) {
        currentlyHasAd = true;
        markAsAd(video);
        // Thử seek về cuối nếu được phép
        try {
          if (video.seekable?.length > 0) {
            const end = video.seekable.end(video.seekable.length - 1);
            if (end > video.currentTime + 0.5) {
              prPlaybackRate?.set.call(video, 1);
              video.currentTime = end - 0.1;
              prPlaybackRate?.set.call(video, 16);
              LOG("⏩ Seek:", end.toFixed(1) + "s");
            }
          }
        } catch {}
      } else {
        if (adVideos.has(video)) unmarkAsAd(video);
      }
    });

    // Nếu không còn ad mà activeAdCount còn thừa, reset
    if (!currentlyHasAd && activeAdCount > 0) {
      activeAdCount = 0;
      hideCurtain();
    }
  }

  const interval = setInterval(tick, 300);

  /* ─── MutationObserver ───────────────────────────────────────── */
  const observer = new MutationObserver(() => {
    hideOverlays();
    const skipBtn = findSkipButton();
    if (skipBtn) {
      LOG("⏭ MO click skip:", skipBtn.textContent.trim());
      skipBtn.click();
    }
  });

  const startObserve = () => {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserve, { once: true });
  } else {
    startObserve();
  }

  /* ─── Cleanup ────────────────────────────────────────────────── */
  window.addEventListener("unload", () => {
    clearInterval(interval);
    observer.disconnect();
    if (hideTimer) clearTimeout(hideTimer);
    curtainEl.remove();
  }, { once: true });

  LOG("✅ v6 kích hoạt — fixed curtain, debounced hide, opacity+visibility block.");
})();
