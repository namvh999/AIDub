const LIVE_MODEL = "gemini-3.5-live-translate-preview";
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const INPUT_BUFFER_SIZE = 2048;
const SEEK_RECONNECT_DELAY_MS = 150;
let activeCapture = null;

function stopPlayingSources(session) {
  if (!session) {
    return;
  }
  for (const source of session.playingSources) {
    try {
      source.stop(0);
      source.disconnect();
    } catch (error) {
      console.warn("Unable to stop a translated audio buffer:", error);
    }
  }
  session.playingSources.clear();
  if (session.audioContext) {
    session.nextPlaybackTime = session.audioContext.currentTime;
  }
}

function stopCapture(sessionId) {
  const session = activeCapture;
  if (!session) {
    return;
  }
  if (sessionId && session.sessionId !== sessionId) {
    return;
  }
  activeCapture = null;
  session.stopped = true;
  session.seekGeneration += 1;
  if (session.seekTimer !== null) {
    clearTimeout(session.seekTimer);
    session.seekTimer = null;
  }

  stopPlayingSources(session);

  if (session.audioContext) {
    try {
      session.audioContext.suspend();
    } catch {}
    try {
      session.audioContext.close().catch(() => {});
    } catch {}
  }

  if (session.processor) {
    session.processor.onaudioprocess = null;
    try {
      session.processor.disconnect();
    } catch {}
  }

  if (session.stream) {
    session.stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {}
    });
  }

  const websocket = session.websocket;
  session.websocket = null;
  if (websocket) {
    try {
      websocket.onmessage = null;
      websocket.onerror = null;
      websocket.onclose = null;
      if (websocket.readyState < WebSocket.CLOSING) {
        websocket.close(1000, "Dubbing stopped");
      }
    } catch {}
  }
}

function reportDubbingError(session, error) {
  if (session.stopped) {
    return;
  }
  const message = error?.message || "Gemini Live đã dừng ngoài dự kiến.";
  chrome.runtime.sendMessage({
    type: "DUBBING_ERROR",
    sessionId: session.sessionId,
    tabId: session.tabId,
    frameId: session.frameId,
    error: message
  }).catch((sendError) => console.error("Unable to report Gemini dubbing failure:", sendError));
}

function notifyTranscript(session, text) {
  if (!text || session.stopped) {
    return;
  }
  chrome.runtime.sendMessage({
    type: "DUBBING_TEXT",
    sessionId: session.sessionId,
    tabId: session.tabId,
    frameId: session.frameId,
    text
  }).catch((error) => console.warn("Unable to display dubbed speech text:", error));
}

function isVietnameseTranscript(text) {
  if (!text) {
    return false;
  }

  const normalized = text.normalize("NFC").toLowerCase();
  if (/[ăâđêôơưàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ]/u.test(normalized)) {
    return true;
  }

  const words = normalized.match(/[a-z]+/g) || [];
  if (words.length === 0) {
    return false;
  }

  const vietnameseWords = new Set([
    "toi", "tui", "ban", "anh", "chi", "em", "noi", "nói",
    "la", "là", "dang", "đang", "voi", "với", "khong", "không",
    "co", "có", "mot", "một", "hai", "ba", "nay", "này",
    "day", "đây", "cua", "của", "cho", "duoc", "được",
    "nguoi", "người", "minh", "mình", "tai", "tại", "se", "sẽ"
  ]);
  const matches = words.filter((word) => vietnameseWords.has(word)).length;
  return matches >= 2 || (words.length <= 5 && matches >= 1);
}

function playPcmAudio(session, base64Audio) {
  if (session.stopped || activeCapture !== session || session.reconfiguring) {
    return;
  }
  const binary = atob(base64Audio);
  const sampleCount = Math.floor(binary.length / 2);
  if (!sampleCount) {
    return;
  }
  const audioBuffer = session.audioContext.createBuffer(1, sampleCount, OUTPUT_SAMPLE_RATE);
  const samples = audioBuffer.getChannelData(0);
  const view = new DataView(Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }

  const source = session.audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(session.audioContext.destination);
  session.playingSources.add(source);
  source.addEventListener("ended", () => session.playingSources.delete(source), { once: true });

  const startAt = Math.max(session.audioContext.currentTime + 0.02, session.nextPlaybackTime);
  source.start(startAt);
  session.nextPlaybackTime = startAt + audioBuffer.duration;
}

