"use strict";

const DATA_URL = "data.json";
const DB_NAME = "linguapolis_db_v2";
const DB_VERSION = 1;
const APP_VERSION = 3;
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`;

const KEYS = {
  profiles: "linguapolis_profiles_v2",
  selectedCharacter: "linguapolis_selected_character_v2"
};

const SKILLS = {
  confidence: "Уверенность",
  vocabulary: "Лексика",
  fluency: "Беглость",
  accuracy: "Точность"
};

const ACCENTS = {
  violet: ["#6856c9", "#e6e0fa"],
  blue: ["#3f6f9e", "#dcebf5"],
  sand: ["#8a6d50", "#eee3d4"],
  green: ["#487866", "#dcebe3"],
  rose: ["#9a5f70", "#f2dfe4"],
  orange: ["#9b6737", "#f3e2ce"]
};

let APP_DATA = null;
let database = null;
let currentCharacter = null;
let playerState = null;
let currentView = "lesson";
let answerDraftStarted = false;
let isSubmittingAnswer = false;
let isFinishingLesson = false;
let draftSaveTimer = null;

class BrowserDatabase {
  constructor() {
    this.db = null;
    this.mode = "indexeddb";
    this.memory = { events: [], answers: [] };
  }

  async init() {
    if (!window.indexedDB || typeof window.indexedDB.open !== "function") {
      this.selectFallbackMode();
      return;
    }

    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("events")) {
            const events = db.createObjectStore("events", { keyPath: "id", autoIncrement: true });
            events.createIndex("eventName", "eventName", { unique: false });
            events.createIndex("timestamp", "timestamp", { unique: false });
          }
          if (!db.objectStoreNames.contains("answers")) {
            const answers = db.createObjectStore("answers", { keyPath: "id" });
            answers.createIndex("characterId", "characterId", { unique: false });
            answers.createIndex("timestamp", "timestamp", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("IndexedDB blocked"));
      });
    } catch (error) {
      console.warn("IndexedDB unavailable, using local fallback", error);
      this.selectFallbackMode();
    }
  }

  selectFallbackMode() {
    this.mode = storageAvailable() ? "local-fallback" : "memory";
  }

  fallbackKey(store) {
    return `linguapolis_db_${store}`;
  }

  async add(store, value) {
    if (this.mode === "memory") {
      this.memory[store].push({ ...value, id: value.id || `${store}-${Date.now()}-${Math.random()}` });
      return;
    }
    if (this.mode === "local-fallback") {
      const rows = safeParseJson(safeStorageGet(this.fallbackKey(store)), []);
      rows.push({ ...value, id: value.id || `${store}-${Date.now()}-${Math.random()}` });
      safeStorageSet(this.fallbackKey(store), JSON.stringify(rows));
      return;
    }
    return this.run(store, "readwrite", objectStore => objectStore.add(value));
  }

  async put(store, value) {
    if (this.mode === "memory") {
      const index = this.memory[store].findIndex(row => row.id === value.id);
      if (index >= 0) this.memory[store][index] = structuredClone(value);
      else this.memory[store].push(structuredClone(value));
      return;
    }
    if (this.mode === "local-fallback") {
      const rows = safeParseJson(safeStorageGet(this.fallbackKey(store)), []);
      const index = rows.findIndex(row => row.id === value.id);
      if (index >= 0) rows[index] = value;
      else rows.push(value);
      safeStorageSet(this.fallbackKey(store), JSON.stringify(rows));
      return;
    }
    return this.run(store, "readwrite", objectStore => objectStore.put(value));
  }

  async getAll(store) {
    if (this.mode === "memory") return structuredClone(this.memory[store]);
    if (this.mode === "local-fallback") {
      return safeParseJson(safeStorageGet(this.fallbackKey(store)), []);
    }
    return this.run(store, "readonly", objectStore => objectStore.getAll());
  }

  async clear(store) {
    if (this.mode === "memory") {
      this.memory[store] = [];
      return;
    }
    if (this.mode === "local-fallback") {
      safeStorageRemove(this.fallbackKey(store));
      return;
    }
    return this.run(store, "readwrite", objectStore => objectStore.clear());
  }

  async run(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Database transaction aborted"));
      transaction.oncomplete = () => resolve(result);
    });
  }
}

document.addEventListener("DOMContentLoaded", () => boot().catch(handleFatalError));

async function boot() {
  database = new BrowserDatabase();
  await database.init();
  APP_DATA = await loadAppData();
  validateAppData(APP_DATA);
  bindGlobalEvents();
  updateConnectionStatus();
  renderCharacterGrid();

  const selectedId = safeStorageGet(KEYS.selectedCharacter);
  if (selectedId) {
    const character = APP_DATA.characters.find(item => item.id === selectedId);
    if (character) await enterProfile(character, true);
  }

  await logEvent("app_boot", { databaseMode: database.mode, appVersion: APP_VERSION });
}

async function loadAppData() {
  const embedded = readEmbeddedData();
  if (location.protocol === "file:" && embedded) return embedded;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${DATA_URL}?v=${APP_VERSION}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Не удалось загрузить ${DATA_URL}: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (embedded) {
      console.warn("Using embedded lesson data", error);
      return embedded;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function readEmbeddedData() {
  const node = document.getElementById("app-data");
  if (!node?.textContent.trim()) return null;
  return safeParseJson(node.textContent, null);
}

function validateAppData(data) {
  if (!data || !Array.isArray(data.characters) || !data.characters.length) {
    throw new Error("В файле данных нет персонажей.");
  }
  if (!Array.isArray(data.lessons) || !data.lessons.length) {
    throw new Error("В файле данных нет уроков.");
  }
  data.lessons.forEach((lesson, index) => {
    if (!lesson.id || !lesson.title || !Array.isArray(lesson.prompts) || !lesson.prompts.length) {
      throw new Error(`Некорректно заполнен урок №${index + 1}.`);
    }
  });
}

function bindGlobalEvents() {
  document.addEventListener("click", async event => {
    const tracked = event.target.closest("[data-track]");
    if (tracked) {
      await logEvent("ui_click", {
        target: tracked.dataset.track,
        label: tracked.textContent.trim().slice(0, 80),
        view: currentView
      });
    }
  });

  document.querySelectorAll("[data-view]").forEach(button => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  document.querySelectorAll("[data-action='home']").forEach(button => {
    button.addEventListener("click", () => switchView("lesson"));
  });
  document.querySelector("[data-action='logout']").addEventListener("click", logout);
  document.querySelectorAll("[data-action='close-modal']").forEach(button => button.addEventListener("click", closeLessonDialog));

  document.addEventListener("click", event => {
    const chunk = event.target.closest("[data-chunk]");
    if (chunk) insertHint(chunk.dataset.chunk);
  });

  const answerInput = document.getElementById("answer-input");
  answerInput.addEventListener("input", () => {
    document.getElementById("answer-counter").textContent = `${answerInput.value.length} / 280`;
    updateSubmitState();
    scheduleDraftSave(answerInput.value);
    if (!answerDraftStarted && answerInput.value.trim()) {
      answerDraftStarted = true;
      logEvent("answer_started", { lessonId: activeLesson()?.id, promptIndex: activeSession()?.promptIndex });
    }
  });
  answerInput.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submitAnswer();
    }
  });
  answerInput.addEventListener("blur", flushDraftSave);

  document.getElementById("submit-answer").addEventListener("click", submitAnswer);
  document.getElementById("next-dialogue").addEventListener("click", continueDialogue);
  document.getElementById("finish-lesson").addEventListener("click", openLessonSummary);
  document.getElementById("confirm-finish").addEventListener("click", confirmLessonFinish);
  document.getElementById("save-skills").addEventListener("click", saveAdminSkills);
  document.getElementById("export-data").addEventListener("click", exportDatabase);
  document.getElementById("export-csv").addEventListener("click", exportAnswersCsv);
  document.getElementById("import-data").addEventListener("click", () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", importDatabase);
  document.getElementById("clear-events").addEventListener("click", clearEventLog);
  document.getElementById("reset-service").addEventListener("click", resetService);
  document.getElementById("event-filter").addEventListener("change", renderAdmin);
  document.getElementById("answer-profile-filter").addEventListener("change", renderAdmin);

  const lessonDialog = document.getElementById("lesson-dialog");
  lessonDialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeLessonDialog();
  });
  lessonDialog.addEventListener("click", event => {
    if (event.target === lessonDialog) closeLessonDialog();
  });

  window.addEventListener("online", updateConnectionStatus);
  window.addEventListener("offline", updateConnectionStatus);
  window.addEventListener("beforeunload", flushDraftSave);
}

function getProfiles() {
  if (!storageAvailable()) return {};
  return safeParseJson(safeStorageGet(KEYS.profiles), {});
}

function saveProfiles(profiles) {
  safeStorageSet(KEYS.profiles, JSON.stringify(profiles));
}

function createProfile(character) {
  return {
    characterId: character.id,
    level: 1,
    xp: 0,
    xpNext: 100,
    coins: 0,
    skills: {
      confidence: clamp(character.startingStats.confidence),
      vocabulary: clamp(character.startingStats.vocabulary),
      fluency: clamp(character.startingStats.fluency),
      accuracy: clamp(character.startingStats.accuracy)
    },
    completedLessons: 0,
    lessonIndex: 0,
    streak: 0,
    lastLessonDate: null,
    unlocks: [],
    session: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function saveCurrentProfile() {
  if (!currentCharacter || !playerState) return;
  playerState.updatedAt = new Date().toISOString();
  const profiles = getProfiles();
  profiles[currentCharacter.id] = playerState;
  saveProfiles(profiles);
}

function normalizeProfile(profile, character) {
  const base = createProfile(character);
  const source = profile && typeof profile === "object" ? profile : {};
  return {
    ...base,
    ...source,
    level: Math.max(1, Number(source.level) || 1),
    xp: Math.max(0, Number(source.xp) || 0),
    xpNext: Math.max(50, Number(source.xpNext) || 100),
    coins: Math.max(0, Number(source.coins) || 0),
    completedLessons: Math.max(0, Number(source.completedLessons) || 0),
    lessonIndex: Math.max(0, Number(source.lessonIndex) || 0) % APP_DATA.lessons.length,
    streak: Math.max(0, Number(source.streak) || 0),
    skills: Object.keys(SKILLS).reduce((result, key) => {
      result[key] = clamp(source.skills?.[key] ?? base.skills[key]);
      return result;
    }, {}),
    unlocks: Array.isArray(source.unlocks) ? [...new Set(source.unlocks.filter(Boolean))] : [],
    session: source.session && typeof source.session === "object" ? source.session : null
  };
}

function renderCharacterGrid() {
  const profiles = getProfiles();
  const grid = document.getElementById("character-grid");
  grid.innerHTML = "";

  APP_DATA.characters.forEach(character => {
    const [color, tint] = ACCENTS[character.accent] || ACCENTS.violet;
    const profile = profiles[character.id];
    const card = document.createElement("button");
    card.type = "button";
    card.className = "character-card";
    card.style.setProperty("--character-color", color);
    card.style.setProperty("--character-tint", tint);
    card.dataset.track = `select_character_${character.id}`;
    card.innerHTML = `
      <span class="character-avatar">${escapeHtml(character.initials)}</span>
      <span class="character-role">${escapeHtml(character.role)}</span>
      <h2>${escapeHtml(character.name)}</h2>
      <p>${escapeHtml(character.description)}</p>
      ${profile ? `<span class="character-progress"><i></i>Продолжить · уровень ${Number(profile.level || 1)}</span>` : ""}
    `;
    card.addEventListener("click", () => enterProfile(character));
    grid.appendChild(card);
  });
}

async function enterProfile(character, restored = false) {
  currentCharacter = character;
  const profiles = getProfiles();
  playerState = normalizeProfile(profiles[character.id], character);
  ensureLessonSession();
  safeStorageSet(KEYS.selectedCharacter, character.id);
  saveCurrentProfile();

  document.getElementById("welcome-view").classList.add("is-hidden");
  document.getElementById("app-shell").classList.remove("is-hidden");
  setCharacterTheme(character);
  renderEverything();
  await switchView("lesson", false);
  await logEvent(restored ? "session_restored" : "character_selected", { characterId: character.id });
}

function setCharacterTheme(character) {
  const [color] = ACCENTS[character.accent] || ACCENTS.violet;
  document.documentElement.style.setProperty("--character-color", color);
}

function ensureLessonSession() {
  const lesson = APP_DATA.lessons[playerState.lessonIndex % APP_DATA.lessons.length];
  if (!playerState.session || playerState.session.lessonId !== lesson.id || playerState.session.rewardClaimed) {
    playerState.session = {
      id: crypto.randomUUID ? crypto.randomUUID() : `lesson-${Date.now()}`,
      lessonId: lesson.id,
      promptIndex: 0,
      answers: [],
      awaitingNext: false,
      readyToFinish: false,
      rewardClaimed: false,
      draft: "",
      draftPromptIndex: 0,
      startedAt: new Date().toISOString()
    };
    return;
  }

  const session = playerState.session;
  session.answers = Array.isArray(session.answers) ? session.answers : [];
  session.promptIndex = Math.max(0, Math.min(Number(session.promptIndex) || 0, lesson.prompts.length));
  session.awaitingNext = Boolean(session.awaitingNext);
  session.readyToFinish = Boolean(session.readyToFinish);
  session.rewardClaimed = Boolean(session.rewardClaimed);
  session.draft = typeof session.draft === "string" ? session.draft.slice(0, 280) : "";
  session.draftPromptIndex = Number.isFinite(Number(session.draftPromptIndex)) ? Number(session.draftPromptIndex) : session.promptIndex;
}

function activeSession() {
  return playerState?.session || null;
}

function activeLesson() {
  if (!playerState) return null;
  return APP_DATA.lessons[playerState.lessonIndex % APP_DATA.lessons.length];
}

function renderEverything() {
  renderProfile();
  renderLesson();
}

function renderProfile() {
  const average = averageSkill();
  setText("profile-name", currentCharacter.name);
  setText("profile-description", currentCharacter.description);
  setText("profile-level", playerState.level);
  setText("top-level", playerState.level);
  setText("profile-coins", playerState.coins);
  setText("xp-label", `${playerState.xp} / ${playerState.xpNext} XP`);
  document.getElementById("xp-progress").style.width = `${Math.min(100, (playerState.xp / playerState.xpNext) * 100)}%`;
  setText("average-skill", Math.round(average));

  const avatar = document.getElementById("profile-avatar");
  avatar.textContent = currentCharacter.initials;

  const skillsList = document.getElementById("skills-list");
  skillsList.innerHTML = Object.entries(SKILLS).map(([key, label]) => {
    const value = clamp(playerState.skills[key]);
    return `
      <div class="skill-row">
        <div class="skill-label"><span>${label}</span><strong>${Math.round(value)}</strong></div>
        <div class="skill-track"><span style="width:${value}%"></span></div>
      </div>
    `;
  }).join("");

  const stage = getProgressStage(average);
  document.getElementById("next-unlock").innerHTML = stage.next
    ? `<strong>${escapeHtml(stage.current.label)} · ${Math.round(average)}%</strong>Ещё ${Math.max(0, Math.ceil(stage.next.value - average))} пунктов до «${escapeHtml(stage.next.unlock)}».`
    : `<strong>Mastery · 100%</strong>Все режимы открыты. Дальше растёт качество и стабильность ответов.`;

  document.getElementById("progress-roadmap").innerHTML = APP_DATA.skillMilestones.map(milestone => {
    const reached = average >= milestone.value;
    const isNext = stage.next?.value === milestone.value;
    return `<div class="roadmap-step${reached ? " is-reached" : ""}${isNext ? " is-next" : ""}" title="${escapeHtml(milestone.unlock)}">${milestone.value}</div>`;
  }).join("");
}

function getProgressStage(value) {
  const milestones = APP_DATA.skillMilestones;
  let current = { value: 0, label: "Start", unlock: "Базовая практика" };
  let next = milestones[0] || null;
  for (const milestone of milestones) {
    if (value >= milestone.value) current = milestone;
    if (value < milestone.value) {
      next = milestone;
      break;
    }
    next = null;
  }
  return { current, next };
}

function renderLesson() {
  const lesson = activeLesson();
  const session = activeSession();
  if (!lesson || !session) return;

  setText("lesson-kicker", `УРОК ${String((playerState.lessonIndex % APP_DATA.lessons.length) + 1).padStart(2, "0")}`);
  setText("lesson-title", lesson.title);
  setText("lesson-goal", lesson.goal);
  setText("npc-name", lesson.npc.name);
  setText("npc-role", lesson.npc.role);
  setText("npc-avatar", lesson.npc.initial);

  const displayedStep = Math.min(session.promptIndex + 1, lesson.prompts.length);
  setText("lesson-step", `${displayedStep} / ${lesson.prompts.length}`);

  renderChatHistory(lesson, session);
  renderPromptControls(lesson, session);
  renderEvaluation(session);
  renderFinishState(lesson, session);
}

function renderChatHistory(lesson, session) {
  const chat = document.getElementById("chat-log");
  const items = [];

  session.answers.forEach(answer => {
    const prompt = lesson.prompts[answer.promptIndex];
    items.push(`<div class="chat-bubble npc">${escapeHtml(prompt.npc)}</div>`);
    items.push(`<div class="chat-bubble user">${escapeHtml(answer.text)}</div>`);
    items.push(`<div class="chat-bubble system">Оценка ${answer.metrics.overall}/100 · навыки обновлены</div>`);
  });

  if (!session.awaitingNext && session.promptIndex < lesson.prompts.length) {
    const current = lesson.prompts[session.promptIndex];
    items.push(`<div class="chat-bubble npc">${escapeHtml(current.npc)}</div>`);
  }

  if (session.readyToFinish) {
    items.push(`<div class="chat-bubble system">Диалог завершён. Откройте итог урока.</div>`);
  }

  chat.innerHTML = items.join("");
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
}

function renderPromptControls(lesson, session) {
  const input = document.getElementById("answer-input");
  const submit = document.getElementById("submit-answer");
  const chunks = document.getElementById("target-chunks");
  const draftStatus = document.getElementById("draft-status");

  if (session.promptIndex >= lesson.prompts.length) {
    setText("prompt-task", "Диалог завершён — можно подвести итог.");
    chunks.innerHTML = "";
    input.value = "";
    input.disabled = true;
    submit.disabled = true;
    setText("answer-counter", "0 / 280");
    setText("draft-status", "Все реплики сохранены.");
    return;
  }

  const prompt = lesson.prompts[session.promptIndex];
  setText("prompt-task", prompt.task);
  chunks.innerHTML = prompt.targetChunks.map(chunk => `<button class="chunk" type="button" data-chunk="${escapeHtml(chunk)}" title="Добавить фразу в ответ">${escapeHtml(chunk)}</button>`).join("");
  input.disabled = session.awaitingNext;
  if (session.awaitingNext) {
    input.value = "";
    submit.disabled = true;
    setText("answer-counter", "0 / 280");
    setText("draft-status", "Ответ сохранён.");
    return;
  }

  const draft = session.draftPromptIndex === session.promptIndex ? session.draft || "" : "";
  input.value = draft;
  setText("answer-counter", `${draft.length} / 280`);
  draftStatus.textContent = draft ? "Черновик восстановлен." : "Черновик сохраняется автоматически.";
  updateSubmitState();
}

function renderEvaluation(session) {
  const panel = document.getElementById("evaluation-panel");
  if (!session.awaitingNext || !session.answers.length) {
    panel.classList.add("is-hidden");
    return;
  }

  const answer = session.answers[session.answers.length - 1];
  const metrics = answer.metrics;
  panel.classList.remove("is-hidden");
  setText("overall-score", metrics.overall);
  setText("evaluation-title", scoreTitle(metrics.overall));
  document.getElementById("metric-grid").innerHTML = [
    ["Уместность", metrics.relevance],
    ["Лексика", metrics.vocabulary],
    ["Структура", metrics.structure],
    ["Беглость", metrics.fluency]
  ].map(([label, score]) => `<div class="metric-card"><span>${label}</span><strong>${score}</strong></div>`).join("");
  setText("feedback-text", answer.feedback.join(" "));
  const prompt = activeLesson().prompts[answer.promptIndex];
  document.getElementById("model-answer").innerHTML = prompt.exampleAnswer
    ? `<strong>Один из естественных вариантов</strong><span>&nbsp;${escapeHtml(prompt.exampleAnswer)}</span>`
    : `<strong>Подсказка</strong><span>&nbsp;Попробуйте использовать: ${prompt.targetChunks.map(escapeHtml).join(" · ")}</span>`;
  setText("next-dialogue", session.promptIndex === activeLesson().prompts.length - 1 ? "Перейти к итогу →" : "Продолжить диалог →");
}

function renderFinishState(lesson, session) {
  const button = document.getElementById("finish-lesson");
  button.disabled = !session.readyToFinish;
  if (session.readyToFinish) {
    const averageScore = average(session.answers.map(answer => answer.metrics.overall));
    setText("finish-title", `Диалог готов · средняя оценка ${Math.round(averageScore)}/100`);
    setText("finish-copy", `Откройте итог, получите ${lesson.reward.xp} XP и ${lesson.reward.coins} монет.`);
  } else {
    const remaining = Math.max(0, lesson.prompts.length - session.answers.length);
    setText("finish-title", "Завершение урока");
    setText("finish-copy", `Осталось ответить на ${remaining} ${pluralize(remaining, ["реплику", "реплики", "реплик"])}.`);
  }
}

function updateSubmitState() {
  const input = document.getElementById("answer-input");
  const submit = document.getElementById("submit-answer");
  const session = activeSession();
  if (!input || !submit || !session) return;
  const hasEnoughText = input.value.trim().length >= 3;
  submit.disabled = isSubmittingAnswer || input.disabled || session.awaitingNext || session.readyToFinish || !hasEnoughText;
}

function scheduleDraftSave(value) {
  const session = activeSession();
  if (!session || session.awaitingNext || session.readyToFinish) return;
  session.draft = String(value || "").slice(0, 280);
  session.draftPromptIndex = session.promptIndex;
  setText("draft-status", "Сохраняем черновик…");
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    saveCurrentProfile();
    setText("draft-status", session.draft ? "Черновик сохранён." : "Черновик сохраняется автоматически.");
  }, 280);
}

function flushDraftSave() {
  if (!draftSaveTimer) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = null;
  saveCurrentProfile();
  if (activeSession()?.draft) setText("draft-status", "Черновик сохранён.");
}

function insertHint(chunk) {
  const input = document.getElementById("answer-input");
  const session = activeSession();
  if (!chunk || !input || input.disabled || !session) return;
  const existing = input.value.trim();
  const addition = existing ? `${existing}${/[.!?]$/.test(existing) ? " " : ". "}${chunk}` : chunk;
  input.value = addition.slice(0, 280);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  logEvent("hint_used", { lessonId: activeLesson()?.id, promptIndex: session.promptIndex, chunk });
}

function validateAnswerText(text) {
  const latinWords = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
  const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
  const cyrillicLetters = (text.match(/[А-Яа-яЁё]/g) || []).length;
  const letterTotal = latinLetters + cyrillicLetters;
  const englishRatio = letterTotal ? latinLetters / letterTotal : 0;
  const uniqueRatio = latinWords.length ? new Set(latinWords.map(word => word.toLowerCase())).size / latinWords.length : 0;

  if (latinWords.length < 3) {
    return { valid: false, title: "Добавьте английский текст", message: "Нужно хотя бы 3 английских слова." };
  }
  if (englishRatio < .7) {
    return { valid: false, title: "Ответ должен быть на английском", message: "Попробуйте написать основную часть реплики английскими словами." };
  }
  if (/\b([A-Za-z]+)(?:\s+\1){2,}\b/i.test(text) || (latinWords.length >= 5 && uniqueRatio < .45)) {
    return { valid: false, title: "Слишком много повторов", message: "Сформулируйте короткое, но связное предложение." };
  }
  return { valid: true, latinWords, englishRatio };
}

async function submitAnswer() {
  const lesson = activeLesson();
  const session = activeSession();
  const input = document.getElementById("answer-input");
  const text = input.value.trim();
  const submit = document.getElementById("submit-answer");
  if (!lesson || !session || session.awaitingNext || session.readyToFinish || isSubmittingAnswer) return;

  const validation = validateAnswerText(text);
  if (!validation.valid) {
    toast(validation.title, validation.message);
    input.focus();
    return;
  }

  isSubmittingAnswer = true;
  submit.disabled = true;
  submit.classList.add("is-loading");
  submit.textContent = "Проверяем…";

  const prompt = lesson.prompts[session.promptIndex];
  const metrics = evaluateAnswer(text, prompt);
  const feedback = buildFeedback(metrics);
  const gains = calculateSkillGains(metrics);

  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : `answer-${Date.now()}`,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    lessonSessionId: session.id,
    characterId: currentCharacter.id,
    characterName: currentCharacter.name,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    promptIndex: session.promptIndex,
    prompt: prompt.npc,
    task: prompt.task,
    text,
    targetChunks: prompt.targetChunks,
    metrics,
    feedback,
    skillGains: gains
  };

  try {
    await database.put("answers", record);
    const crossedUnlocks = applySkillGains(gains);
    const answerXp = metrics.overall >= 45 ? Math.max(2, Math.round((metrics.overall - 35) / 8)) : 0;
    addXp(answerXp);
    playerState.coins += metrics.overall >= 45 ? (metrics.targetUsed ? 4 : 2) : 0;

    session.answers.push(record);
    session.awaitingNext = true;
    session.draft = "";
    session.draftPromptIndex = session.promptIndex;
    answerDraftStarted = false;
    flushDraftSave();
    saveCurrentProfile();
    renderEverything();

    await logEvent("answer_submitted", {
      answerId: record.id,
      lessonId: lesson.id,
      promptIndex: record.promptIndex,
      overall: metrics.overall,
      metrics,
      targetUsed: metrics.targetUsed,
      length: text.length
    });
    await logEvent("skills_changed", { source: "answer", gains, values: playerState.skills });

    if (crossedUnlocks.length) crossedUnlocks.forEach(unlock => toast("Новый этап навыка", unlock));
  } catch (error) {
    console.error("Could not save answer", error);
    toast("Ответ не сохранился", "Проверьте доступ к хранилищу и попробуйте ещё раз.");
  } finally {
    isSubmittingAnswer = false;
    submit.classList.remove("is-loading");
    submit.innerHTML = "Отправить ответ <span>→</span>";
    updateSubmitState();
  }
}

function evaluateAnswer(text, prompt) {
  const clean = text.replace(/\s+/g, " ").trim();
  const lower = clean.toLowerCase();
  const words = lower.match(/[a-z]+(?:'[a-z]+)?/g) || [];
  const uniqueWords = new Set(words);
  const keywordHits = prompt.keywords.filter(keyword => lower.includes(keyword.toLowerCase())).length;
  const targetHits = prompt.targetChunks.filter(chunk => lower.includes(chunk.toLowerCase())).length;
  const targetUsed = targetHits > 0;
  const connectors = ["because", "but", "and", "so", "also", "actually", "however", "then", "although"];
  const connectorHits = connectors.filter(word => words.includes(word)).length;
  const commonVerbs = [
    "am", "is", "are", "was", "were", "be", "have", "has", "do", "did",
    "can", "could", "would", "will", "shall", "should", "may", "might",
    "like", "love", "think", "need", "want", "move", "moved", "finish", "finished",
    "suggest", "look", "looking", "appreciate", "pay", "reach", "work", "help",
    "join", "confirm", "check", "prefer", "include", "included", "meet", "build"
  ];
  const hasVerb = commonVerbs.some(word => words.includes(word)) || /\b\w+(ed|ing)\b/.test(lower);
  const startsUppercase = /^[A-Z]/.test(clean);
  const endsPunctuation = /[.!?]$/.test(clean);
  const hasQuestion = /\?/.test(clean);
  const expectsQuestion = /уточ|переспрос|спрос|время|маршрут/i.test(prompt.task || "");
  const hasContraction = /\b(?:i'm|i've|i'd|don't|can't|it's|we're|that's)\b/i.test(lower);
  const duplicatePenalty = /(\b[a-z]+\b)(?:\s+\1){1,}/i.test(clean) ? 12 : 0;
  const wordCount = words.length;
  const uniqueRatio = wordCount ? uniqueWords.size / wordCount : 0;
  const averageWordLength = wordCount ? words.reduce((sum, word) => sum + word.length, 0) / wordCount : 0;

  let relevance = clampScore(24 + keywordHits * 15 + targetHits * 14 + Math.min(20, wordCount * 1.4));
  if (keywordHits === 0 && targetHits === 0) relevance = Math.min(relevance, 48);
  const vocabulary = clampScore(
    22 + uniqueRatio * 38 + Math.min(15, Math.max(0, averageWordLength - 3) * 5) + targetHits * 9 + connectorHits * 4
  );
  const structure = clampScore(
    24 + (startsUppercase ? 9 : 0) + (endsPunctuation ? 10 : 0) + (hasVerb ? 25 : 0) + (wordCount >= 6 ? 14 : wordCount * 2) + (connectorHits ? 7 : 0) + (expectsQuestion && hasQuestion ? 8 : 0)
  );
  const idealLengthScore = wordCount >= 7 && wordCount <= 28 ? 36 : Math.max(6, 36 - Math.abs(13 - wordCount) * 2.4);
  const fluency = clampScore(28 + idealLengthScore + connectorHits * 7 + (hasContraction ? 5 : 0) - duplicatePenalty);
  let overall = clampScore(relevance * .34 + vocabulary * .21 + structure * .25 + fluency * .20);
  if (!hasVerb) overall = Math.min(overall, 58);
  if (wordCount < 5) overall = Math.min(overall, 64);

  return {
    relevance: Math.round(relevance),
    vocabulary: Math.round(vocabulary),
    structure: Math.round(structure),
    fluency: Math.round(fluency),
    overall: Math.round(overall),
    targetUsed,
    targetHits,
    keywordHits,
    wordCount
  };
}

function buildFeedback(metrics) {
  const feedback = [];
  if (metrics.overall >= 85) feedback.push("Звучит естественно и точно.");
  else if (metrics.overall >= 70) feedback.push("Хороший понятный ответ.");
  else feedback.push("Смысл понятен, но реплику можно сделать полнее.");

  if (!metrics.targetUsed) feedback.push("Попробуйте встроить одну из предложенных фраз.");
  if (metrics.structure < 65) feedback.push("Добавьте полное предложение с глаголом и финальным знаком препинания.");
  if (metrics.vocabulary >= 80) feedback.push("Лексика достаточно разнообразная.");
  if (metrics.fluency < 65 && metrics.wordCount < 7) feedback.push("Добавьте одну деталь, чтобы ответ звучал разговорнее.");
  return feedback.slice(0, 3);
}

function calculateSkillGains(metrics) {
  const gain = score => score >= 88 ? 3 : score >= 68 ? 2 : score >= 52 ? 1 : 0;
  return {
    confidence: gain(metrics.overall),
    vocabulary: gain(metrics.vocabulary),
    fluency: gain(metrics.fluency),
    accuracy: gain(metrics.structure)
  };
}

function applySkillGains(gains) {
  const messages = [];
  Object.keys(SKILLS).forEach(skill => {
    const before = clamp(playerState.skills[skill]);
    const after = clamp(before + gains[skill]);
    playerState.skills[skill] = after;

    APP_DATA.skillMilestones.forEach(milestone => {
      const unlockKey = `${skill}:${milestone.value}`;
      if (before < milestone.value && after >= milestone.value && !playerState.unlocks.includes(unlockKey)) {
        playerState.unlocks.push(unlockKey);
        const message = `${SKILLS[skill]} достигла ${milestone.value}: открыто «${milestone.unlock}».`;
        messages.push(message);
        logEvent("milestone_unlocked", { skill, value: milestone.value, unlock: milestone.unlock });
      }
    });
  });
  return messages;
}

function continueDialogue() {
  const lesson = activeLesson();
  const session = activeSession();
  if (!session.awaitingNext) return;

  session.awaitingNext = false;
  if (session.promptIndex < lesson.prompts.length - 1) {
    session.promptIndex += 1;
    session.draft = "";
    session.draftPromptIndex = session.promptIndex;
  } else {
    session.promptIndex = lesson.prompts.length;
    session.readyToFinish = true;
    session.draft = "";
    session.draftPromptIndex = session.promptIndex;
  }
  saveCurrentProfile();
  renderLesson();
  if (!session.readyToFinish) document.getElementById("answer-input").focus();
  logEvent("dialogue_advanced", { lessonId: lesson.id, promptIndex: session.promptIndex });
}

async function openLessonSummary() {
  const lesson = activeLesson();
  const session = activeSession();
  if (!session.readyToFinish || session.rewardClaimed) return;

  const avgScore = Math.round(average(session.answers.map(answer => answer.metrics.overall)));
  const bestMetric = bestLessonMetric(session.answers);
  setText("modal-title", avgScore >= 85 ? "Очень сильный диалог" : avgScore >= 70 ? "Урок уверенно пройден" : "Хорошая практика");
  setText("modal-copy", `Вы завершили «${lesson.title}». Награда начислится только после подтверждения — повторно получить её нельзя.`);
  document.getElementById("modal-results").innerHTML = `
    <div class="modal-stat"><span>Средняя оценка</span><strong>${avgScore}</strong></div>
    <div class="modal-stat"><span>Сильная сторона</span><strong>${escapeHtml(bestMetric.label)}</strong></div>
    <div class="modal-stat"><span>Награда</span><strong>+${lesson.reward.xp} XP</strong></div>
  `;

  const recentUnlocks = playerState.unlocks.slice(-3).map(unlock => {
    const [skill, value] = unlock.split(":");
    const milestone = APP_DATA.skillMilestones.find(item => item.value === Number(value));
    return `<div class="unlock-item">${escapeHtml(SKILLS[skill])}: ${escapeHtml(milestone?.unlock || "новый этап")}</div>`;
  });
  document.getElementById("modal-unlocks").innerHTML = recentUnlocks.join("");

  const dialog = document.getElementById("lesson-dialog");
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  await logEvent("lesson_finish_opened", { lessonId: lesson.id, averageScore: avgScore });
}

function closeLessonDialog(lessonId = activeLesson()?.id) {
  const dialog = document.getElementById("lesson-dialog");
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  logEvent("lesson_finish_closed", { lessonId });
}

async function confirmLessonFinish() {
  const lesson = activeLesson();
  const session = activeSession();
  const button = document.getElementById("confirm-finish");
  if (!session.readyToFinish || session.rewardClaimed || isFinishingLesson) return;

  isFinishingLesson = true;
  button.disabled = true;
  button.classList.add("is-loading");
  button.textContent = "Сохраняем результат…";

  try {
    session.rewardClaimed = true;
    addXp(lesson.reward.xp);
    playerState.coins += lesson.reward.coins;
    playerState.completedLessons += 1;
    updateStreak();

    const completion = {
      lessonId: lesson.id,
      lessonSessionId: session.id,
      averageScore: Math.round(average(session.answers.map(answer => answer.metrics.overall))),
      answersCount: session.answers.length,
      reward: lesson.reward
    };

    const completedLessonId = lesson.id;
    playerState.lessonIndex = (playerState.lessonIndex + 1) % APP_DATA.lessons.length;
    playerState.session = null;
    ensureLessonSession();
    saveCurrentProfile();
    closeLessonDialog(completedLessonId);
    renderEverything();
    await logEvent("lesson_completed", completion);
    toast("Урок завершён", `+${lesson.reward.xp} XP и +${lesson.reward.coins} монет. Следующий сценарий уже открыт.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    console.error("Could not finish lesson", error);
    session.rewardClaimed = false;
    toast("Не удалось завершить урок", "Попробуйте нажать кнопку ещё раз.");
  } finally {
    isFinishingLesson = false;
    button.disabled = false;
    button.classList.remove("is-loading");
    button.textContent = "Получить награду и продолжить";
  }
}

