/**
 * Telegram Media & Video Downloader
 * Integrated from Telegram-Media-Downloader for Gemini Video Dubbing extension.
 * Unlocks and enables downloading of videos, GIFs, images, voice messages,
 * and stories on Telegram Web (WebK and WebZ/WebA), including restricted/private channels.
 */

(() => {
  if (window.__telegramMediaDownloaderLoaded) {
    return;
  }
  window.__telegramMediaDownloaderLoaded = true;

  const logger = {
    info: (message, fileName = null) => {
      console.log(`[Tel Download] ${fileName ? `${fileName}: ` : ""}${message}`);
    },
    error: (message, fileName = null) => {
      console.error(`[Tel Download] ${fileName ? `${fileName}: ` : ""}${message}`);
    },
  };

  // Unicode values for icons (used in /k/ app)
  // https://github.com/morethanwords/tweb/blob/master/src/icons.ts
  const DOWNLOAD_ICON = "\ue979";
  const FORWARD_ICON = "\ue99a";
  const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+)$/;
  const REFRESH_DELAY = 500;

  const hashCode = (s) => {
    let h = 0;
    const l = s.length;
    let i = 0;
    if (l > 0) {
      while (i < l) {
        h = ((h << 5) - h + s.charCodeAt(i++)) | 0;
      }
    }
    return (h >>> 0).toString(36);
  };

  function injectStyles() {
    if (document.getElementById("tel-downloader-styles")) return;
    const style = document.createElement("style");
    style.id = "tel-downloader-styles";
    style.textContent = `
      .tel-download {
        cursor: pointer !important;
      }
      .tel-download .icon-download:empty::before {
        content: "";
        display: inline-block;
        width: 20px;
        height: 20px;
        background-color: currentColor;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'/%3E%3C/svg%3E") no-repeat center / contain;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z'/%3E%3C/svg%3E") no-repeat center / contain;
      }
      #tel-downloader-progress-bar-container {
        position: fixed;
        bottom: 12px;
        right: 12px;
        display: flex;
        flex-direction: column-reverse;
        gap: 8px;
        pointer-events: none;
      }
      #tel-downloader-progress-bar-container > * {
        pointer-events: auto;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function setupProgressBar() {
    let container = document.getElementById("tel-downloader-progress-bar-container");
    if (container) return container;
    const body = document.body || document.documentElement;
    if (!body) return null;

    container = document.createElement("div");
    container.id = "tel-downloader-progress-bar-container";
    if (location.pathname.startsWith("/k/")) {
      container.style.zIndex = "1000";
    } else {
      container.style.zIndex = "2147483640";
    }
    body.appendChild(container);
    return container;
  }

  const createProgressBar = (videoId, fileName) => {
    let container = document.getElementById("tel-downloader-progress-bar-container");
    if (!container) {
      container = setupProgressBar();
    }
    if (!container) return;

    if (document.getElementById("tel-downloader-progress-" + videoId)) return;

    const isDarkMode =
      document.querySelector("html")?.classList.contains("night") ||
      document.querySelector("html")?.classList.contains("theme-dark") ||
      document.body?.classList.contains("theme-dark");

    const innerContainer = document.createElement("div");
    innerContainer.id = "tel-downloader-progress-" + videoId;
    innerContainer.style.width = "20rem";
    innerContainer.style.padding = "0.7rem 0.8rem";
    innerContainer.style.borderRadius = "8px";
    innerContainer.style.boxShadow = "0 4px 16px rgba(0,0,0,0.35)";
    innerContainer.style.backgroundColor = isDarkMode
      ? "rgba(24, 24, 27, 0.92)"
      : "rgba(30, 41, 59, 0.92)";
    innerContainer.style.backdropFilter = "blur(10px)";
    innerContainer.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
    innerContainer.style.boxSizing = "border-box";
    innerContainer.style.transition = "all 0.3s ease";

    const flexContainer = document.createElement("div");
    flexContainer.style.display = "flex";
    flexContainer.style.justifyContent = "space-between";
    flexContainer.style.alignItems = "center";
    flexContainer.style.marginBottom = "0.4rem";

    const title = document.createElement("p");
    title.className = "filename";
    title.style.margin = "0";
    title.style.color = "#ffffff";
    title.style.fontSize = "13px";
    title.style.fontWeight = "500";
    title.style.overflow = "hidden";
    title.style.textOverflow = "ellipsis";
    title.style.whiteSpace = "nowrap";
    title.style.maxWidth = "17rem";
    title.innerText = fileName || "downloading…";

    const closeButton = document.createElement("div");
    closeButton.style.cursor = "pointer";
    closeButton.style.fontSize = "1.3rem";
    closeButton.style.lineHeight = "1";
    closeButton.style.color = "#94a3b8";
    closeButton.style.marginLeft = "8px";
    closeButton.innerHTML = "&times;";
    closeButton.onclick = function () {
      if (innerContainer.parentNode) {
        innerContainer.parentNode.removeChild(innerContainer);
      }
    };

    const progressBar = document.createElement("div");
    progressBar.className = "progress";
    progressBar.style.backgroundColor = "rgba(255,255,255,0.2)";
    progressBar.style.position = "relative";
    progressBar.style.width = "100%";
    progressBar.style.height = "1.4rem";
    progressBar.style.borderRadius = "1rem";
    progressBar.style.overflow = "hidden";

    const counter = document.createElement("p");
    counter.style.position = "absolute";
    counter.style.zIndex = "5";
    counter.style.left = "50%";
    counter.style.top = "50%";
    counter.style.transform = "translate(-50%, -50%)";
    counter.style.margin = "0";
    counter.style.color = "#ffffff";
    counter.style.fontSize = "11px";
    counter.style.fontWeight = "600";
    counter.innerText = "0%";

    const progress = document.createElement("div");
    progress.style.position = "absolute";
    progress.style.height = "100%";
    progress.style.width = "0%";
    progress.style.backgroundColor = "#38bdf8";
    progress.style.transition = "width 0.2s ease";

    progressBar.appendChild(counter);
    progressBar.appendChild(progress);
    flexContainer.appendChild(title);
    flexContainer.appendChild(closeButton);
    innerContainer.appendChild(flexContainer);
    innerContainer.appendChild(progressBar);
    container.appendChild(innerContainer);
  };

  const updateProgress = (videoId, fileName, progress) => {
    const innerContainer = document.getElementById("tel-downloader-progress-" + videoId);
    if (!innerContainer) return;
    const title = innerContainer.querySelector("p.filename");
    if (title && fileName) {
      title.innerText = fileName;
    }
    const progressBar = innerContainer.querySelector("div.progress");
    if (progressBar) {
      const p = progressBar.querySelector("p");
      if (p) p.innerText = progress + "%";
      const div = progressBar.querySelector("div");
      if (div) div.style.width = progress + "%";
    }
  };

  const completeProgress = (videoId) => {
    const innerContainer = document.getElementById("tel-downloader-progress-" + videoId);
    if (!innerContainer) return;
    const progressBar = innerContainer.querySelector("div.progress");
    if (progressBar) {
      const p = progressBar.querySelector("p");
      if (p) p.innerText = "Completed";
      const div = progressBar.querySelector("div");
      if (div) {
        div.style.backgroundColor = "#22c55e";
        div.style.width = "100%";
      }
    }
    setTimeout(() => {
      if (innerContainer.parentNode) {
        innerContainer.parentNode.removeChild(innerContainer);
      }
    }, 6000);
  };

  const abortProgress = (videoId) => {
    const innerContainer = document.getElementById("tel-downloader-progress-" + videoId);
    if (!innerContainer) return;
    const progressBar = innerContainer.querySelector("div.progress");
    if (progressBar) {
      const p = progressBar.querySelector("p");
      if (p) p.innerText = "Aborted";
      const div = progressBar.querySelector("div");
      if (div) {
        div.style.backgroundColor = "#ef4444";
        div.style.width = "100%";
      }
    }
    setTimeout(() => {
      if (innerContainer.parentNode) {
        innerContainer.parentNode.removeChild(innerContainer);
      }
    }, 5000);
  };

  const tel_download_video = (url) => {
    let _blobs = [];
    let _next_offset = 0;
    let _total_size = null;
    let _file_extension = "mp4";

    const videoId =
      (Math.random() + 1).toString(36).substring(2, 10) +
      "_" +
      Date.now().toString();
    let fileName = hashCode(url) + "." + _file_extension;

    try {
      const parts = url.split("/");
      const last = parts[parts.length - 1];
      const metadata = JSON.parse(decodeURIComponent(last));
      if (metadata.fileName) {
        fileName = metadata.fileName;
      }
    } catch (e) {
      // Invalid JSON string, pass extracting fileName
    }
    logger.info(`URL: ${url}`, fileName);

    const fetchNextPart = (_writable) => {
      fetch(url, {
        method: "GET",
        headers: {
          Range: `bytes=${_next_offset}-`,
        },
      })
        .then((res) => {
          if (![200, 206].includes(res.status)) {
            throw new Error("Non 200/206 response was received: " + res.status);
          }
          const contentType = res.headers.get("Content-Type");
          const mime = contentType ? contentType.split(";")[0] : "";
          if (mime.startsWith("video/")) {
            _file_extension = mime.split("/")[1] || "mp4";
            if (!fileName.includes(".")) {
              fileName = fileName + "." + _file_extension;
            } else if (fileName.endsWith(".mp4") && _file_extension !== "mp4") {
              fileName = fileName.substring(0, fileName.lastIndexOf(".") + 1) + _file_extension;
            }
          }

          const contentRange = res.headers.get("Content-Range");
          if (contentRange) {
            const match = contentRange.match(contentRangeRegex);
            if (match) {
              const startOffset = parseInt(match[1], 10);
              const endOffset = parseInt(match[2], 10);
              const totalSize = parseInt(match[3], 10);

              if (startOffset !== _next_offset) {
                logger.error("Gap detected between responses.", fileName);
                throw new Error("Gap detected between responses.");
              }
              if (_total_size && totalSize !== _total_size) {
                logger.error("Total size differs", fileName);
                throw new Error("Total size differs");
              }

              _next_offset = endOffset + 1;
              _total_size = totalSize;

              const percent = ((_next_offset * 100) / _total_size).toFixed(0);
              updateProgress(videoId, fileName, percent);
            }
          } else {
            const len = res.headers.get("Content-Length");
            if (len) {
              _total_size = parseInt(len, 10);
              _next_offset = _total_size;
              updateProgress(videoId, fileName, 100);
            }
          }
          return res.blob();
        })
        .then(async (resBlob) => {
          if (_writable !== null) {
            await _writable.write(resBlob);
          } else {
            _blobs.push(resBlob);
          }
        })
        .then(async () => {
          if (_total_size && _next_offset < _total_size) {
            fetchNextPart(_writable);
          } else {
            if (_writable !== null) {
              await _writable.close();
              logger.info("Download finished", fileName);
            } else {
              save();
            }
            completeProgress(videoId);
          }
        })
        .catch((reason) => {
          logger.error(reason, fileName);
          abortProgress(videoId);
        });
    };

    const save = () => {
      logger.info("Finish downloading blobs", fileName);
      const blob = new Blob(_blobs, { type: "video/mp4" });
      const blobUrl = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      document.body.appendChild(a);
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      document.body.removeChild(a);
      setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10000);
      logger.info("Download triggered", fileName);
    };

    const supportsFileSystemAccess =
      "showSaveFilePicker" in window &&
      (() => {
        try {
          return window.self === window.top;
        } catch {
          return false;
        }
      })();

    if (supportsFileSystemAccess) {
      window
        .showSaveFilePicker({
          suggestedName: fileName,
        })
        .then((handle) => {
          handle
            .createWritable()
            .then((writable) => {
              createProgressBar(videoId, fileName);
              fetchNextPart(writable);
            })
            .catch((err) => {
              logger.error(err.message, fileName);
              createProgressBar(videoId, fileName);
              fetchNextPart(null);
            });
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            logger.error(err.message, fileName);
            createProgressBar(videoId, fileName);
            fetchNextPart(null);
          }
        });
    } else {
      createProgressBar(videoId, fileName);
      fetchNextPart(null);
    }
  };

  const tel_download_audio = (url) => {
    let _blobs = [];
    let _next_offset = 0;
    let _total_size = null;
    const fileName = hashCode(url) + ".ogg";
    const videoId = (Math.random() + 1).toString(36).substring(2, 10) + "_" + Date.now().toString();

    const fetchNextPart = (_writable) => {
      fetch(url, {
        method: "GET",
        headers: {
          Range: `bytes=${_next_offset}-`,
        },
      })
        .then((res) => {
          if (res.status !== 206 && res.status !== 200) {
            logger.error("Non 200/206 response: " + res.status, fileName);
            throw new Error("Non 200/206 response");
          }

          const match = res.headers.get("Content-Range")?.match(contentRangeRegex);
          if (match) {
            const startOffset = parseInt(match[1], 10);
            const endOffset = parseInt(match[2], 10);
            const totalSize = parseInt(match[3], 10);

            if (startOffset !== _next_offset) {
              logger.error("Gap detected between responses.", fileName);
              throw new Error("Gap detected between responses.");
            }
            if (_total_size && totalSize !== _total_size) {
              logger.error("Total size differs", fileName);
              throw new Error("Total size differs");
            }

            _next_offset = endOffset + 1;
            _total_size = totalSize;
            updateProgress(videoId, fileName, ((_next_offset * 100) / _total_size).toFixed(0));
          } else {
            const len = res.headers.get("Content-Length");
            if (len) {
              _total_size = parseInt(len, 10);
              _next_offset = _total_size;
              updateProgress(videoId, fileName, 100);
            }
          }
          return res.blob();
        })
        .then(async (resBlob) => {
          if (_writable !== null) {
            await _writable.write(resBlob);
          } else {
            _blobs.push(resBlob);
          }
        })
        .then(async () => {
          if (_total_size && _next_offset < _total_size) {
            fetchNextPart(_writable);
          } else {
            if (_writable !== null) {
              await _writable.close();
            } else {
              save();
            }
            completeProgress(videoId);
          }
        })
        .catch((reason) => {
          logger.error(reason, fileName);
          abortProgress(videoId);
        });
    };

    const save = () => {
      const blob = new Blob(_blobs, { type: "audio/ogg" });
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      document.body.appendChild(a);
      a.href = blobUrl;
      a.download = fileName;
      a.click();
      document.body.removeChild(a);
      setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10000);
    };

    const supportsFileSystemAccess =
      "showSaveFilePicker" in window &&
      (() => {
        try {
          return window.self === window.top;
        } catch {
          return false;
        }
      })();

    if (supportsFileSystemAccess) {
      window
        .showSaveFilePicker({ suggestedName: fileName })
        .then((handle) => {
          handle
            .createWritable()
            .then((writable) => {
              createProgressBar(videoId, fileName);
              fetchNextPart(writable);
            })
            .catch(() => {
              createProgressBar(videoId, fileName);
              fetchNextPart(null);
            });
        })
        .catch((err) => {
          if (err.name !== "AbortError") {
            createProgressBar(videoId, fileName);
            fetchNextPart(null);
          }
        });
    } else {
      createProgressBar(videoId, fileName);
      fetchNextPart(null);
    }
  };

  const tel_download_image = (imageUrl) => {
    let fileName = (Math.random() + 1).toString(36).substring(2, 10) + ".jpeg";
    try {
      const u = new URL(imageUrl, window.location.href);
      const pathname = u.pathname;
      const last = pathname.substring(pathname.lastIndexOf("/") + 1);
      if (last && (last.endsWith(".jpg") || last.endsWith(".jpeg") || last.endsWith(".png") || last.endsWith(".webp"))) {
        fileName = last;
      }
    } catch {}

    if (imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")) {
      const a = document.createElement("a");
      document.body.appendChild(a);
      a.href = imageUrl;
      a.download = fileName;
      a.click();
      document.body.removeChild(a);
    } else {
      fetch(imageUrl)
        .then((r) => r.blob())
        .then((blob) => {
          const blobUrl = window.URL.createObjectURL(blob);
          const a = document.createElement("a");
          document.body.appendChild(a);
          a.href = blobUrl;
          a.download = fileName;
          a.click();
          document.body.removeChild(a);
          setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10000);
        })
        .catch(() => {
          const a = document.createElement("a");
          document.body.appendChild(a);
          a.href = imageUrl;
          a.download = fileName;
          a.click();
          document.body.removeChild(a);
        });
    }
    logger.info("Download triggered", fileName);
  };

  // For WebZ / WebA (/a/ and /z/)
  function checkWebZ() {
    // Stories
    const storiesContainer = document.getElementById("StoryViewer");
    if (storiesContainer) {
      const createDownloadButton = () => {
        const downloadIcon = document.createElement("i");
        downloadIcon.className = "icon icon-download";
        const downloadButton = document.createElement("button");
        downloadButton.className =
          "Button TkphaPyQ tiny translucent-white round tel-download";
        downloadButton.appendChild(downloadIcon);
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        downloadButton.onclick = (e) => {
          e.stopPropagation();
          const video = storiesContainer.querySelector("video");
          const videoSrc =
            video?.src ||
            video?.currentSrc ||
            video?.querySelector("source")?.src;
          if (videoSrc) {
            tel_download_video(videoSrc);
          } else {
            const images = storiesContainer.querySelectorAll("img.PVZ8TOWS");
            if (images.length > 0) {
              const imageSrc = images[images.length - 1]?.src;
              if (imageSrc) tel_download_image(imageSrc);
            }
          }
        };
        return downloadButton;
      };

      const storyHeader =
        storiesContainer.querySelector(".GrsJNw3y") ||
        storiesContainer.querySelector(".DropdownMenu")?.parentNode;
      if (storyHeader && !storyHeader.querySelector(".tel-download")) {
        const firstBtn = storyHeader.querySelector("button");
        if (firstBtn) {
          storyHeader.insertBefore(createDownloadButton(), firstBtn);
        } else {
          storyHeader.appendChild(createDownloadButton());
        }
      }
    }

    // Media Viewer
    const mediaContainer = document.querySelector(
      "#MediaViewer .MediaViewerSlide--active"
    );
    const mediaViewerActions = document.querySelector(
      "#MediaViewer .MediaViewerActions"
    );
    if (!mediaContainer || !mediaViewerActions) return;

    const videoPlayer = mediaContainer.querySelector(
      ".MediaViewerContent > .VideoPlayer"
    );
    const img = mediaContainer.querySelector(".MediaViewerContent > div > img");

    const createBtn = () => {
      const downloadIcon = document.createElement("i");
      downloadIcon.className = "icon icon-download";
      const downloadButton = document.createElement("button");
      downloadButton.className =
        "Button smaller translucent-white round tel-download";
      downloadButton.setAttribute("type", "button");
      downloadButton.setAttribute("title", "Download");
      downloadButton.setAttribute("aria-label", "Download");
      downloadButton.appendChild(downloadIcon);
      return downloadButton;
    };

    if (videoPlayer) {
      const videoEl = videoPlayer.querySelector("video");
      const videoUrl = videoEl?.currentSrc || videoEl?.src;
      if (!videoUrl) return;

      const controls = videoPlayer.querySelector(".VideoPlayerControls");
      if (controls) {
        const buttons = controls.querySelector(".buttons");
        if (buttons && !buttons.querySelector("button.tel-download")) {
          const downloadBtn = createBtn();
          downloadBtn.setAttribute("data-tel-download-url", videoUrl);
          downloadBtn.onclick = (e) => {
            e.stopPropagation();
            const currentVideoUrl = videoPlayer.querySelector("video")?.currentSrc || videoPlayer.querySelector("video")?.src;
            if (currentVideoUrl) tel_download_video(currentVideoUrl);
          };
          const spacer = buttons.querySelector(".spacer");
          if (spacer) {
            spacer.after(downloadBtn);
          } else {
            buttons.appendChild(downloadBtn);
          }
        }
      }

      const existingBtn = mediaViewerActions.querySelector("button.tel-download");
      if (existingBtn) {
        if (
          mediaViewerActions.querySelectorAll('button[title="Download"]').length > 1
        ) {
          existingBtn.remove();
        } else if (
          existingBtn.getAttribute("data-tel-download-url") !== videoUrl
        ) {
          existingBtn.onclick = (e) => {
            e.stopPropagation();
            const currentVideoUrl = videoPlayer.querySelector("video")?.currentSrc || videoPlayer.querySelector("video")?.src;
            if (currentVideoUrl) tel_download_video(currentVideoUrl);
          };
          existingBtn.setAttribute("data-tel-download-url", videoUrl);
        }
      } else if (
        !mediaViewerActions.querySelector('button[title="Download"]')
      ) {
        const topBtn = createBtn();
        topBtn.setAttribute("data-tel-download-url", videoUrl);
        topBtn.onclick = (e) => {
          e.stopPropagation();
          const currentVideoUrl = videoPlayer.querySelector("video")?.currentSrc || videoPlayer.querySelector("video")?.src;
          if (currentVideoUrl) tel_download_video(currentVideoUrl);
        };
        mediaViewerActions.prepend(topBtn);
      }
    } else if (img && img.src) {
      const existingBtn = mediaViewerActions.querySelector("button.tel-download");
      if (existingBtn) {
        if (
          mediaViewerActions.querySelectorAll('button[title="Download"]').length > 1
        ) {
          existingBtn.remove();
        } else if (
          existingBtn.getAttribute("data-tel-download-url") !== img.src
        ) {
          existingBtn.onclick = (e) => {
            e.stopPropagation();
            tel_download_image(img.src);
          };
          existingBtn.setAttribute("data-tel-download-url", img.src);
        }
      } else if (
        !mediaViewerActions.querySelector('button[title="Download"]')
      ) {
        const topBtn = createBtn();
        topBtn.setAttribute("data-tel-download-url", img.src);
        topBtn.onclick = (e) => {
          e.stopPropagation();
          tel_download_image(img.src);
        };
        mediaViewerActions.prepend(topBtn);
      }
    }
  }

  // For WebK (/k/)
  function checkWebK() {
    /* Voice Message or Circle Video */
    const pinnedAudio = document.body?.querySelector(".pinned-audio");
    if (pinnedAudio) {
      const dataMid = pinnedAudio.getAttribute("data-mid");
      let downloadButtonPinnedAudio = document.body.querySelector("._tel_download_button_pinned_container");
      if (!downloadButtonPinnedAudio) {
        downloadButtonPinnedAudio = document.createElement("button");
        downloadButtonPinnedAudio.className =
          "btn-icon tgico-download _tel_download_button_pinned_container";
        downloadButtonPinnedAudio.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
      }

      const audioElements = document.body.querySelectorAll("audio-element");
      audioElements.forEach((audioElement) => {
        const bubble = audioElement.closest(".bubble");
        if (
          !bubble ||
          bubble.querySelector("._tel_download_button_pinned_container")
        ) {
          return;
        }
        if (
          dataMid &&
          downloadButtonPinnedAudio.getAttribute("data-mid") !== dataMid &&
          audioElement.getAttribute("data-mid") === dataMid
        ) {
          const link = audioElement.audio && audioElement.audio.getAttribute("src");
          const isAudio = audioElement.audio && audioElement.audio instanceof HTMLAudioElement;
          downloadButtonPinnedAudio.onclick = (e) => {
            e.stopPropagation();
            if (isAudio) {
              tel_download_audio(link);
            } else {
              tel_download_video(link);
            }
          };
          downloadButtonPinnedAudio.setAttribute("data-mid", dataMid);
          if (link) {
            const utils = pinnedAudio.querySelector(".pinned-container-wrapper-utils");
            if (utils && !utils.contains(downloadButtonPinnedAudio)) {
              utils.appendChild(downloadButtonPinnedAudio);
            }
          }
        }
      });
    }

    // Stories
    const storiesContainer = document.getElementById("stories-viewer");
    if (storiesContainer) {
      const createDownloadButton = () => {
        const downloadButton = document.createElement("button");
        downloadButton.className = "btn-icon rp tel-download";
        downloadButton.innerHTML = `<span class="tgico">${DOWNLOAD_ICON}</span><div class="c-ripple"></div>`;
        downloadButton.setAttribute("type", "button");
        downloadButton.setAttribute("title", "Download");
        downloadButton.setAttribute("aria-label", "Download");
        downloadButton.onclick = (e) => {
          e.stopPropagation();
          const video = storiesContainer.querySelector("video.media-video");
          const videoSrc =
            video?.src ||
            video?.currentSrc ||
            video?.querySelector("source")?.src;
          if (videoSrc) {
            tel_download_video(videoSrc);
          } else {
            const imageSrc = storiesContainer.querySelector("img.media-photo")?.src;
            if (imageSrc) tel_download_image(imageSrc);
          }
        };
        return downloadButton;
      };

      const storyHeader = storiesContainer.querySelector("[class^='_ViewerStoryHeaderRight']");
      if (storyHeader && !storyHeader.querySelector(".tel-download")) {
        storyHeader.prepend(createDownloadButton());
      }

      const storyFooter = storiesContainer.querySelector("[class^='_ViewerStoryFooterRight']");
      if (storyFooter && !storyFooter.querySelector(".tel-download")) {
        storyFooter.prepend(createDownloadButton());
      }
    }

    // Media Viewer
    const mediaContainer = document.querySelector(".media-viewer-whole");
    if (!mediaContainer) return;
    const mediaAspecter = mediaContainer.querySelector(
      ".media-viewer-movers .media-viewer-aspecter"
    );
    const mediaButtons = mediaContainer.querySelector(
      ".media-viewer-topbar .media-viewer-buttons"
    );
    if (!mediaAspecter || !mediaButtons) return;

    // Unhide buttons hidden by Telegram in restricted channels
    const hiddenButtons = mediaButtons.querySelectorAll("button.btn-icon.hide");
    let onDownload = null;
    for (const btn of hiddenButtons) {
      btn.classList.remove("hide");
      if (btn.textContent === FORWARD_ICON) {
        btn.classList.add("tgico-forward");
      }
      if (btn.textContent === DOWNLOAD_ICON) {
        btn.classList.add("tgico-download");
        onDownload = () => {
          btn.click();
        };
      }
    }

    const ckinPlayer = mediaAspecter.querySelector(".ckin__player");
    if (ckinPlayer) {
      const controls = mediaAspecter.querySelector(
        ".default__controls.ckin__controls"
      );
      if (controls && !controls.querySelector(".tel-download")) {
        const brControls = controls.querySelector(
          ".bottom-controls .right-controls"
        );
        if (brControls) {
          const downloadButton = document.createElement("button");
          downloadButton.className =
            "btn-icon default__button tgico-download tel-download";
          downloadButton.innerHTML = `<span class="tgico">${DOWNLOAD_ICON}</span>`;
          downloadButton.setAttribute("type", "button");
          downloadButton.setAttribute("title", "Download");
          downloadButton.setAttribute("aria-label", "Download");
          if (onDownload) {
            downloadButton.onclick = onDownload;
          } else {
            downloadButton.onclick = (e) => {
              e.stopPropagation();
              const v = mediaAspecter.querySelector("video");
              if (v?.src) tel_download_video(v.src);
            };
          }
          brControls.prepend(downloadButton);
        }
      }
    } else if (
      mediaAspecter.querySelector("video") &&
      !mediaButtons.querySelector("button.btn-icon.tgico-download")
    ) {
      const downloadButton = document.createElement("button");
      downloadButton.className = "btn-icon tgico-download tel-download";
      downloadButton.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
      downloadButton.setAttribute("type", "button");
      downloadButton.setAttribute("title", "Download");
      downloadButton.setAttribute("aria-label", "Download");
      if (onDownload) {
        downloadButton.onclick = onDownload;
      } else {
        downloadButton.onclick = (e) => {
          e.stopPropagation();
          const v = mediaAspecter.querySelector("video");
          if (v?.src) tel_download_video(v.src);
        };
      }
      mediaButtons.prepend(downloadButton);
    } else if (!mediaButtons.querySelector("button.btn-icon.tgico-download")) {
      const img = mediaAspecter.querySelector("img.thumbnail");
      if (!img || !img.src) {
        return;
      }
      const downloadButton = document.createElement("button");
      downloadButton.className = "btn-icon tgico-download tel-download";
      downloadButton.innerHTML = `<span class="tgico button-icon">${DOWNLOAD_ICON}</span>`;
      downloadButton.setAttribute("type", "button");
      downloadButton.setAttribute("title", "Download");
      downloadButton.setAttribute("aria-label", "Download");
      if (onDownload) {
        downloadButton.onclick = onDownload;
      } else {
        downloadButton.onclick = (e) => {
          e.stopPropagation();
          tel_download_image(img.src);
        };
      }
      mediaButtons.prepend(downloadButton);
    }
  }

  function init() {
    injectStyles();
    setupProgressBar();

    setInterval(() => {
      try {
        checkWebZ();
        checkWebK();
      } catch (err) {
        logger.error(err.message);
      }
    }, REFRESH_DELAY);

    logger.info("Telegram Media Downloader ready.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