function handleLiveMessage(session, message) {
  if (session.stopped || activeCapture !== session || session.reconfiguring) {
    return;
  }
  const content = message.serverContent;
  if (!content) {
    return;
  }
  if (session.targetLanguageCode === "vi" && content.inputTranscription?.text) {
    if (isVietnameseTranscript(content.inputTranscription.text)) {
      session.skipTranslationTurn = true;
      if (session.originalAudioGain) {
        session.originalAudioGain.gain.setTargetAtTime(1, session.audioContext.currentTime, 0.02);
      }
    }
  }
  if (!session.skipTranslationTurn && content.outputTranscription?.text) {
    notifyTranscript(session, content.outputTranscription.text);
  }
  for (const part of content.modelTurn?.parts || []) {
    if (!session.skipTranslationTurn && part.inlineData?.data) {
      playPcmAudio(session, part.inlineData.data);
    }
  }
  if (content.turnComplete || content.interrupted) {
    session.skipTranslationTurn = false;
    if (session.originalAudioGain && session.targetLanguageCode === "vi") {
      session.originalAudioGain.gain.setTargetAtTime(0.12, session.audioContext.currentTime, 0.02);
    }
  }
}

async function decodeWebSocketMessage(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  throw new Error("Gemini Live gửi kiểu dữ liệu không được hỗ trợ.");
}

function connectGeminiLive(session, apiKey, targetLanguageCode) {
  return new Promise((resolve, reject) => {
    const url = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
      + `?key=${encodeURIComponent(apiKey)}`;
    const websocket = new WebSocket(url);
    session.websocket = websocket;
    websocket.binaryType = "arraybuffer";
    let setupComplete = false;
    let failureHandled = false;
    const setupTimeout = setTimeout(() => {
      if (!setupComplete) {
        fail(new Error("Gemini Live không phản hồi khi kết nối."));
        websocket.close();
      }
    }, 20000);

    const fail = (error) => {
      if (failureHandled) {
        return;
      }
      if (!setupComplete) {
        failureHandled = true;
        clearTimeout(setupTimeout);
        reject(error);
        return;
      }
      if (session.stopped || activeCapture !== session || session.websocket !== websocket) {
        return;
      }
      failureHandled = true;
      clearTimeout(setupTimeout);
      reportDubbingError(session, error);
      stopCapture(session.sessionId);
    };

    websocket.addEventListener("open", () => {
      try {
        const systemInstruction = targetLanguageCode === "vi"
          ? "Translate the incoming speech naturally into Vietnamese. If the incoming speech is already Vietnamese, do not translate it and produce no translated audio or transcript."
          : "Translate the incoming speech naturally into the requested target language. Preserve the speaker's meaning and conversational tone.";
        websocket.send(JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: systemInstruction }]
            },
            generationConfig: {
              responseModalities: ["AUDIO"],
              translationConfig: {
                targetLanguageCode,
                echoTargetLanguage: false
              }
            }
          }
        }));
      } catch (error) {
        fail(error);
      }
    });

    websocket.addEventListener("message", async (event) => {
      if (session.stopped || activeCapture !== session || session.websocket !== websocket) {
        return;
      }
      let message;
      try {
        message = JSON.parse(await decodeWebSocketMessage(event.data));
      } catch (error) {
        fail(new Error(`Gemini Live trả về dữ liệu không hợp lệ: ${error.message}`));
        return;
      }
      if (session.stopped || activeCapture !== session || session.websocket !== websocket) {
        return;
      }

      if (message.error) {
        fail(new Error(message.error.message || "Gemini Live từ chối yêu cầu."));
        return;
      }
      if (message.setupComplete && !setupComplete) {
        setupComplete = true;
        clearTimeout(setupTimeout);
        resolve(websocket);
      }
      try {
        handleLiveMessage(session, message);
      } catch (error) {
        fail(new Error(`Không thể phát âm thanh dịch: ${error.message}`));
      }
    });

    websocket.addEventListener("error", () => {
      fail(new Error("Không kết nối được Gemini Live. Hãy kiểm tra API key và kết nối mạng."));
    });
    websocket.addEventListener("close", (event) => {
      fail(new Error(event.reason || "Kết nối Gemini Live đã đóng."));
    });
  });
}

