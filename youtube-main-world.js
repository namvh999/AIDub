(() => {
  if (window.__aiVideoTranslatorYoutubeMainWorldLoaded) {
    return;
  }
  window.__aiVideoTranslatorYoutubeMainWorldLoaded = true;

  const TOGGLE_EVENT = "__ai_video_translator_youtube_filter_toggle__";
  const AD_FIELDS = new Set(["adPlacements", "adSlots", "playerAds"]);
  const xhrUrls = new WeakMap();
  const xhrResponses = new WeakMap();
  let enabled = false;

  function isPlayerApiUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.hostname.endsWith("youtube.com")
        && /\/youtubei\/v1\/(player|next)(?:\/|$)/.test(url.pathname);
    } catch {
      return false;
    }
  }

  function pruneAdFields(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      value.forEach(pruneAdFields);
      return value;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
      if (AD_FIELDS.has(key)) {
        delete value[key];
      } else {
        pruneAdFields(nestedValue);
      }
    }
    return value;
  }

  function containsAdFields(text) {
    return typeof text === "string"
      && (text.includes('"adPlacements"')
        || text.includes('"adSlots"')
        || text.includes('"playerAds"'));
  }

  const nativeJsonParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    const result = nativeJsonParse.call(this, text, reviver);
    if (enabled && location.pathname === "/watch" && containsAdFields(text)) {
      return pruneAdFields(result);
    }
    return result;
  };

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const requestUrl = typeof input === "string" ? input : input?.url;
    const responsePromise = nativeFetch.call(this, input, init);
    if (!isPlayerApiUrl(requestUrl)) {
      return responsePromise;
    }
    return responsePromise.then((response) => {
      if (!enabled || response.type === "opaque") {
        return response;
      }
      const nativeJson = response.json.bind(response);
      try {
        Object.defineProperty(response, "json", {
          configurable: true,
          value: async () => {
            const data = await nativeJson();
            return enabled ? pruneAdFields(data) : data;
          }
        });
      } catch (error) {
        console.warn("Unable to filter a YouTube player response:", error);
      }
      return response;
    });
  };

  const xhrPrototype = XMLHttpRequest.prototype;
  const nativeXhrOpen = xhrPrototype.open;
  const nativeXhrSend = xhrPrototype.send;
  const responseDescriptor = Object.getOwnPropertyDescriptor(xhrPrototype, "response");
  const responseTextDescriptor = Object.getOwnPropertyDescriptor(xhrPrototype, "responseText");

  xhrPrototype.open = function (method, url, ...args) {
    xhrUrls.set(this, String(url));
    return nativeXhrOpen.call(this, method, url, ...args);
  };

  xhrPrototype.send = function (...args) {
    if (isPlayerApiUrl(xhrUrls.get(this))) {
      this.addEventListener("load", () => {
        if (!enabled) {
          return;
        }
        try {
          if (this.responseType === "json" && responseDescriptor?.get) {
            xhrResponses.set(this, pruneAdFields(responseDescriptor.get.call(this)));
            return;
          }
          if ((this.responseType === "" || this.responseType === "text")
            && responseTextDescriptor?.get) {
            const text = responseTextDescriptor.get.call(this);
            if (containsAdFields(text)) {
              const parsed = nativeJsonParse.call(JSON, text);
              xhrResponses.set(this, JSON.stringify(pruneAdFields(parsed)));
            }
          }
        } catch (error) {
          console.warn("Unable to prune YouTube ad response fields:", error);
        }
      }, { once: true });
    }
    return nativeXhrSend.apply(this, args);
  };

  if (responseDescriptor?.get) {
    Object.defineProperty(xhrPrototype, "response", {
      configurable: true,
      enumerable: responseDescriptor.enumerable,
      get() {
        return xhrResponses.has(this)
          ? xhrResponses.get(this)
          : responseDescriptor.get.call(this);
      }
    });
  }

  if (responseTextDescriptor?.get) {
    Object.defineProperty(xhrPrototype, "responseText", {
      configurable: true,
      enumerable: responseTextDescriptor.enumerable,
      get() {
        const value = xhrResponses.get(this);
        return typeof value === "string" ? value : responseTextDescriptor.get.call(this);
      }
    });
  }

  window.addEventListener(TOGGLE_EVENT, (event) => {
    enabled = event.detail?.enabled === true;
  });
})();