function addXp(amount) {
  playerState.xp += Math.max(0, Number(amount) || 0);
  while (playerState.xp >= playerState.xpNext) {
    playerState.xp -= playerState.xpNext;
    playerState.level += 1;
    playerState.xpNext = Math.round(playerState.xpNext * 1.22);
    toast("Новый уровень", `Теперь у вас ${playerState.level} уровень.`);
    logEvent("level_up", { level: playerState.level, xpNext: playerState.xpNext });
  }
}

function updateStreak() {
  const today = new Date();
  const todayKey = localDateKey(today);
  if (!playerState.lastLessonDate) {
    playerState.streak = 1;
  } else {
    const last = new Date(`${playerState.lastLessonDate}T12:00:00`);
    const difference = Math.round((today.setHours(12,0,0,0) - last.getTime()) / 86400000);
    if (difference === 1) playerState.streak += 1;
    else if (difference > 1) playerState.streak = 1;
  }
  playerState.lastLessonDate = todayKey;
}

async function switchView(view, shouldLog = true) {
  if (!document.getElementById(`${view}-view`)) return;
  currentView = view;
  document.querySelectorAll(".view-panel").forEach(panel => panel.classList.toggle("is-active", panel.id === `${view}-view`));
  document.querySelectorAll("[data-view]").forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (view === "analytics") await renderAnalytics();
  if (view === "admin") await renderAdmin();
  if (shouldLog) await logEvent("view_changed", { view });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function renderAnalytics() {
  const allAnswers = await database.getAll("answers");
  const answers = allAnswers.filter(answer => answer.characterId === currentCharacter.id).sort(byNewest);
  const averages = aggregateMetrics(answers);
  const trend = calculateTrend(answers);

  document.getElementById("analytics-summary").innerHTML = summaryCards([
    ["Ответов", answers.length, "в базе"],
    ["Средний балл", Math.round(averages.overall), "из 100"],
    ["Уроков", playerState.completedLessons, "завершено"],
    ["Серия", playerState.streak, pluralize(playerState.streak, ["день", "дня", "дней"])],
    ["Тренд", trend.label, trend.note]
  ]);

  document.getElementById("analytics-bars").innerHTML = [
    ["Уместность", averages.relevance],
    ["Лексика", averages.vocabulary],
    ["Структура", averages.structure],
    ["Беглость", averages.fluency]
  ].map(([label, value]) => `
    <div class="analytics-bar"><span>${label}</span><div class="analytics-bar-track"><i style="width:${clampScore(value)}%"></i></div><strong>${Math.round(value)}</strong></div>
  `).join("");

  setText("analytics-recommendation", buildAnalyticsRecommendation(answers, averages));

  const table = document.getElementById("answers-table");
  table.innerHTML = answers.length ? answers.slice(0, 12).map(answer => `
    <tr>
      <td>${formatDate(answer.timestamp)}</td>
      <td>${escapeHtml(answer.lessonTitle)}</td>
      <td>${escapeHtml(truncate(answer.text, 90))}</td>
      <td class="score-cell">${answer.metrics.overall}</td>
    </tr>
  `).join("") : `<tr><td colspan="4" class="empty-row">Ответов пока нет. Завершите первую реплику в уроке.</td></tr>`;
}

function calculateTrend(answers) {
  if (answers.length < 4) return { value: 0, label: "—", note: "нужно 4 ответа" };
  const recent = average(answers.slice(0, 3).map(answer => answer.metrics?.overall));
  const previous = average(answers.slice(3, 6).map(answer => answer.metrics?.overall));
  const delta = Math.round(recent - previous);
  if (delta > 0) return { value: delta, label: `+${delta}`, note: "баллов к прошлым ответам" };
  if (delta < 0) return { value: delta, label: String(delta), note: "баллов к прошлым ответам" };
  return { value: 0, label: "0", note: "результат стабилен" };
}

function buildAnalyticsRecommendation(answers, averages) {
  if (!answers.length) return "Ответьте на первую реплику — после этого появится персональный следующий шаг.";
  const labels = {
    relevance: "уместность ответа",
    vocabulary: "лексику",
    structure: "структуру предложений",
    fluency: "беглость текста"
  };
  const tips = {
    relevance: "Используйте одно ключевое слово из задания и отвечайте прямо на вопрос собеседника.",
    vocabulary: "Добавляйте одну новую фразу из подсказок и одну собственную деталь.",
    structure: "Проверяйте наличие глагола, заглавной буквы и финального знака препинания.",
    fluency: "Соединяйте две короткие мысли словами because, but, so или and."
  };
  const [weakest] = Object.entries(averages)
    .filter(([key]) => key !== "overall")
    .sort((a, b) => a[1] - b[1])[0] || ["relevance", 0];
  return `Сейчас лучше всего подтянуть ${labels[weakest]}. ${tips[weakest]}`;
}

async function renderAdmin() {
  const answers = (await database.getAll("answers")).sort(byNewest);
  const events = (await database.getAll("events")).sort(byNewest);
  const profileMap = getProfiles();
  const profiles = Object.values(profileMap);
  const storageLabel = {
    indexeddb: "IndexedDB",
    "local-fallback": "Локально",
    memory: "В памяти"
  }[database.mode] || database.mode;

  document.getElementById("admin-summary").innerHTML = summaryCards([
    ["Профилей", profiles.length, "локально"],
    ["Ответов", answers.length, "в базе"],
    ["Событий", events.length, "в журнале"],
    ["Средний score", Math.round(aggregateMetrics(answers).overall), "все профили"],
    ["Хранилище", storageLabel, `${database.mode} · v${APP_VERSION}`]
  ]);

  document.getElementById("skills-form").innerHTML = Object.entries(SKILLS).map(([key, label]) => `
    <div class="admin-field"><label for="admin-${key}">${label}</label><input id="admin-${key}" name="${key}" type="number" min="0" max="100" value="${Math.round(playerState.skills[key])}"></div>
  `).join("");

  const filter = document.getElementById("event-filter").value;
  const visibleEvents = filter === "all" ? events : events.filter(event => event.eventName === filter);
  document.getElementById("events-table").innerHTML = visibleEvents.length ? visibleEvents.slice(0, 80).map(event => `
    <tr>
      <td>${formatDate(event.timestamp, true)}</td>
      <td><strong>${escapeHtml(event.eventName)}</strong></td>
      <td>${escapeHtml(truncate(JSON.stringify(event.payload || {}), 150))}</td>
    </tr>
  `).join("") : `<tr><td colspan="3" class="empty-row">Событий по этому фильтру нет.</td></tr>`;

  const answerFilter = document.getElementById("answer-profile-filter");
  const selectedFilter = answerFilter.value || "all";
  const availableCharacterIds = [...new Set([
    ...Object.keys(profileMap),
    ...answers.map(answer => answer.characterId).filter(Boolean)
  ])];
  answerFilter.innerHTML = `<option value="all">Все профили</option>${availableCharacterIds.map(id => {
    const character = APP_DATA.characters.find(item => item.id === id);
    return `<option value="${escapeHtml(id)}">${escapeHtml(character?.name || id)}</option>`;
  }).join("")}`;
  answerFilter.value = availableCharacterIds.includes(selectedFilter) ? selectedFilter : "all";
  const visibleAnswers = answerFilter.value === "all" ? answers : answers.filter(answer => answer.characterId === answerFilter.value);
  document.getElementById("admin-answers-table").innerHTML = visibleAnswers.length ? visibleAnswers.slice(0, 100).map(answer => `
    <tr>
      <td>${formatDate(answer.timestamp, true)}</td>
      <td>${escapeHtml(answer.characterName || APP_DATA.characters.find(item => item.id === answer.characterId)?.name || "—")}</td>
      <td>${escapeHtml(answer.lessonTitle || answer.lessonId || "—")}</td>
      <td>${escapeHtml(truncate(answer.text, 120))}</td>
      <td class="score-cell">${Math.round(Number(answer.metrics?.overall) || 0)}</td>
    </tr>
  `).join("") : `<tr><td colspan="5" class="empty-row">Сохранённых ответов пока нет.</td></tr>`;
}

async function saveAdminSkills() {
  const previous = { ...playerState.skills };
  Object.keys(SKILLS).forEach(key => {
    playerState.skills[key] = clamp(Number(document.getElementById(`admin-${key}`).value));
  });
  saveCurrentProfile();
  renderProfile();
  await logEvent("admin_skills_updated", { previous, next: playerState.skills });
  toast("Навыки обновлены", "Новые значения сохранены в профиле.");
}

async function exportDatabase() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: APP_VERSION,
    databaseMode: database.mode,
    profiles: getProfiles(),
    answers: await database.getAll("answers"),
    events: await database.getAll("events")
  };
  downloadBlob(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    `linguapolis-export-${localDateKey(new Date())}.json`
  );
  await logEvent("data_exported", { answers: payload.answers.length, events: payload.events.length });
}