function encodePcm(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function startLiveTranslation(message) {
  stopCapture();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId
      }
    },
    video: false
  });
  const audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(stream);
  const originalAudioGain = audioContext.createGain();
  originalAudioGain.gain.value = 0.12;
  source.connect(originalAudioGain);
  originalAudioGain.connect(audioContext.destination);

  const processor = audioContext.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  const session = {
    sessionId: message.sessionId,
    tabId: message.tabId,
    frameId: message.frameId,
    stream,
    audioContext,
    processor,
    websocket: null,
    stopped: false,
    reconfiguring: false,
    seekPending: false,
    seekGeneration: 0,
    seekTimer: null,
    originalAudioGain,
    skipTranslationTurn: false,
    apiKey: message.geminiApiKey,
    targetLanguageCode: message.targetLanguageCode,
    playingSources: new Set(),
    nextPlaybackTime: 0
  };
  activeCapture = session;
  stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
    if (activeCapture === session) {
      reportDubbingError(session, new Error("Âm thanh của tab không còn khả dụng."));
      stopCapture(session.sessionId);
    }
  }, { once: true }));

  try {
    await audioContext.resume();
    await connectGeminiLive(session, message.geminiApiKey, message.targetLanguageCode);
    processor.onaudioprocess = (event) => {
      if (session.stopped || session.reconfiguring || activeCapture !== session
        || session.websocket?.readyState !== WebSocket.OPEN) {
        return;
      }
      const audioData = encodePcm(event.inputBuffer.getChannelData(0));
      session.websocket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: audioData,
            mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`
          }
        }
      }));
    };
  } catch (error) {
    stopCapture(message.sessionId);
    throw error;
  }
}

function handleVideoSeek(message) {
  const session = activeCapture;
  if (!session || session.sessionId !== message.sessionId) {
    return;
  }

  if (message.phase === "start") {
    session.seekGeneration += 1;
    session.seekPending = true;
    if (session.seekTimer !== null) {
      clearTimeout(session.seekTimer);
      session.seekTimer = null;
    }

    session.reconfiguring = true;
    stopPlayingSources(session);
    const previousSocket = session.websocket;
    session.websocket = null;
    if (previousSocket?.readyState < WebSocket.CLOSING) {
      previousSocket.close(1000, "Video seek");
    }
    return;
  }

  if (message.phase === "end" && session.seekPending) {
    if (session.seekTimer !== null) {
      clearTimeout(session.seekTimer);
    }
    const generation = session.seekGeneration;
    session.seekTimer = setTimeout(() => {
      session.seekTimer = null;
      reconnectAfterVideoSeek(session, generation);
    }, SEEK_RECONNECT_DELAY_MS);
    return;
  }

  if (message.phase !== "end") {
    throw new Error("Sự kiện tua video không hợp lệ.");
  }
}

async function reconnectAfterVideoSeek(session, generation) {
  if (activeCapture !== session || session.stopped
    || !session.seekPending || generation !== session.seekGeneration) {
    return;
  }

  try {
    await connectGeminiLive(session, session.apiKey, session.targetLanguageCode);
    if (activeCapture !== session || session.stopped
      || !session.seekPending || generation !== session.seekGeneration) {
      return;
    }
    session.seekPending = false;
    session.reconfiguring = false;
  } catch (error) {
    if (activeCapture !== session || session.stopped || generation !== session.seekGeneration) {
      return;
    }
    reportDubbingError(session, error);
    stopCapture(session.sessionId);
  }
}

async function updateLiveLanguage(message) {
  const session = activeCapture;
  if (!session || session.sessionId !== message.sessionId) {
    throw new Error("Phiên lồng tiếng đã kết thúc.");
  }
  if (session.targetLanguageCode === message.targetLanguageCode) {
    return;
  }

  session.reconfiguring = true;
  stopPlayingSources(session);
  const previousSocket = session.websocket;
  session.websocket = null;
  if (previousSocket?.readyState === WebSocket.OPEN) {
    previousSocket.close(1000, "Target language changed");
  }
  try {
    await connectGeminiLive(session, session.apiKey, message.targetLanguageCode);
    if (activeCapture !== session || session.stopped) {
      throw new Error("Phiên lồng tiếng đã kết thúc.");
    }
    session.targetLanguageCode = message.targetLanguageCode;
    session.reconfiguring = false;
  } catch (error) {
    if (activeCapture === session && !session.stopped) {
      reportDubbingError(session, error);
      stopCapture(session.sessionId);
    }
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_LIVE_TRANSLATION") {
    startLiveTranslation(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Unable to start Gemini live dubbing:", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "STOP_LIVE_TRANSLATION") {
    stopCapture();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "UPDATE_LIVE_LANGUAGE") {
    updateLiveLanguage(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "HANDLE_VIDEO_SEEK") {
    try {
      handleVideoSeek(message);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  return false;
});
