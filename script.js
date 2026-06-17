"use strict";
window.__LINGUAPOLIS_READY__ = false;
window.addEventListener("unhandledrejection", event => console.error("Unhandled Linguapolis error", event.reason));
const { AuthService, AUTH_EVENT } = (() => {
const DEFAULT_CONFIG = { url: "", publishableKey: "", teacherEmails: [] };
let SUPABASE_CONFIG = DEFAULT_CONFIG;
let supabaseConfigLoaded = false;

const AUTH_EVENT = "linguapolis:auth-changed";
let supabaseClient = null;
let authMode = "demo";
let currentStudent = null;
let unsubscribe = null;

function hasSupabaseConfig() {
  return Boolean(
    SUPABASE_CONFIG?.url?.startsWith("https://") &&
    SUPABASE_CONFIG?.publishableKey &&
    !SUPABASE_CONFIG.publishableKey.includes("PASTE")
  );
}

function teacherEmails() {
  return (SUPABASE_CONFIG.teacherEmails || [])
    .map(email => String(email || "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizeUser(user) {
  if (!user) return null;
  const email = String(user.email || "").toLowerCase();
  const metadata = user.user_metadata || {};
  return {
    id: user.id,
    email,
    name: metadata.full_name || metadata.name || email.split("@")[0] || "Студент",
    classCode: metadata.class_code || "",
    avatarId: metadata.avatar_id || "nova",
    role: teacherEmails().includes(email) ? "teacher" : "student",
    isGuest: false
  };
}

function demoStudent() {
  return {
    id: "guest",
    email: "",
    name: "Демо-студент",
    classCode: "",
    avatarId: "nova",
    role: "student",
    isGuest: true
  };
}

function emitAuthChange(student = currentStudent) {
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { student, mode: authMode } }));
}

const AuthService = {
  async init() {
    if (!supabaseConfigLoaded) {
      supabaseConfigLoaded = true;
      try {
        const module = await import("./config.js?v=7.3");
        SUPABASE_CONFIG = module.SUPABASE_CONFIG || DEFAULT_CONFIG;
      } catch (error) {
        console.info("Supabase config is not present; demo mode is available.");
        SUPABASE_CONFIG = DEFAULT_CONFIG;
      }
    }
    if (!hasSupabaseConfig()) {
      authMode = "demo";
      currentStudent = null;
      return { configured: false, student: null, mode: authMode };
    }

    try {
      const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
      supabaseClient = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
      authMode = "supabase";
      const { data, error } = await supabaseClient.auth.getSession();
      if (error) throw error;
      currentStudent = normalizeUser(data.session?.user || null);

      const listener = supabaseClient.auth.onAuthStateChange((_event, session) => {
        currentStudent = normalizeUser(session?.user || null);
        emitAuthChange();
      });
      unsubscribe = listener.data.subscription;
      return { configured: true, student: currentStudent, mode: authMode };
    } catch (error) {
      console.error("Supabase auth initialization failed", error);
      authMode = "unavailable";
      currentStudent = null;
      return { configured: true, student: null, mode: authMode, error };
    }
  },

  isConfigured() {
    return hasSupabaseConfig();
  },

  getMode() {
    return authMode;
  },

  getStudent() {
    return currentStudent;
  },

  isTeacher() {
    return currentStudent?.role === "teacher";
  },

  async signUp({ name, email, password, classCode, avatarId = "nova" }) {
    if (!supabaseClient) throw new Error("Регистрация ещё не подключена. Сначала настройте Supabase.");
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { data, error } = await supabaseClient.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: redirectTo,
        data: {
          full_name: name.trim(),
          class_code: classCode.trim(),
          avatar_id: avatarId
        }
      }
    });
    if (error) throw error;
    currentStudent = normalizeUser(data.user || data.session?.user || null);
    return {
      student: currentStudent,
      needsEmailConfirmation: Boolean(data.user && !data.session)
    };
  },

  async signIn({ email, password }) {
    if (!supabaseClient) throw new Error("Вход ещё не подключён. Сначала настройте Supabase.");
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email.trim(),
      password
    });
    if (error) throw error;
    currentStudent = normalizeUser(data.user || data.session?.user || null);
    emitAuthChange();
    return currentStudent;
  },

  continueAsGuest() {
    authMode = "demo";
    currentStudent = demoStudent();
    emitAuthChange();
    return currentStudent;
  },


  async updateProfile({ name, avatarId } = {}) {
    const nextName = String(name || currentStudent?.name || "Студент").trim();
    const nextAvatar = String(avatarId || currentStudent?.avatarId || "nova").trim();
    if (supabaseClient && currentStudent && !currentStudent.isGuest) {
      const { data, error } = await supabaseClient.auth.updateUser({
        data: { full_name: nextName, avatar_id: nextAvatar }
      });
      if (error) throw error;
      currentStudent = normalizeUser(data.user);
    } else if (currentStudent) {
      currentStudent = { ...currentStudent, name: nextName, avatarId: nextAvatar };
    }
    emitAuthChange();
    return currentStudent;
  },

  async signOut() {
    if (supabaseClient && currentStudent && !currentStudent.isGuest) {
      const { error } = await supabaseClient.auth.signOut();
      if (error) throw error;
    }
    currentStudent = null;
    emitAuthChange();
  },

  destroy() {
    unsubscribe?.unsubscribe?.();
    unsubscribe = null;
  }
};



return { AuthService, AUTH_EVENT };
})();

"use strict";

