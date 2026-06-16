"use strict";

const DATA_URL = "data.json";
const DB_NAME = "linguapolis_db_v2";
const DB_VERSION = 1;
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

class BrowserDatabase {
  constructor() {
    this.db = null;
    this.mode = "indexeddb";
  }

  async init() {
    if (!("indexedDB" in window)) {
      this.mode = "local-fallback";
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
      });
    } catch (error) {
      console.warn("IndexedDB unavailable, using local fallback", error);
      this.mode = "local-fallback";
    }
  }

  fallbackKey(store) {
    return `linguapolis_db_${store}`;
  }

  async add(store, value) {
    if (this.mode === "local-fallback") {
      const rows = JSON.parse(localStorage.getItem(this.fallbackKey(store)) || "[]");
      rows.push({ ...value, id: value.id || `${store}-${Date.now()}-${Math.random()}` });
      localStorage.setItem(this.fallbackKey(store), JSON.stringify(rows));
      return;
    }
    return this.run(store, "readwrite", objectStore => objectStore.add(value));
  }

  async put(store, value) {
    if (this.mode === "local-fallback") {
      const rows = JSON.parse(localStorage.getItem(this.fallbackKey(store)) || "[]");
      const index = rows.findIndex(row => row.id === value.id);
      if (index >= 0) rows[index] = value;
      else rows.push(value);
      localStorage.setItem(this.fallbackKey(store), JSON.stringify(rows));
      return;
    }
    return this.run(store, "readwrite", objectStore => objectStore.put(value));
  }

  async getAll(store) {
    if (this.mode === "local-fallback") {
      return JSON.parse(localStorage.getItem(this.fallbackKey(store)) || "[]");
    }
    return this.run(store, "readonly", objectStore => objectStore.getAll());
  }

  async clear(store) {
    if (this.mode === "local-fallback") {
      localStorage.removeItem(this.fallbackKey(store));
      return;
    }
    return this.run(store, "readwrite", objectStore => objectStore.clear());
  }

  async run(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }
}

document.addEventListener("DOMContentLoaded", () => boot().catch(handleFatalError));

async function boot() {
  database = new BrowserDatabase();
  await database.init();
  APP_DATA = await loadJson(DATA_URL);
  bindGlobalEvents();
  renderCharacterGrid();

  const selectedId = localStorage.getItem(KEYS.selectedCharacter);
  if (selectedId) {
    const character = APP_DATA.characters.find(item => item.id === selectedId);
    if (character) await enterProfile(character, true);
  }

  await logEvent("app_boot", { databaseMode: database.mode });
}

