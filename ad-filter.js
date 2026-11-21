(() => {
  if (window.__geminiVideoDubbingAdFilterLoaded) {
    return;
  }
  window.__geminiVideoDubbingAdFilterLoaded = true;

  const HIDDEN_CLASS = "__gemini_video_dubbing_ad_hidden";
  const PLACEHOLDER_CLASS = "__gemini_video_dubbing_ad_placeholder";
  const STYLE_ID = "__gemini_video_dubbing_ad_filter_style";
  const AD_SELECTORS = [
    "ins.adsbygoogle",
    "[data-ad]",
    "[data-ad-slot]",
    "[data-ad-client]",
    "iframe[src*='doubleclick.net']",
    "iframe[src*='googlesyndication.com']",
    "iframe[id^='google_ads']",
    "[id^='google_ads_']",
    "[class~='ad-banner']",
    "[class^='ad-slot']",
    "[class*=' ad-slot']",
    "[class*='advertisement-banner']"
  ];
  const hostname = location.hostname.toLowerCase();
  const hitElements = new WeakSet();
  const hiddenElements = new Set();
  const placeholders = new Map();
  let customSelectors = [];
  let observer = null;
  let pageHitCount = 0;
  let isPaused = false;
  let picker = null;

  function normalizePage(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return "";
    }
  }

  function matchesSite(host, site) {
    return host === site || host.endsWith(`.${site}`);
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity) > 0;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) || !document.documentElement) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${HIDDEN_CLASS} { display: none !important; }
      .${PLACEHOLDER_CLASS} {
        display: flex !important;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        max-width: 100%;
        border: 1px dashed #9ca3af;
        border-radius: 4px;
        background: repeating-linear-gradient(135deg, #f3f4f6, #f3f4f6 8px, #e5e7eb 8px, #e5e7eb 16px);
        color: #4b5563;
        font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-align: center;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function countHiddenElement(element) {
    if (hitElements.has(element)) {
      return;
    }
    hitElements.add(element);
    pageHitCount += 1;
    chrome.runtime.sendMessage({
      type: "AD_FILTER_HIT_COUNT",
      count: 1,
      pageUrl: normalizePage(location.href)
    }).then((response) => {
      if (!response?.ok) {
        console.warn("Unable to update local ad-filter statistics:", response?.error);
      }
    }).catch((error) => console.warn("Unable to update local ad-filter statistics:", error));
  }

  function hideElement(element) {
    if (!(element instanceof HTMLElement) || element.matches(`.${HIDDEN_CLASS}, .${PLACEHOLDER_CLASS}`)) {
      return;
    }
    if (!isVisible(element)) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    if (computed.position !== "fixed" && computed.position !== "absolute" && element.parentElement) {
      const placeholder = document.createElement("div");
      placeholder.className = PLACEHOLDER_CLASS;
      placeholder.setAttribute("aria-label", "Quảng cáo đã được lọc");
      placeholder.textContent = "Quảng cáo đã được lọc";
      placeholder.style.width = `${Math.round(rect.width)}px`;
      placeholder.style.height = `${Math.max(28, Math.min(240, Math.round(rect.height)))}px`;
      placeholder.style.margin = computed.margin;
      element.after(placeholder);
      placeholders.set(element, placeholder);
    }
    element.classList.add(HIDDEN_CLASS);
    hiddenElements.add(element);
    countHiddenElement(element);
  }

  function clearHiddenElements() {
    for (const element of hiddenElements) {
      element.classList.remove(HIDDEN_CLASS);
      placeholders.get(element)?.remove();
      placeholders.delete(element);
    }
    hiddenElements.clear();
    document.getElementById(STYLE_ID)?.remove();
  }

  function applyFilters() {
    if (isPaused || !document.documentElement) {
      return;
    }
    ensureStyle();
    for (const selector of [...AD_SELECTORS, ...customSelectors]) {
      let matches;
      try {
        matches = document.querySelectorAll(selector);
      } catch (error) {
        console.warn("Skipping an invalid local ad selector:", error);
        continue;
      }
      for (const element of matches) {
        hideElement(element);
      }
    }
    for (const element of hiddenElements) {
      if (!element.isConnected) {
        placeholders.get(element)?.remove();
        placeholders.delete(element);
        hiddenElements.delete(element);
      }
    }
  }

  function stopFiltering() {
    observer?.disconnect();
    observer = null;
    clearHiddenElements();
    stopPicker();
  }

  function startFiltering() {
    ensureStyle();
    applyFilters();
    if (!observer) {
      observer = new MutationObserver(applyFilters);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function buildSelector(element) {
    if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) {
      throw new Error("Chọn một phần tử cụ thể trên trang.");
    }
    if (element.id) {
      const idSelector = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(idSelector).length === 1) {
        return idSelector;
      }
    }

    const path = [];
    let node = element;
    while (node && node !== document.body && node !== document.documentElement) {
      let segment = node.localName;
      const classes = Array.from(node.classList)
        .filter((name) => /^[\w-]{1,48}$/.test(name))
        .slice(0, 2);
      if (classes.length) {
        segment += classes.map((name) => `.${CSS.escape(name)}`).join("");
      }
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((sibling) => sibling.localName === node.localName)
        : [];
      if (siblings.length > 1) {
        segment += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(segment);
      const selector = path.join(" > ");
      try {
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch {}
      node = node.parentElement;
    }
    const selector = path.join(" > ");
    if (!selector || selector.length > 500) {
      throw new Error("Không thể tạo bộ chọn ổn định cho phần tử này.");
    }
    return selector;
  }

  function stopPicker() {
    if (!picker) {
      return;
    }
    document.removeEventListener("pointermove", picker.onMove, true);
    document.removeEventListener("click", picker.onClick, true);
    document.removeEventListener("keydown", picker.onKeyDown, true);
    picker.host.remove();
    picker = null;
  }

  function startPicker(mode) {
    if (window.top !== window || !["block", "report"].includes(mode)) {
      return;
    }
    stopPicker();
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .highlight { position:fixed; display:none; border:2px solid #ef4444; background:#ef444433; box-sizing:border-box; pointer-events:none; }
      .toolbar { position:fixed; top:12px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:8px; background:#111827; color:#fff; font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; box-shadow:0 4px 18px #0006; pointer-events:auto; }
      button { border:0; border-radius:5px; padding:6px 10px; background:#374151; color:#fff; cursor:pointer; font:inherit; }
    `;
    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const instruction = document.createElement("span");
    instruction.textContent = mode === "block"
      ? "Bấm phần tử quảng cáo cần ẩn"
      : "Bấm phần tử quảng cáo muốn báo cáo";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Hủy";
    cancel.addEventListener("click", stopPicker);
    toolbar.append(instruction, cancel);
    const highlight = document.createElement("div");
    highlight.className = "highlight";
    shadow.append(style, toolbar, highlight);
    document.documentElement.appendChild(host);

    const state = { host, highlight, target: null, onMove: null, onClick: null, onKeyDown: null };
    state.onMove = (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || host.contains(target) || target.closest(`.${PLACEHOLDER_CLASS}`)) {
        highlight.style.display = "none";
        state.target = null;
        return;
      }
      const rect = target.getBoundingClientRect();
      state.target = target;
      highlight.style.display = "block";
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    };
    state.onClick = (event) => {
      if (!state.target || host.contains(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      let selector;
      try {
        selector = buildSelector(state.target);
      } catch (error) {
        console.warn("Unable to select this page element:", error);
        stopPicker();
        return;
      }
      const text = (state.target.innerText || state.target.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      stopPicker();
      chrome.runtime.sendMessage({
        type: "AD_FILTER_ELEMENT_SELECTED",
        mode,
        selector,
        text,
        pageUrl: normalizePage(location.href)
      }).then((response) => {
        if (!response?.ok) {
          console.warn("Unable to save the selected ad element:", response?.error);
        }
      }).catch((error) => console.warn("Unable to save the selected ad element:", error));
    };
    state.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        stopPicker();
      }
    };
    picker = state;
    document.addEventListener("pointermove", state.onMove, true);
    document.addEventListener("click", state.onClick, true);
    document.addEventListener("keydown", state.onKeyDown, true);
  }

  async function loadConfig() {
    const response = await chrome.runtime.sendMessage({
      type: "GET_AD_FILTER_CONFIG",
      pageUrl: normalizePage(location.href)
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Không thể tải cài đặt lọc quảng cáo.");
    }
    const pausedSites = response.pausedSites || [];
    const pausedPages = response.pausedPages || [];
    const page = normalizePage(location.href);
    isPaused = pausedPages.includes(page) || pausedSites.some((site) => matchesSite(hostname, site));
    customSelectors = (response.customRules || [])
      .filter((rule) => rule.host === hostname)
      .map((rule) => rule.selector);
    if (isPaused) {
      stopFiltering();
    } else {
      startFiltering();
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "AD_FILTER_CONFIG_CHANGED") {
      loadConfig().catch((error) => console.error("Unable to refresh local ad-filter settings:", error));
    }
    if (message.type === "START_AD_ELEMENT_PICKER") {
      startPicker(message.mode);
    }
  });

  loadConfig().catch((error) => console.warn("Unable to initialize local ad filtering:", error));
})();