async function exportAnswersCsv() {
  const answers = (await database.getAll("answers")).sort(byNewest);
  const header = ["timestamp", "profile", "lesson", "prompt_index", "answer", "relevance", "vocabulary", "structure", "fluency", "overall"];
  const rows = answers.map(answer => [
    answer.timestamp,
    answer.characterName || answer.characterId,
    answer.lessonTitle || answer.lessonId,
    answer.promptIndex,
    answer.text,
    answer.metrics?.relevance,
    answer.metrics?.vocabulary,
    answer.metrics?.structure,
    answer.metrics?.fluency,
    answer.metrics?.overall
  ]);
  const csv = "\uFEFF" + [header, ...rows].map(row => row.map(csvCell).join(",")).join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `linguapolis-answers-${localDateKey(new Date())}.csv`);
  await logEvent("answers_csv_exported", { answers: answers.length });
}

async function importDatabase(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    if (!payload || typeof payload !== "object" || !payload.profiles || !Array.isArray(payload.answers) || !Array.isArray(payload.events)) {
      throw new Error("Файл не похож на экспорт Linguapolis.");
    }
    if (!confirm("Заменить текущие локальные профили, ответы и журнал данными из файла?")) return;

    await database.clear("answers");
    await database.clear("events");
    const cleanProfiles = sanitizeImportedProfiles(payload.profiles);
    saveProfiles(cleanProfiles);

    for (const answer of payload.answers.slice(0, 10000)) {
      if (!answer || typeof answer !== "object" || !answer.text) continue;
      await database.put("answers", {
        ...answer,
        id: answer.id || (crypto.randomUUID ? crypto.randomUUID() : `answer-${Date.now()}-${Math.random()}`),
        timestamp: validIsoDate(answer.timestamp) ? answer.timestamp : new Date().toISOString(),
        text: String(answer.text).slice(0, 280)
      });
    }
    for (const importedEvent of payload.events.slice(0, 20000)) {
      if (!importedEvent || typeof importedEvent !== "object") continue;
      const { id, ...eventWithoutId } = importedEvent;
      await database.add("events", {
        ...eventWithoutId,
        timestamp: validIsoDate(importedEvent.timestamp) ? importedEvent.timestamp : new Date().toISOString(),
        eventName: String(importedEvent.eventName || "imported_event").slice(0, 80)
      });
    }

    const importedCurrent = cleanProfiles[currentCharacter.id];
    playerState = normalizeProfile(importedCurrent, currentCharacter);
    ensureLessonSession();
    saveCurrentProfile();
    renderEverything();
    await logEvent("data_imported", { answers: payload.answers.length, events: payload.events.length });
    await renderAdmin();
    toast("Импорт завершён", "Профили, ответы и журнал восстановлены.");
  } catch (error) {
    console.error("Import failed", error);
    toast("Не удалось импортировать", error.message || "Проверьте выбранный JSON-файл.");
  }
}

