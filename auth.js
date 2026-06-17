import { SUPABASE_CONFIG } from "./config.js";

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

export const AuthService = {
  async init() {
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

export { AUTH_EVENT };