const DATA_URL = "data.json";
const DB_NAME = "linguapolis_db_v2";
const DB_VERSION = 1;
const APP_VERSION = "7.3";
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`;

const KEYS = {
  profiles: "linguapolis_profiles_v2",
  selectedCharacter: "linguapolis_selected_character_v2",
  studentSettings: "linguapolis_student_settings_v1"
};

const SKILLS = {
  confidence: "Уверенность",
  vocabulary: "Лексика",
  fluency: "Беглость",
  accuracy: "Точность"
};

const ACCENTS = {
  violet: ["#7357ff", "#e7e0ff"],
  blue: ["#198fd0", "#d9f2ff"],
  sand: ["#c7852b", "#fff0cf"],
  green: ["#2d9a68", "#d9f7e9"],
  rose: ["#c45b8d", "#ffe3ef"],
  orange: ["#ea7a2f", "#ffe2cd"]
};

const AVATARS = [
  { id: "nova", name: "Nova", src: "assets/avatars-realistic/nova.webp" },
  { id: "lumi", name: "Lumi", src: "assets/avatars-realistic/lumi.webp" },
  { id: "sage", name: "Sage", src: "assets/avatars-realistic/sage.webp" },
  { id: "milo", name: "Milo", src: "assets/avatars-realistic/milo.webp" },
  { id: "aria", name: "Aria", src: "assets/avatars-realistic/aria.webp" },
  { id: "kai", name: "Kai", src: "assets/avatars-realistic/kai.webp" },
  { id: "sol", name: "Sol", src: "assets/avatars-realistic/sol.webp" },
  { id: "rio", name: "Rio", src: "assets/avatars-realistic/rio.webp" },
  { id: "ivy", name: "Ivy", src: "assets/avatars-realistic/ivy.webp" },
  { id: "atlas", name: "Atlas", src: "assets/avatars-realistic/atlas.webp" }
];

const ACHIEVEMENTS = [
  { id: "first_words", icon: "💬", title: "First Words", description: "Отправить первый ответ", test: state => state.totalAnswers >= 1 },
  { id: "strong_reply", icon: "✨", title: "Strong Reply", description: "Получить 85+ за ответ", test: state => state.bestScore >= 85 },
  { id: "near_native", icon: "🌟", title: "Near Native", description: "Получить 95+ за ответ", test: state => state.bestScore >= 95 },
  { id: "first_story", icon: "🏁", title: "Story Complete", description: "Завершить первый урок", test: state => state.completedLessons >= 1 },
  { id: "streak_three", icon: "⚡", title: "On a Roll", description: "Серия 3 дня", test: state => state.streak >= 3 },
  { id: "level_three", icon: "💎", title: "Growing Star", description: "Достичь 3 уровня", test: state => state.level >= 3 },
  { id: "explorer", icon: "🗺️", title: "City Explorer", description: "Открыть 4 локации", test: state => state.unlockedLessonCount >= 4 },
  { id: "collector", icon: "◆", title: "Collector", description: "Накопить 250 монет", test: state => state.coins >= 250 }
];

const DAILY_QUESTS = [
  { id: "answers", icon: "💬", title: "Три реплики", target: 3, value: daily => daily.answers },
  { id: "quality", icon: "✨", title: "Ответ на 75+", target: 1, value: daily => daily.goodAnswers },
  { id: "lesson", icon: "🏁", title: "Завершить урок", target: 1, value: daily => daily.lessons }
];

const LESSON_ICONS = ["🏡", "💼", "✈️", "☕", "🤝", "🏨"];
const DAILY_REWARD = { xp: 35, coins: 30 };

let APP_DATA = null;
let database = null;
let currentStudent = null;
let currentCharacter = null;
let playerState = null;
let currentView = "lesson";
let answerDraftStarted = false;
let isSubmittingAnswer = false;
let isFinishingLesson = false;
let draftSaveTimer = null;
let pendingAvatarId = "nova";
let deferredInstallPrompt = null;

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

function startLinguapolisApp() {
  return boot().catch(handleFatalError);
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startLinguapolisApp, { once: true });
} else {
  startLinguapolisApp();
}

async function boot() {
  // Bind the authentication controls first so tabs and demo mode remain usable
  // even when an optional resource fails to load.
  bindGlobalEvents();
  setupInstallExperience();
  updateConnectionStatus();

  database = new BrowserDatabase();
  await database.init();
  APP_DATA = await loadAppData();
  validateAppData(APP_DATA);
  renderCharacterGrid();
  renderAvatarPickers();
  registerServiceWorker();

  const authState = await AuthService.init();
  renderAuthAvailability(authState);
  if (authState.student) {
    await startStudentSession(authState.student, true);
  } else {
    showAuthView();
  }

  window.__LINGUAPOLIS_READY__ = true;
  if (window.__LINGUAPOLIS_PENDING_GUEST__) {
    window.__LINGUAPOLIS_PENDING_GUEST__ = false;
    await window.LinguapolisStartGuest();
  }

  await logEvent("app_boot", {
    databaseMode: database.mode,
    appVersion: APP_VERSION,
    authMode: authState.mode
  });
}



function setupInstallExperience() {
  const installButton = document.getElementById("install-app");
  if (!installButton) return;

  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    installButton.classList.remove("is-hidden");
  });

  installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      showToast("На iPhone: Поделиться → На экран Домой. На Android откройте меню браузера → Установить приложение.");
      return;
    }
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.classList.add("is-hidden");
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    installButton.classList.add("is-hidden");
    showToast("Linguapolis установлен на устройство");
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

function renderAuthAvailability(authState) {
  const note = document.getElementById("auth-config-note");
  const guestButton = document.getElementById("guest-login");
  if (!note || !guestButton) return;

  if (!authState.configured) {
    note.textContent = "Регистрация пока работает только после подключения Supabase. До этого можно открыть демо-режим.";
    guestButton.textContent = "Продолжить в демо-режиме";
    return;
  }

  if (authState.mode === "unavailable") {
    note.textContent = "Сервис регистрации временно недоступен. Проверьте интернет или настройки Supabase.";
    guestButton.textContent = "Открыть демо без аккаунта";
    return;
  }

  note.textContent = "После регистрации на почту может прийти письмо для подтверждения аккаунта.";
  guestButton.textContent = "Открыть демо без аккаунта";
}

function showAuthView(message = "") {
  currentStudent = null;
  currentCharacter = null;
  playerState = null;
  document.getElementById("auth-view")?.classList.remove("is-hidden");
  document.getElementById("welcome-view")?.classList.add("is-hidden");
  document.getElementById("app-shell")?.classList.add("is-hidden");
  setAuthMessage(message, message ? "info" : "");
}

async function startStudentSession(student, restored = false) {
  if (!student) return showAuthView();
  currentStudent = hydrateStudentSettings(student);
  updateStudentUi();
  document.getElementById("auth-view")?.classList.add("is-hidden");
  document.getElementById("welcome-view")?.classList.remove("is-hidden");
  document.getElementById("app-shell")?.classList.add("is-hidden");
  renderCharacterGrid();

  let selectedId = safeStorageGet(scopedKey(KEYS.selectedCharacter));
  if (!selectedId && currentStudent?.isGuest) {
    selectedId = safeStorageGet(KEYS.selectedCharacter);
    if (selectedId) safeStorageSet(scopedKey(KEYS.selectedCharacter), selectedId);
  }
  if (selectedId) {
    const character = APP_DATA.characters.find(item => item.id === selectedId);
    if (character) await enterProfile(character, restored);
  }
}

function updateStudentUi() {
  const student = currentStudent;
  const name = student?.name || "Студент";
  const avatar = avatarById(student?.avatarId);
  setText("student-name", name);
  const topAvatar = document.getElementById("student-avatar");
  if (topAvatar) {
    topAvatar.src = avatar.src;
    topAvatar.alt = `Аватар ${name}`;
  }
  setText("student-mood-top", playerState ? getPlayerMood().label : "Готов к игре");

  const adminButton = document.getElementById("admin-nav-button");
  if (adminButton) adminButton.classList.toggle("is-hidden", !canAccessAdmin());
}

function canAccessAdmin() {
  return Boolean(currentStudent?.role === "teacher" || currentStudent?.isGuest);
}

function scopedKey(baseKey) {
  const scope = currentStudent?.id || "guest";
  return `${baseKey}:${scope}`;
}

function currentStudentId() {
  return currentStudent?.id || "guest";
}

function recordBelongsToCurrentStudent(record) {
  return (record?.studentId || "guest") === currentStudentId();
}

function setAuthTab(tab) {
  const selected = tab === "register" ? "register" : "login";
  document.querySelectorAll("[data-auth-tab]").forEach(button => {
    const active = button.dataset.authTab === selected;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".auth-panel").forEach(panel => {
    panel.classList.toggle("is-active", panel.id === `auth-${selected}-panel`);
  });
  setAuthMessage("");
}

function setAuthMessage(message, type = "info") {
  const node = document.getElementById("auth-message");
  if (!node) return;
  node.textContent = message;
  node.className = `auth-message${message ? ` is-${type}` : ""}`;
}

function setAuthFormBusy(form, busy, label) {
  const button = form?.querySelector("button[type='submit']");
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.innerHTML;
  button.disabled = busy;
  button.classList.toggle("is-loading", busy);
  button.innerHTML = busy ? label : button.dataset.defaultLabel;
}

async function handleLogin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  setAuthFormBusy(form, true, "Входим…");
  setAuthMessage("");
  try {
    const student = await AuthService.signIn({ email, password });
    await startStudentSession(student);
    await logEvent("student_signed_in", { authMode: AuthService.getMode() });
  } catch (error) {
    console.error("Login failed", error);
    setAuthMessage(humanizeAuthError(error), "error");
  } finally {
    setAuthFormBusy(form, false, "");
  }
}

async function handleRegistration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const name = document.getElementById("register-name").value.trim();
  const email = document.getElementById("register-email").value.trim();
  const password = document.getElementById("register-password").value;
  const classCode = document.getElementById("register-class-code").value.trim();
  const avatarId = document.getElementById("register-avatar").value || "nova";

  if (name.length < 2) {
    setAuthMessage("Укажите имя минимум из двух символов.", "error");
    return;
  }

  setAuthFormBusy(form, true, "Создаём аккаунт…");
  setAuthMessage("");
  try {
    const result = await AuthService.signUp({ name, email, password, classCode, avatarId });
    if (result.needsEmailConfirmation) {
      setAuthTab("login");
      document.getElementById("login-email").value = email;
      setAuthMessage("Аккаунт создан. Откройте письмо от Linguapolis, подтвердите email и затем войдите.", "success");
    } else if (result.student) {
      await startStudentSession(result.student);
      await logEvent("student_registered", { classCode: classCode || null });
    }
  } catch (error) {
    console.error("Registration failed", error);
    setAuthMessage(humanizeAuthError(error), "error");
  } finally {
    setAuthFormBusy(form, false, "");
  }
}

function humanizeAuthError(error) {
  const message = String(error?.message || "Не удалось выполнить действие.");
  if (/invalid login credentials/i.test(message)) return "Неверный email или пароль.";
  if (/email not confirmed/i.test(message)) return "Сначала подтвердите email по ссылке из письма.";
  if (/already registered|already exists/i.test(message)) return "Аккаунт с таким email уже существует. Попробуйте войти.";
  if (/password/i.test(message) && /6/i.test(message)) return "Пароль должен содержать минимум 6 символов.";
  if (/rate limit/i.test(message)) return "Слишком много попыток. Подождите немного и попробуйте снова.";
  return message;
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

async function startGuestSafely() {
  if (!APP_DATA) {
    window.__LINGUAPOLIS_PENDING_GUEST__ = true;
    setAuthMessage("Загружаем игру…", "info");
    return;
  }
  try {
    const student = AuthService.continueAsGuest();
    await startStudentSession(student);
    await logEvent("guest_session_started", {});
  } catch (error) {
    console.error("Guest session failed", error);
    setAuthMessage("Не удалось открыть демо. Обновите страницу и попробуйте снова.", "error");
  }
}
window.LinguapolisStartGuest = startGuestSafely;

function bindGlobalEvents() {
  document.querySelectorAll("[data-auth-tab]").forEach(button => {
    button.addEventListener("click", () => setAuthTab(button.dataset.authTab));
  });
  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("register-form")?.addEventListener("submit", handleRegistration);
  window.addEventListener(AUTH_EVENT, event => {
    const student = event.detail?.student || null;
    if (student && currentStudent?.id !== student.id) startStudentSession(student, true);
    if (!student && currentStudent) showAuthView();
  });

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
  document.querySelectorAll("[data-action='edit-avatar']").forEach(button => button.addEventListener("click", openAvatarDialog));
  document.querySelectorAll("[data-action='close-avatar-modal']").forEach(button => button.addEventListener("click", closeAvatarDialog));
  document.getElementById("save-avatar")?.addEventListener("click", saveSelectedAvatar);

  document.addEventListener("click", event => {
    const chunk = event.target.closest("[data-chunk]");
    if (chunk) insertHint(chunk.dataset.chunk);
    const avatarChoice = event.target.closest("[data-avatar-id]");
    if (avatarChoice) selectAvatarChoice(avatarChoice);
    const lessonChoice = event.target.closest("[data-lesson-index]");
    if (lessonChoice && !lessonChoice.disabled) selectLesson(Number(lessonChoice.dataset.lessonIndex));
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
  const scoped = safeStorageGet(scopedKey(KEYS.profiles));
  if (scoped) return safeParseJson(scoped, {});

  if (currentStudent?.isGuest) {
    const legacy = safeStorageGet(KEYS.profiles);
    if (legacy) {
      safeStorageSet(scopedKey(KEYS.profiles), legacy);
      return safeParseJson(legacy, {});
    }
  }
  return {};
}

function saveProfiles(profiles) {
  safeStorageSet(scopedKey(KEYS.profiles), JSON.stringify(profiles));
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
    unlockedLessonCount: 1,
    lessonCompletions: {},
    totalAnswers: 0,
    bestScore: 0,
    streak: 0,
    lastLessonDate: null,
    achievements: [],
    daily: createDailyState(),
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
    unlockedLessonCount: Math.max(1, Math.min(APP_DATA.lessons.length, Number(source.unlockedLessonCount) || Math.min(APP_DATA.lessons.length, (Number(source.completedLessons) || 0) + 1))),
    lessonCompletions: source.lessonCompletions && typeof source.lessonCompletions === "object" ? source.lessonCompletions : {},
    totalAnswers: Math.max(0, Number(source.totalAnswers) || 0),
    bestScore: clampScore(source.bestScore),
    streak: Math.max(0, Number(source.streak) || 0),
    achievements: Array.isArray(source.achievements) ? [...new Set(source.achievements.filter(Boolean))] : [],
    daily: normalizeDailyState(source.daily),
    skills: Object.keys(SKILLS).reduce((result, key) => {
      result[key] = clamp(source.skills?.[key] ?? base.skills[key]);
      return result;
    }, {}),
    unlocks: Array.isArray(source.unlocks) ? [...new Set(source.unlocks.filter(Boolean))] : [],
    session: source.session && typeof source.session === "object" ? source.session : null
  };
}


function characterIconSvg(iconId = "studio") {
  const commonStart = '<svg class="avatar-svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false">';
  const commonEnd = '</svg>';
  const icons = {
    studio: '<path fill="currentColor" d="M18 53c1-11 7-17 14-17s13 6 14 17H18Z"/><circle cx="32" cy="24" r="10" fill="currentColor"/><path d="M21 23c1-10 7-15 15-13 6 1 9 7 8 13-5-4-16-4-23 0Z" fill="currentColor"/><path d="M24 15c-4 1-7-1-8-4 5-2 9-1 12 2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    product: '<path fill="currentColor" d="M17 54c1-11 7-18 15-18s14 7 15 18H17Z"/><circle cx="32" cy="23" r="10" fill="currentColor"/><path d="M21 21c1-8 5-12 12-12 7 0 11 4 12 11-7-2-15-1-24 1Z" fill="currentColor"/><path d="M22 24h8m4 0h8m-12 0h4" fill="none" stroke="var(--character-color)" stroke-width="2.2" stroke-linecap="round"/>',
    global: '<path d="M18 54c1-11 7-18 14-18s13 7 14 18H18Z" fill="currentColor"/><circle cx="32" cy="24" r="9" fill="currentColor"/><path d="M19 30c-2-12 3-22 13-22s15 10 13 22c-3-8-6-13-13-13s-10 5-13 13Z" fill="currentColor"/><path d="M20 31c4 7 20 7 24 0" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
    travel: '<path fill="currentColor" d="M17 54c1-11 7-18 15-18s14 7 15 18H17Z"/><circle cx="32" cy="24" r="10" fill="currentColor"/><path d="M20 20c2-8 7-12 14-11 5 1 9 5 10 10-8-2-16-2-24 1Z" fill="currentColor"/><path d="M19 18h26" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M40 18c5 0 8 1 10 4-4 1-8 0-12-2" fill="currentColor"/>',
    academic: '<path fill="currentColor" d="M17 54c1-11 7-18 15-18s14 7 15 18H17Z"/><circle cx="32" cy="24" r="10" fill="currentColor"/><circle cx="32" cy="10" r="6" fill="currentColor"/><path d="M21 22c1-8 5-12 11-12 7 0 11 4 12 12-7-3-15-3-23 0Z" fill="currentColor"/><path d="M22 25h8m4 0h8m-12 0h4" fill="none" stroke="var(--character-color)" stroke-width="2.2" stroke-linecap="round"/>',
    founder: '<path fill="currentColor" d="M16 54c2-12 8-18 16-18s14 6 16 18H16Z"/><circle cx="32" cy="23" r="10" fill="currentColor"/><path d="M21 21c2-9 7-13 14-12 5 1 8 4 10 10-8-2-16-1-24 2Z" fill="currentColor"/><path d="m25 39 7 7 7-7" fill="none" stroke="var(--character-color)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  return commonStart + (icons[iconId] || icons.studio) + commonEnd;
}

function npcIconSvg(name = "") {
  const variants = ["product", "travel", "founder", "studio", "academic", "global"];
  const hash = [...String(name)].reduce((total, char) => total + char.charCodeAt(0), 0);
  return characterIconSvg(variants[hash % variants.length]);
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
      <span class="character-avatar" aria-hidden="true"><img src="${characterPortraitSrc(character)}" alt=""></span>
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
  safeStorageSet(scopedKey(KEYS.selectedCharacter), character.id);
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
  ensureDailyState();
  renderProfile();
  renderLesson();
  renderDailyQuests();
  renderAchievements();
  renderLessonMap();
  updateStudentUi();
}

function renderProfile() {
  const average = averageSkill();
  const mood = getPlayerMood();
  setText("profile-name", currentStudent?.name || "Студент");
  setText("profile-description", `${mood.emoji} ${mood.label} · ${currentCharacter.role}`);
  setText("profile-mood", mood.label);
  setText("profile-level", playerState.level);
  setText("top-level", playerState.level);
  setText("profile-coins", playerState.coins);
  setText("top-coins", playerState.coins);
  setText("profile-streak", playerState.streak);
  setText("top-streak", playerState.streak);
  setText("xp-label", `${playerState.xp} / ${playerState.xpNext} XP`);
  document.getElementById("xp-progress").style.width = `${Math.min(100, (playerState.xp / playerState.xpNext) * 100)}%`;
  setText("average-skill", Math.round(average));

  const avatar = document.getElementById("profile-avatar");
  const studentAvatar = avatarById(currentStudent?.avatarId);
  if (avatar) {
    avatar.src = studentAvatar.src;
    avatar.alt = `Аватар ${currentStudent?.name || "студента"}`;
  }
  const coachAvatar = document.getElementById("coach-mini-avatar");
  if (coachAvatar) coachAvatar.src = characterPortraitSrc(currentCharacter);
  setText("coach-mini-name", currentCharacter.name);

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
  setText("lesson-xp-reward", `${lesson.reward.xp} XP`);
  setText("lesson-coin-reward", `${lesson.reward.coins} монет`);
  setText("npc-name", lesson.npc.name);
  setText("npc-role", lesson.npc.role);
  document.getElementById("npc-avatar").innerHTML = `<img src="${npcPortraitSrc(lesson.npc.name)}" alt="${escapeHtml(lesson.npc.name)}">`;

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
  renderIreneFeedback(answer.mentorFeedback || buildIreneFeedback(metrics, answer.text, activeLesson().prompts[answer.promptIndex]));
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
  const mentorFeedback = buildIreneFeedback(metrics, text, prompt);
  const gains = calculateSkillGains(metrics);

  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : `answer-${Date.now()}`,
    timestamp: new Date().toISOString(),
    sessionId: SESSION_ID,
    lessonSessionId: session.id,
    studentId: currentStudentId(),
    studentName: currentStudent?.name || "Демо-студент",
    studentEmail: currentStudent?.email || "",
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
    mentorFeedback,
    skillGains: gains
  };

  try {
    await database.put("answers", record);
    const crossedUnlocks = applySkillGains(gains);
    const answerXp = metrics.overall >= 45 ? Math.max(2, Math.round((metrics.overall - 35) / 8)) : 0;
    addXp(answerXp);
    playerState.coins += metrics.overall >= 45 ? (metrics.targetUsed ? 4 : 2) : 0;
    playerState.totalAnswers += 1;
    playerState.bestScore = Math.max(playerState.bestScore, metrics.overall);
    ensureDailyState();
    playerState.daily.answers += 1;
    if (metrics.overall >= 75) playerState.daily.goodAnswers += 1;

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
    unlockAchievements();
    checkDailyQuestReward();
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

function buildIreneFeedback(metrics, text, prompt) {
  const clean = String(text || "").trim();
  const suggestions = [];
  let type = "Совет";
  let tone = "coach";
  let title = "Хорошее начало";
  let message = "Сделаем ответ чуть более естественным и уверенным.";

  if (metrics.overall >= 85) {
    type = "Сильный ответ"; tone = "praise"; title = "Очень уверенно!";
    message = "Ответ понятный, естественный и хорошо связан с ситуацией. Для следующего уровня добавьте короткий пример или личную деталь.";
    suggestions.push("Добавьте пример: for example…", "Попробуйте более точное прилагательное");
  } else if (metrics.wordCount < 7 || metrics.fluency < 65) {
    type = "Развернуть"; tone = "fix"; title = "Раскройте мысль подробнее";
    message = "Добавьте ещё одно предложение: объясните причину, приведите пример или скажите, что произошло дальше.";
    suggestions.push("Добавьте because…", "Добавьте for example…", "Скажите ещё 1 деталь");
  } else if (metrics.structure < 65) {
    type = "Исправить"; tone = "fix"; title = "Проверьте структуру";
    message = "Убедитесь, что в предложении есть подлежащее и глагол, а мысль заканчивается точкой или вопросительным знаком.";
    suggestions.push("Проверьте форму глагола", "Начните с заглавной буквы", "Добавьте финальный знак");
  } else if (!metrics.targetUsed) {
    type = "Усилить"; title = "Используйте фразу из урока";
    message = `Попробуйте встроить одну из подсказок: ${prompt.targetChunks.slice(0,2).join(" / ")}. Так ответ будет точнее соответствовать заданию.`;
    suggestions.push(...prompt.targetChunks.slice(0,2));
  } else if (metrics.vocabulary < 70) {
    type = "Лексика"; title = "Сделайте лексику ярче";
    message = "Замените одно простое слово более точным и добавьте связку между мыслями.";
    suggestions.push("also", "however", "I would say that…");
  } else {
    type = "Хорошо"; tone = "praise"; title = "Ответ звучит уверенно";
    message = "Смысл передан хорошо. Следующий шаг — добавить больше личных деталей и разнообразить связки.";
    suggestions.push("because", "also", "in my experience");
  }
  return { type, tone, title, message, suggestions: suggestions.slice(0,3), original: clean };
}

function renderIreneFeedback(feedback) {
  if (!feedback) return;
  setText("irene-feedback-type", feedback.type);
  setText("irene-feedback-title", feedback.title);
  setText("irene-feedback-text", feedback.message);
  const tag = document.getElementById("irene-feedback-type");
  tag?.classList.toggle("is-fix", feedback.tone === "fix");
  tag?.classList.toggle("is-praise", feedback.tone === "praise");
  const actions = document.getElementById("irene-feedback-actions");
  if (actions) actions.innerHTML = (feedback.suggestions || []).map(item => `<span class="mentor-action">${escapeHtml(item)}</span>`).join("");
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
  const weakest = bestLessonMetric(session.answers.map ? session.answers : []);
  const mentorSummary = avgScore >= 85
    ? "Вы отвечали уверенно. В следующем уроке добавляйте больше личных примеров — так речь станет ещё естественнее."
    : avgScore >= 70
      ? "Хорошая работа. Старайтесь давать ответы из двух предложений: мысль + причина или пример."
      : "Главная цель следующего урока — полные предложения и одна дополнительная деталь в каждом ответе.";
  setText("modal-mentor-copy", mentorSummary);

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
    playerState.lessonCompletions[lesson.id] = (Number(playerState.lessonCompletions[lesson.id]) || 0) + 1;
    playerState.unlockedLessonCount = Math.min(APP_DATA.lessons.length, Math.max(playerState.unlockedLessonCount, playerState.lessonIndex + 2));
    ensureDailyState();
    playerState.daily.lessons += 1;
    updateStreak();

    const completion = {
      lessonId: lesson.id,
      lessonSessionId: session.id,
      averageScore: Math.round(average(session.answers.map(answer => answer.metrics.overall))),
      answersCount: session.answers.length,
      reward: lesson.reward
    };

    const completedLessonId = lesson.id;
    playerState.lessonIndex = playerState.lessonIndex + 1 < playerState.unlockedLessonCount
      ? playerState.lessonIndex + 1
      : 0;
    playerState.session = null;
    ensureLessonSession();
    saveCurrentProfile();
    closeLessonDialog(completedLessonId);
    renderEverything();
    await logEvent("lesson_completed", completion);
    unlockAchievements();
    checkDailyQuestReward();
    celebrate("lesson");
    toast("Урок завершён", `+${lesson.reward.xp} XP и +${lesson.reward.coins} монет. Новая локация уже на карте.`);
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
    celebrate("level");
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


function avatarById(id) {
  return AVATARS.find(avatar => avatar.id === id) || AVATARS[0];
}

function characterPortraitSrc(character) {
  const id = character?.icon || character?.id || "studio";
  return `assets/characters/${id}.svg`;
}

function npcPortraitSrc(name = "") {
  const ids = ["product", "travel", "founder", "studio", "academic", "global"];
  const hash = [...String(name)].reduce((total, char) => total + char.charCodeAt(0), 0);
  return `assets/characters/${ids[hash % ids.length]}.svg`;
}

function getStudentSettings() {
  return safeParseJson(safeStorageGet(scopedKey(KEYS.studentSettings)), {});
}

function saveStudentSettings(settings) {
  safeStorageSet(scopedKey(KEYS.studentSettings), JSON.stringify(settings));
}

function hydrateStudentSettings(student) {
  if (!student) return student;
  currentStudent = student;
  const saved = getStudentSettings();
  const avatarId = avatarById(saved.avatarId || student.avatarId).id;
  const hydrated = { ...student, avatarId };
  currentStudent = hydrated;
  saveStudentSettings({ ...saved, avatarId });
  return hydrated;
}

function renderAvatarPickers() {
  const markup = (selectedId, context) => AVATARS.map(avatar => `
    <button class="avatar-choice${avatar.id === selectedId ? " is-selected" : ""}" type="button" data-avatar-id="${avatar.id}" data-avatar-context="${context}" aria-label="Аватар ${avatar.name}" aria-pressed="${avatar.id === selectedId}">
      <img src="${avatar.src}" alt=""><span>${avatar.name}</span>
    </button>
  `).join("");

  const register = document.getElementById("register-avatar-grid");
  const registerValue = document.getElementById("register-avatar")?.value || "nova";
  if (register) register.innerHTML = markup(registerValue, "register");

  const profile = document.getElementById("profile-avatar-grid");
  if (profile) profile.innerHTML = markup(pendingAvatarId || currentStudent?.avatarId || "nova", "profile");
}

function selectAvatarChoice(button) {
  const id = avatarById(button.dataset.avatarId).id;
  const context = button.dataset.avatarContext;
  if (context === "register") {
    const input = document.getElementById("register-avatar");
    if (input) input.value = id;
  } else {
    pendingAvatarId = id;
  }
  const container = button.closest(".avatar-choice-grid");
  container?.querySelectorAll(".avatar-choice").forEach(item => {
    const selected = item.dataset.avatarId === id;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
}

function openAvatarDialog() {
  if (!currentStudent) return;
  pendingAvatarId = currentStudent.avatarId || "nova";
  renderAvatarPickers();
  const dialog = document.getElementById("avatar-dialog");
  if (typeof dialog?.showModal === "function") dialog.showModal();
  else dialog?.setAttribute("open", "");
}

function closeAvatarDialog() {
  const dialog = document.getElementById("avatar-dialog");
  if (dialog?.open && typeof dialog.close === "function") dialog.close();
  else dialog?.removeAttribute("open");
}

async function saveSelectedAvatar() {
  const button = document.getElementById("save-avatar");
  button.disabled = true;
  try {
    const updated = await AuthService.updateProfile({ avatarId: pendingAvatarId });
    currentStudent = hydrateStudentSettings(updated || { ...currentStudent, avatarId: pendingAvatarId });
    saveStudentSettings({ ...getStudentSettings(), avatarId: pendingAvatarId });
    updateStudentUi();
    renderProfile();
    closeAvatarDialog();
    await logEvent("avatar_changed", { avatarId: pendingAvatarId });
    toast("Аватар обновлён", "Новый образ уже отображается в профиле.");
  } catch (error) {
    console.error("Avatar update failed", error);
    toast("Не удалось сохранить аватар", "Попробуйте ещё раз.");
  } finally {
    button.disabled = false;
  }
}

function createDailyState() {
  return { date: localDateKey(new Date()), answers: 0, goodAnswers: 0, lessons: 0, claimed: false };
}

function normalizeDailyState(daily) {
  const today = localDateKey(new Date());
  if (!daily || daily.date !== today) return createDailyState();
  return {
    date: today,
    answers: Math.max(0, Number(daily.answers) || 0),
    goodAnswers: Math.max(0, Number(daily.goodAnswers) || 0),
    lessons: Math.max(0, Number(daily.lessons) || 0),
    claimed: Boolean(daily.claimed)
  };
}

function ensureDailyState() {
  if (!playerState) return;
  playerState.daily = normalizeDailyState(playerState.daily);
}

function dailyQuestComplete(quest) {
  const value = Math.min(quest.target, quest.value(playerState.daily));
  return { value, complete: value >= quest.target };
}

function renderDailyQuests() {
  const container = document.getElementById("daily-quests");
  if (!container || !playerState) return;
  ensureDailyState();
  const allComplete = DAILY_QUESTS.every(quest => dailyQuestComplete(quest).complete);
  setText("daily-reward-chip", playerState.daily.claimed ? "получено" : `+${DAILY_REWARD.coins}`);
  container.innerHTML = DAILY_QUESTS.map(quest => {
    const status = dailyQuestComplete(quest);
    const percent = Math.round((status.value / quest.target) * 100);
    return `<div class="quest-item${status.complete ? " is-complete" : ""}">
      <span class="quest-icon">${quest.icon}</span>
      <div><strong>${escapeHtml(quest.title)}</strong><span>${status.value} / ${quest.target}</span><i><b style="width:${percent}%"></b></i></div>
      <em>${status.complete ? "✓" : "+"}</em>
    </div>`;
  }).join("") + (allComplete ? `<div class="daily-complete${playerState.daily.claimed ? " is-claimed" : ""}">${playerState.daily.claimed ? "Награда за сегодня получена" : "Все задания выполнены — заберите награду"}</div>` : "");
}

function checkDailyQuestReward() {
  if (!playerState) return false;
  ensureDailyState();
  const complete = DAILY_QUESTS.every(quest => dailyQuestComplete(quest).complete);
  if (!complete || playerState.daily.claimed) return false;
  playerState.daily.claimed = true;
  playerState.coins += DAILY_REWARD.coins;
  addXp(DAILY_REWARD.xp);
  unlockAchievements();
  saveCurrentProfile();
  celebrate("daily");
  toast("Ежедневная цель выполнена", `+${DAILY_REWARD.xp} XP и +${DAILY_REWARD.coins} монет.`);
  logEvent("daily_reward_claimed", DAILY_REWARD);
  renderEverything();
  return true;
}

function unlockAchievements() {
  if (!playerState) return [];
  const unlocked = [];
  playerState.achievements = Array.isArray(playerState.achievements) ? playerState.achievements : [];
  ACHIEVEMENTS.forEach(achievement => {
    if (!playerState.achievements.includes(achievement.id) && achievement.test(playerState)) {
      playerState.achievements.push(achievement.id);
      playerState.coins += 10;
      unlocked.push(achievement);
      toast(`Достижение: ${achievement.title}`, `${achievement.description} · +10 монет`);
      logEvent("achievement_unlocked", { achievementId: achievement.id });
    }
  });
  if (unlocked.length) {
    saveCurrentProfile();
    celebrate("achievement");
    renderAchievements();
    renderProfile();
  }
  return unlocked;
}

function renderAchievements() {
  if (!playerState) return;
  const unlocked = new Set(playerState.achievements || []);
  const markup = ACHIEVEMENTS.map(achievement => `
    <div class="achievement-badge${unlocked.has(achievement.id) ? " is-unlocked" : ""}" title="${escapeHtml(achievement.description)}">
      <span>${achievement.icon}</span><strong>${escapeHtml(achievement.title)}</strong><small>${escapeHtml(achievement.description)}</small>
    </div>
  `).join("");
  const gallery = document.getElementById("achievement-gallery");
  if (gallery) gallery.innerHTML = markup;
  const preview = document.getElementById("badge-preview");
  if (preview) preview.innerHTML = ACHIEVEMENTS.slice(0, 4).map(achievement => `<span class="mini-badge${unlocked.has(achievement.id) ? " is-unlocked" : ""}" title="${escapeHtml(achievement.title)}">${achievement.icon}</span>`).join("");
  setText("badge-count", unlocked.size);
  setText("achievement-progress-label", `${unlocked.size} / ${ACHIEVEMENTS.length}`);
}

function getPlayerMood() {
  if (!playerState) return { label: "Готов к игре", emoji: "◇" };
  const lastScore = playerState.session?.answers?.at?.(-1)?.metrics?.overall || 0;
  if (lastScore >= 90) return { label: "Вдохновлён", emoji: "✨" };
  if (playerState.streak >= 3) return { label: "На волне", emoji: "⚡" };
  if (averageSkill() >= 70) return { label: "Уверен", emoji: "💎" };
  if (playerState.session?.answers?.length) return { label: "Сосредоточен", emoji: "🎯" };
  return { label: "Любопытен", emoji: "◇" };
}

function renderLessonMap() {
  const map = document.getElementById("lesson-map");
  if (!map || !playerState) return;
  const unlockedCount = Math.max(1, playerState.unlockedLessonCount || 1);
  setText("journey-progress", `${unlockedCount} / ${APP_DATA.lessons.length} открыто`);
  map.innerHTML = APP_DATA.lessons.map((lesson, index) => {
    const unlocked = index < unlockedCount;
    const active = index === playerState.lessonIndex;
    const completions = Number(playerState.lessonCompletions?.[lesson.id]) || 0;
    return `<button class="map-stop${active ? " is-active" : ""}${unlocked ? "" : " is-locked"}" type="button" data-lesson-index="${index}" ${unlocked ? "" : "disabled"} title="${escapeHtml(unlocked ? lesson.title : "Сначала завершите предыдущую локацию")}">
      <span class="map-stop-icon">${unlocked ? LESSON_ICONS[index % LESSON_ICONS.length] : "🔒"}</span>
      <span class="map-stop-copy"><strong>${escapeHtml(lesson.title)}</strong><small>${completions ? `пройдено ${completions}` : unlocked ? "доступно" : "закрыто"}</small></span>
      ${completions ? '<i class="map-check">✓</i>' : ""}
    </button>`;
  }).join("");
}

function selectLesson(index) {
  if (!playerState || index < 0 || index >= playerState.unlockedLessonCount || index === playerState.lessonIndex) return;
  const session = activeSession();
  if (session?.answers?.length && !session.readyToFinish) {
    const approved = confirm("Начать другую историю? Текущий незавершённый диалог будет сброшен.");
    if (!approved) return;
  }
  playerState.lessonIndex = index;
  playerState.session = null;
  ensureLessonSession();
  saveCurrentProfile();
  renderEverything();
  logEvent("lesson_selected", { lessonId: activeLesson()?.id, lessonIndex: index });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function celebrate(type = "lesson") {
  const layer = document.getElementById("celebration-layer");
  if (!layer || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const symbols = type === "level" ? ["💎", "✦", "◆"] : type === "achievement" ? ["🏆", "✦", "★"] : ["✦", "◆", "●"];
  layer.innerHTML = Array.from({ length: 22 }, (_, index) => `<i style="--x:${4 + Math.random() * 92}%;--delay:${Math.random() * .35}s;--turn:${Math.random() * 540 - 270}deg">${symbols[index % symbols.length]}</i>`).join("");
  layer.classList.remove("is-active");
  void layer.offsetWidth;
  layer.classList.add("is-active");
  setTimeout(() => { layer.classList.remove("is-active"); layer.innerHTML = ""; }, 2100);
}

async function switchView(view, shouldLog = true) {
  if (view === "admin" && !canAccessAdmin()) {
    toast("Доступ только преподавателю", "Студенты видят уроки и личную аналитику, но не админку.");
    return;
  }
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
  const answers = allAnswers.filter(answer => recordBelongsToCurrentStudent(answer) && answer.characterId === currentCharacter.id).sort(byNewest);
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
  renderAchievements();

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
  return `Irene советует сейчас подтянуть ${labels[weakest]}. ${tips[weakest]}`;
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
      <td>${escapeHtml(answer.studentName || answer.studentEmail || "Демо-студент")}</td>
      <td>${escapeHtml(answer.characterName || APP_DATA.characters.find(item => item.id === answer.characterId)?.name || "—")}</td>
      <td>${escapeHtml(answer.lessonTitle || answer.lessonId || "—")}</td>
      <td>${escapeHtml(truncate(answer.text, 120))}</td>
      <td class="score-cell">${Math.round(Number(answer.metrics?.overall) || 0)}</td>
    </tr>
  `).join("") : `<tr><td colspan="6" class="empty-row">Сохранённых ответов пока нет.</td></tr>`;
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
  const header = ["timestamp", "student", "email", "profile", "lesson", "prompt_index", "answer", "relevance", "vocabulary", "structure", "fluency", "overall"];
  const rows = answers.map(answer => [
    answer.timestamp,
    answer.studentName || "Демо-студент",
    answer.studentEmail || "",
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
        studentId: answer.studentId || currentStudentId(),
        studentName: answer.studentName || currentStudent?.name || "Демо-студент",
        studentEmail: answer.studentEmail || currentStudent?.email || "",
        text: String(answer.text).slice(0, 280)
      });
    }
    for (const importedEvent of payload.events.slice(0, 20000)) {
      if (!importedEvent || typeof importedEvent !== "object") continue;
      const { id, ...eventWithoutId } = importedEvent;
      await database.add("events", {
        ...eventWithoutId,
        timestamp: validIsoDate(importedEvent.timestamp) ? importedEvent.timestamp : new Date().toISOString(),
        studentId: importedEvent.studentId || currentStudentId(),
        studentName: importedEvent.studentName || currentStudent?.name || "Демо-студент",
        studentEmail: importedEvent.studentEmail || currentStudent?.email || "",
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
  safeStorageRemove(scopedKey(KEYS.profiles));
  safeStorageRemove(scopedKey(KEYS.selectedCharacter));
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
  currentCharacter = null;
  playerState = null;
  try {
    await AuthService.signOut();
  } catch (error) {
    console.error("Logout failed", error);
    toast("Не удалось выйти", "Обновите страницу и попробуйте ещё раз.");
  }
  showAuthView();
}

async function logEvent(eventName, payload = {}) {
  if (!database) return;
  const event = {
    timestamp: new Date().toISOString(),
    eventName,
    sessionId: SESSION_ID,
    studentId: currentStudentId(),
    studentName: currentStudent?.name || "Демо-студент",
    studentEmail: currentStudent?.email || "",
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