function sanitizeImportedProfiles(profiles) {
  const clean = {};
  if (!profiles || typeof profiles !== "object") return clean;
  Object.entries(profiles).forEach(([characterId, profile]) => {
    const character = APP_DATA.characters.find(item => item.id === characterId);
    if (character) clean[characterId] = normalizeProfile(profile, character);
  });
  return clean;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const string = String(value ?? "");
  return `"${string.replaceAll('"', '""')}"`;
}

async function clearEventLog() {
  if (!confirm("Очистить весь журнал действий? Ответы и прогресс останутся.")) return;
  await database.clear("events");
  await logEvent("event_log_cleared", { initiatedFrom: "admin" });
  await renderAdmin();
  toast("Журнал очищен", "Новая запись об очистке уже добавлена.");
}

async function resetService() {
  if (!confirm("Удалить профили, ответы и журнал действий в этом браузере? Это действие необратимо.")) return;
  await database.clear("answers");
  await database.clear("events");
  safeStorageRemove(KEYS.profiles);
  safeStorageRemove(KEYS.selectedCharacter);
  safeStorageRemove(database.fallbackKey("answers"));
  safeStorageRemove(database.fallbackKey("events"));
  currentCharacter = null;
  playerState = null;
  document.getElementById("app-shell").classList.add("is-hidden");
  document.getElementById("welcome-view").classList.remove("is-hidden");
  renderCharacterGrid();
  toast("Данные удалены", "Сервис возвращён в исходное состояние.");
}