async function loadJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Не удалось загрузить ${url}: ${response.status}`);
  return response.json();
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

  const answerInput = document.getElementById("answer-input");
  answerInput.addEventListener("input", () => {
    document.getElementById("answer-counter").textContent = `${answerInput.value.length} / 280`;
    if (!answerDraftStarted && answerInput.value.trim()) {
      answerDraftStarted = true;
      logEvent("answer_started", { lessonId: activeLesson()?.id, promptIndex: activeSession()?.promptIndex });
    }
  });
  answerInput.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") submitAnswer();
  });

  document.getElementById("submit-answer").addEventListener("click", submitAnswer);
  document.getElementById("next-dialogue").addEventListener("click", continueDialogue);
  document.getElementById("finish-lesson").addEventListener("click", openLessonSummary);
  document.getElementById("confirm-finish").addEventListener("click", confirmLessonFinish);
  document.getElementById("save-skills").addEventListener("click", saveAdminSkills);
  document.getElementById("export-data").addEventListener("click", exportDatabase);
  document.getElementById("clear-events").addEventListener("click", clearEventLog);
  document.getElementById("reset-service").addEventListener("click", resetService);
  document.getElementById("event-filter").addEventListener("change", renderAdmin);
}

function getProfiles() {
  try {
    return JSON.parse(localStorage.getItem(KEYS.profiles) || "{}");
  } catch {
    return {};
  }
}

function saveProfiles(profiles) {
  localStorage.setItem(KEYS.profiles, JSON.stringify(profiles));
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
  playerState = profiles[character.id] || createProfile(character);
  ensureLessonSession();
  localStorage.setItem(KEYS.selectedCharacter, character.id);
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
      startedAt: new Date().toISOString()
    };
  }
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
    ? `<strong>${escapeHtml(stage.current.label)} · ${Math.round(average)}%</strong>На ${stage.next.value}% откроется: ${escapeHtml(stage.next.unlock)}.`
    : `<strong>Mastery · 100%</strong>Все режимы открыты. Дальше растёт качество и стабильность ответов.`;
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

  if (session.promptIndex >= lesson.prompts.length) {
    setText("prompt-task", "Диалог завершён — можно подвести итог.");
    chunks.innerHTML = "";
    input.value = "";
    input.disabled = true;
    submit.disabled = true;
    setText("answer-counter", "0 / 280");
    return;
  }

  const prompt = lesson.prompts[session.promptIndex];
  setText("prompt-task", prompt.task);
  chunks.innerHTML = prompt.targetChunks.map(chunk => `<span class="chunk">${escapeHtml(chunk)}</span>`).join("");
  input.disabled = session.awaitingNext;
  submit.disabled = session.awaitingNext;
  if (!session.awaitingNext) {
    input.value = "";
    setText("answer-counter", "0 / 280");
  }
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

async function submitAnswer() {
  const lesson = activeLesson();
  const session = activeSession();
  const input = document.getElementById("answer-input");
  const text = input.value.trim();
  if (!lesson || !session || session.awaitingNext || session.readyToFinish) return;
  if (text.length < 3) {
    toast("Ответ слишком короткий", "Напишите хотя бы несколько слов на английском.");
    input.focus();
    return;
  }

  const prompt = lesson.prompts[session.promptIndex];
  const metrics = evaluateAnswer(text, prompt);
  const feedback = buildFeedback(metrics);
  const gains = calculateSkillGains(metrics);
  const crossedUnlocks = applySkillGains(gains);
  addXp(Math.max(8, Math.round(metrics.overall / 8)));
  playerState.coins += metrics.targetUsed ? 4 : 2;

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

  await database.put("answers", record);
  session.answers.push(record);
  session.awaitingNext = true;
  answerDraftStarted = false;
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

  if (crossedUnlocks.length) {
    crossedUnlocks.forEach(unlock => toast("Новый этап навыка", unlock));
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
  const commonVerbs = ["am", "is", "are", "was", "were", "have", "has", "do", "did", "like", "love", "think", "need", "want", "moved", "finished", "suggest", "looking", "appreciate"];
  const hasVerb = commonVerbs.some(word => words.includes(word)) || /\b\w+(ed|ing)\b/.test(lower);
  const startsUppercase = /^[A-Z]/.test(clean);
  const endsPunctuation = /[.!?]$/.test(clean);
  const duplicatePenalty = /(\b[a-z]+\b)(?:\s+\1){1,}/i.test(clean) ? 12 : 0;
  const wordCount = words.length;
  const uniqueRatio = wordCount ? uniqueWords.size / wordCount : 0;
  const averageWordLength = wordCount ? words.reduce((sum, word) => sum + word.length, 0) / wordCount : 0;

  const relevance = clampScore(
    35 + keywordHits * 14 + targetHits * 13 + Math.min(18, wordCount * 1.2) - (keywordHits === 0 && targetHits === 0 ? 10 : 0)
  );
  const vocabulary = clampScore(
    28 + uniqueRatio * 35 + Math.min(16, Math.max(0, averageWordLength - 3) * 5) + targetHits * 10 + connectorHits * 4
  );
  const structure = clampScore(
    30 + (startsUppercase ? 12 : 0) + (endsPunctuation ? 12 : 0) + (hasVerb ? 24 : 0) + (wordCount >= 6 ? 14 : wordCount * 2) + (connectorHits ? 8 : 0)
  );
  const idealLengthScore = wordCount >= 8 && wordCount <= 28 ? 38 : Math.max(8, 38 - Math.abs(14 - wordCount) * 2);
  const fluency = clampScore(35 + idealLengthScore + connectorHits * 7 - duplicatePenalty);
  const overall = clampScore(relevance * .31 + vocabulary * .23 + structure * .24 + fluency * .22);

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
  return {
    confidence: Math.max(1, Math.round(metrics.overall / 34)),
    vocabulary: Math.max(1, Math.round(metrics.vocabulary / 38)),
    fluency: Math.max(1, Math.round(metrics.fluency / 38)),
    accuracy: Math.max(1, Math.round(metrics.structure / 40))
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
  } else {
    session.promptIndex = lesson.prompts.length;
    session.readyToFinish = true;
  }
  saveCurrentProfile();
  renderLesson();
  document.getElementById("answer-input").focus();
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
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  await logEvent("lesson_finish_opened", { lessonId: lesson.id, averageScore: avgScore });
}

function closeLessonDialog() {
  const dialog = document.getElementById("lesson-dialog");
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  logEvent("lesson_finish_closed", { lessonId: activeLesson()?.id });
}

async function confirmLessonFinish() {
  const lesson = activeLesson();
  const session = activeSession();
  if (!session.readyToFinish || session.rewardClaimed) return;

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

  playerState.lessonIndex = (playerState.lessonIndex + 1) % APP_DATA.lessons.length;
  playerState.session = null;
  ensureLessonSession();
  saveCurrentProfile();
  closeLessonDialog();
  renderEverything();
  await logEvent("lesson_completed", completion);
  toast("Урок завершён", `+${lesson.reward.xp} XP и +${lesson.reward.coins} монет. Следующий сценарий уже открыт.`);
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
  currentView = view;
  document.querySelectorAll(".view-panel").forEach(panel => panel.classList.toggle("is-active", panel.id === `${view}-view`));
  document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("is-active", button.dataset.view === view));
  if (view === "analytics") await renderAnalytics();
  if (view === "admin") await renderAdmin();
  if (shouldLog) await logEvent("view_changed", { view });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function renderAnalytics() {
  const allAnswers = await database.getAll("answers");
  const answers = allAnswers.filter(answer => answer.characterId === currentCharacter.id).sort(byNewest);
  const averages = aggregateMetrics(answers);

  document.getElementById("analytics-summary").innerHTML = summaryCards([
    ["Ответов", answers.length, "в базе"],
    ["Средний балл", Math.round(averages.overall), "из 100"],
    ["Уроков", playerState.completedLessons, "завершено"],
    ["Серия", playerState.streak, pluralize(playerState.streak, ["день", "дня", "дней"])]
  ]);

  document.getElementById("analytics-bars").innerHTML = [
    ["Уместность", averages.relevance],
    ["Лексика", averages.vocabulary],
    ["Структура", averages.structure],
    ["Беглость", averages.fluency]
  ].map(([label, value]) => `
    <div class="analytics-bar"><span>${label}</span><div class="analytics-bar-track"><i style="width:${value}%"></i></div><strong>${Math.round(value)}</strong></div>
  `).join("");

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

async function renderAdmin() {
  const answers = (await database.getAll("answers")).sort(byNewest);
  const events = (await database.getAll("events")).sort(byNewest);
  const profiles = Object.values(getProfiles());

  document.getElementById("admin-summary").innerHTML = summaryCards([
    ["Профилей", profiles.length, "локально"],
    ["Ответов", answers.length, "в базе"],
    ["Событий", events.length, "в журнале"],
    ["Средний score", Math.round(aggregateMetrics(answers).overall), "все профили"]
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
    version: 2,
    databaseMode: database.mode,
    profiles: getProfiles(),
    answers: await database.getAll("answers"),
    events: await database.getAll("events")
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `linguapolis-export-${localDateKey(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(url);
  await logEvent("data_exported", { answers: payload.answers.length, events: payload.events.length });
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
  localStorage.removeItem(KEYS.profiles);
  localStorage.removeItem(KEYS.selectedCharacter);
  localStorage.removeItem(database.fallbackKey("answers"));
  localStorage.removeItem(database.fallbackKey("events"));
  currentCharacter = null;
  playerState = null;
  document.getElementById("app-shell").classList.add("is-hidden");
  document.getElementById("welcome-view").classList.remove("is-hidden");
  renderCharacterGrid();
  toast("Данные удалены", "Сервис возвращён в исходное состояние.");
}

async function logout() {
  await logEvent("logout", { characterId: currentCharacter?.id });
  localStorage.removeItem(KEYS.selectedCharacter);
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

function handleFatalError(error) {
  console.error(error);
  document.body.innerHTML = `<main style="max-width:720px;margin:60px auto;padding:24px;font-family:system-ui"><h1>Не удалось запустить Linguapolis</h1><p>${escapeHtml(error.message)}</p><p>Запустите проект через локальный HTTP-сервер, например <code>python -m http.server 8000</code>.</p></main>`;
}
