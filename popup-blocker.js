(() => {
  if (window.__aidubPopupBlockerLoaded) {
    return;
  }
  window.__aidubPopupBlockerLoaded = true;

  const nativeOpen = window.open;
  const currentOrigin = location.origin;
  const AD_DOMAINS = [
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
    "amazon-adsystem.com",
    "adform.net",
    "media.net",
    "smartadserver.com",
    "sharethrough.com",
    "casalemedia.com",
    "serving-sys.com",
    "lijit.com",
    "33across.com",
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

  function isAdHost(host) {
    return AD_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
      || host.split(".").some((label) => (
        /(^|[-_])(ad|ads|adserver|adservice|popup|popunder|click|tracking|track|promo|redirect|casino|bet|adult)([-_]|$)/i
          .test(label)
      ));
  }

  function isExternalUrl(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin !== currentOrigin && isAdHost(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function opensNewContext(target) {
    const name = typeof target === "string" ? target.toLowerCase() : "";
    return Boolean(name) && !["_self", "_parent", "_top"].includes(name);
  }

  function blockAdNewTab(event) {
    const element = event.target instanceof Element
      ? event.target.closest("a[href], area[href]")
      : null;
    if (!element || !opensNewContext(element.getAttribute("target"))
      || !isExternalUrl(element.href)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  document.addEventListener("click", blockAdNewTab, true);
  document.addEventListener("auxclick", blockAdNewTab, true);
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !opensNewContext(form.target)
      || !isExternalUrl(form.action)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.open = function (url, target, ...features) {
    const opensNew = !target || opensNewContext(target);
    if (opensNew) {
      if (url == null || String(url).trim() === "" || isExternalUrl(String(url))) {
        return null;
      }
    }

    return Reflect.apply(nativeOpen, this, [url, target, ...features]);
  };
})();
