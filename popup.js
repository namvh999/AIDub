const apiKeyInput = document.querySelector("#api-key");
const languageInput = document.querySelector("#target-language");
const toggleButton = document.querySelector("#toggle-btn");
const applyLangButton = document.querySelector("#apply-lang-btn");
const btnIcon = document.querySelector("#btn-icon");
const btnLabel = document.querySelector("#btn-label");
const statusElement = document.querySelector("#status");
const studocuStatusElement = document.querySelector("#studocu-status");

let currentTabId = null;
let tabEnabled = false;
let enabledLanguageCode = "";
let isProcessing = false;

function showStatus(htmlOrText, isError = false, isActive = false) {
  statusElement.innerHTML = htmlOrText;
  statusElement.classList.toggle("error", isError);
  statusElement.classList.toggle("active", isActive);
}

function updateUI() {
  const isLanguageChanged = tabEnabled && languageInput.value !== enabledLanguageCode;

  if (tabEnabled) {
    if (isLanguageChanged) {
      toggleButton.className = "secondary";
      btnIcon.textContent = "⏹";
      btnLabel.textContent = "Dừng";

      applyLangButton.hidden = false;
      applyLangButton.className = "primary";
      const langName = languageInput.selectedOptions[0]?.textContent || "";
      applyLangButton.querySelector("span").textContent = `Đổi sang ${langName}`;

      showStatus("Đã chọn ngôn ngữ khác. Bấm để áp dụng.");
    } else {
      toggleButton.className = "danger";
      btnIcon.textContent = "⏹";
      btnLabel.textContent = "Dừng lồng tiếng";
      applyLangButton.hidden = true;

      const currentLang = languageInput.selectedOptions[0]?.textContent || "";
      showStatus(`<span class="pulse-dot"></span> Đang lồng tiếng · ${currentLang}`, false, true);
    }
  } else {
    toggleButton.className = "primary";
    btnIcon.textContent = "▶";
    btnLabel.textContent = "Bật lồng tiếng";
    applyLangButton.hidden = true;
    showStatus("Chưa bật cho trang này.");
  }
}

async function saveSettings() {
  const { geminiApiKey: savedApiKey } = await chrome.storage.local.get("geminiApiKey");
  const geminiApiKey = apiKeyInput.value.trim() || savedApiKey || "";
  const targetLanguageCode = languageInput.value;
  const targetLanguageName = languageInput.selectedOptions[0]?.textContent || "";
  if (!geminiApiKey) {
    throw new Error("Hãy nhập Gemini API key.");
  }
  await chrome.storage.local.set({ geminiApiKey, targetLanguageCode, targetLanguageName });
  apiKeyInput.value = geminiApiKey;
  return { targetLanguageCode, targetLanguageName };
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    throw new Error(response?.error || "Không thể thực hiện yêu cầu.");
  }
  return response;
}

async function startDubbing() {
  if (isProcessing) return;
  isProcessing = true;
  toggleButton.disabled = true;
  showStatus("Đang kích hoạt lồng tiếng…");
  try {
    const { targetLanguageCode, targetLanguageName } = await saveSettings();
    if (currentTabId === null) {
      throw new Error("Không tìm thấy tab đang mở.");
    }
    await sendMessage({
      type: "ENABLE_AUTO_DUBBING",
      tabId: currentTabId,
      targetLanguageCode,
      targetLanguageName
    });
    tabEnabled = true;
    enabledLanguageCode = targetLanguageCode;
    updateUI();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    isProcessing = false;
    toggleButton.disabled = false;
  }
}

async function stopDubbing() {
  if (isProcessing) return;
  isProcessing = true;
  toggleButton.disabled = true;
  applyLangButton.disabled = true;
  try {
    await sendMessage({
      type: "STOP_TRANSLATION",
      tabId: currentTabId
    });
    tabEnabled = false;
    enabledLanguageCode = "";
    updateUI();
    showStatus("Đã dừng lồng tiếng.");
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    isProcessing = false;
    toggleButton.disabled = false;
    applyLangButton.disabled = false;
  }
}

async function applyLanguage() {
  if (isProcessing) return;
  isProcessing = true;
  applyLangButton.disabled = true;
  toggleButton.disabled = true;
  showStatus("Đang chuyển đổi ngôn ngữ…");
  try {
    const { targetLanguageCode, targetLanguageName } = await saveSettings();
    if (currentTabId === null) {
      throw new Error("Không tìm thấy tab đang mở.");
    }
    await sendMessage({
      type: "ENABLE_AUTO_DUBBING",
      tabId: currentTabId,
      targetLanguageCode,
      targetLanguageName
    });
    tabEnabled = true;
    enabledLanguageCode = targetLanguageCode;
    updateUI();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    isProcessing = false;
    applyLangButton.disabled = false;
    toggleButton.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  toggleButton.disabled = true;
  try {
    const settings = await chrome.storage.local.get(["geminiApiKey", "targetLanguageCode"]);
    apiKeyInput.value = settings.geminiApiKey || "";
    languageInput.value = settings.targetLanguageCode || "vi";

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = typeof tab?.id === "number" ? tab.id : null;
    let dubbingStatusError = "";
    if (currentTabId !== null) {
      try {
        const status = await sendMessage({ type: "GET_TAB_DUBBING_STATUS", tabId: currentTabId });
        tabEnabled = status.enabled === true;
        enabledLanguageCode = status.targetLanguageCode || "";
      } catch (error) {
        dubbingStatusError = error.message;
      }
    }
    updateUI();
    if (tab?.url && /studocu\.com|studeersnel\.nl/i.test(tab.url)) {
      if (studocuStatusElement) {
        studocuStatusElement.textContent = "Đang hoạt động trên trang Studocu này. Nút Download PDF đã sẵn sàng.";
      }
    }
    if (dubbingStatusError) {
      showStatus(dubbingStatusError, true);
    }
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    toggleButton.disabled = false;
  }
});

languageInput.addEventListener("change", updateUI);

toggleButton.addEventListener("click", () => {
  if (tabEnabled) {
    stopDubbing();
  } else {
    startDubbing();
  }
});

applyLangButton.addEventListener("click", applyLanguage);