async function logout() {
  flushDraftSave();
  await logEvent("logout", { characterId: currentCharacter?.id });
  safeStorageRemove(KEYS.selectedCharacter);
  currentCharacter = null;
  playerState = null;
  document.getElementById("app-shell").classList.add("is-hidden");
  document.getElementById("welcome-view").classList.remove("is-hidden");
  renderCharacterGrid();
}

async function logEvent(eventName, payload = {}) {
  if (!database) return;
  const event = {
    timestamp: new Date().toISOString(),
    eventName,
    sessionId: SESSION_ID,
    characterId: currentCharacter?.id || null,
    page: currentView,
    payload
  };
  try {
    await database.add("events", event);
  } catch (error) {
    console.warn("Could not write event", eventName, error);
  }
}

function aggregateMetrics(answers) {
  if (!answers.length) return { relevance: 0, vocabulary: 0, structure: 0, fluency: 0, overall: 0 };
  const keys = ["relevance", "vocabulary", "structure", "fluency", "overall"];
  return keys.reduce((result, key) => {
    result[key] = average(answers.map(answer => Number(answer.metrics?.[key] || 0)));
    return result;
  }, {});
}

function bestLessonMetric(answers) {
  const aggregate = aggregateMetrics(answers);
  const labels = { relevance: "Уместность", vocabulary: "Лексика", structure: "Структура", fluency: "Беглость" };
  const [key, value] = Object.entries(aggregate).filter(([name]) => name !== "overall").sort((a, b) => b[1] - a[1])[0] || ["relevance", 0];
  return { key, label: labels[key], value };
}

function summaryCards(items) {
  return items.map(([label, value, note]) => `<div class="summary-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note)}</small></div>`).join("");
}

function averageSkill() {
  return average(Object.values(playerState?.skills || {}));
}

function average(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

function scoreTitle(score) {
  if (score >= 90) return "Очень естественно";
  if (score >= 80) return "Сильный ответ";
  if (score >= 70) return "Хорошая реплика";
  if (score >= 55) return "Понятно, но можно точнее";
  return "Добавьте больше контекста";
}

function toast(title, message) {
  const region = document.getElementById("toast-region");
  const node = document.createElement("div");
  node.className = "toast";
  node.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(message)}`;
  region.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function formatDate(value, includeTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", includeTime
    ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short", year: "numeric" }
  ).format(date);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function byNewest(a, b) {
  return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
}

function truncate(text, length) {
  const string = String(text || "");
  return string.length > length ? `${string.slice(0, length - 1)}…` : string;
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function clamp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function pluralize(number, forms) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeParseJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn("Invalid JSON in local data", error);
    return fallback;
  }
}

function storageAvailable() {
  if (typeof storageAvailable.cached === "boolean") return storageAvailable.cached;
  try {
    const testKey = "__linguapolis_storage_test__";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    storageAvailable.cached = true;
  } catch {
    storageAvailable.cached = false;
  }
  return storageAvailable.cached;
}

function safeStorageGet(key) {
  if (!storageAvailable()) return null;
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn("Could not read local storage", key, error);
    return null;
  }
}

function safeStorageSet(key, value) {
  if (!storageAvailable()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn("Could not write local storage", key, error);
    return false;
  }
}

function safeStorageRemove(key) {
  if (!storageAvailable()) return;
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn("Could not remove local storage", key, error);
  }
}

function validIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function updateConnectionStatus() {
  const node = document.getElementById("connection-status");
  if (!node) return;
  const online = navigator.onLine !== false;
  node.textContent = online ? "Онлайн" : "Офлайн";
  node.classList.toggle("is-offline", !online);
}

function handleFatalError(error) {
  console.error(error);
  const localHint = location.protocol === "file:"
    ? "Проверьте, что рядом с index.html лежат script.js, style.css и data.json."
    : "Обновите страницу. Если ошибка повторяется, проверьте наличие файлов script.js, style.css и data.json в корне сайта.";
  document.body.innerHTML = `
    <main style="max-width:720px;margin:60px auto;padding:24px;font-family:system-ui;color:#171815">
      <p style="font-weight:800;letter-spacing:.08em;font-size:12px">LINGUAPOLIS</p>
      <h1>Не удалось запустить приложение</h1>
      <p>${escapeHtml(error?.message || "Неизвестная ошибка загрузки.")}</p>
      <p>${escapeHtml(localHint)}</p>
      <button id="retry-app" type="button" style="border:0;border-radius:12px;padding:12px 16px;background:#171815;color:white;font-weight:700;cursor:pointer">Повторить загрузку</button>
    </main>`;
  document.getElementById("retry-app")?.addEventListener("click", () => location.reload());
}
