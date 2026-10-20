
/* =========================================================
   NEXCHAT — APPLICATION JAVASCRIPT
   File: app.js

   Frontend integration for Supabase authentication,
   matchmaking, realtime messages, and safety actions.

   IMPORTANT:
   The SQL/RPC functions and database security policies
   must be implemented before this becomes operational.
   ========================================================= */

"use strict";

/* ---------------------------------------------------------
   1. CONFIGURATION
   --------------------------------------------------------- */

const SUPABASE_URL = "https://mthhcesfdabzgkmjofip.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_VKnNLQTR3mOH3ivDpwkMgQ_IkP5aEEV";

const MAX_MESSAGE_LENGTH = 1000;
const MESSAGE_HISTORY_LIMIT = 100;

const RPC = {
  findMatch: "find_or_create_match",
  leaveChat: "leave_chat",
  blockUser: "block_user",
  reportUser: "report_user"
};

const TABLES = {
  messages: "messages"
};

const CONFIGURED =
  SUPABASE_URL.startsWith("https://") &&
  !SUPABASE_URL.includes("YOUR_SUPABASE") &&
  SUPABASE_PUBLISHABLE_KEY.length > 20 &&
  !SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE");

let client = null;
let currentUser = null;
let currentRoomId = null;
let currentPartnerId = null;
let messageChannel = null;
let authSubscription = null;
let isSearching = false;
let isSending = false;
let isLeaving = false;
let authMode = "signin";
let actionMode = null;
let currentMessages = new Set();
let lastMessageAt = 0;
let activeRequest = 0;

/* ---------------------------------------------------------
   2. DOM HELPERS
   --------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = String(value ?? "");
}

function showElement(id, visible = true) {
  const element = $(id);
  if (element) element.hidden = !visible;
}

function setDisabled(id, disabled) {
  const element = $(id);
  if (element) element.disabled = Boolean(disabled);
}

function setNotice(id, message, type = "") {
  const element = $(id);
  if (!element) return;

  element.textContent = message;
  element.classList.remove("is-error", "is-success");

  if (type === "error") element.classList.add("is-error");
  if (type === "success") element.classList.add("is-success");

  element.hidden = !message;
}

function escapeDisplayText(value) {
  return String(value ?? "").slice(0, MAX_MESSAGE_LENGTH);
}

function formatTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toast(message, type = "") {
  const container = $("toastContainer");

  if (!container) {
    console.log(`[NexChat${type ? ` ${type}` : ""}]`, message);
    return;
  }

  const element = document.createElement("div");
  element.className = `toast${type ? ` is-${type}` : ""}`;
  element.setAttribute("role", "status");
  element.textContent = message;

  container.appendChild(element);

  window.setTimeout(() => {
    element.classList.add("is-leaving");

    window.setTimeout(() => {
      element.remove();
    }, 180);
  }, 4000);
}

function setConnectionState(state, message) {
  const indicator = $("connectionStatus");
  const label = $("connectionLabel");
  const workspaceIndicator = $("workspaceStatus");

  if (indicator) {
    indicator.classList.remove("is-warning", "is-offline");

    if (state === "connecting") {
      indicator.classList.add("is-warning");
    } else if (state === "offline") {
      indicator.classList.add("is-offline");
    }
  }

  if (label) label.textContent = message;

  if (workspaceIndicator) {
    const statusText = $("workspaceStatusText");

    if (statusText) statusText.textContent = message;
  }
}

function updateChatStatus(message) {
  setText("chatStatus", message);
  setText("chatSubtitle", message);
}

function setBusy(buttonId, busy, busyText = "Please wait…") {
  const button = $(buttonId);
  if (!button) return;

  if (busy) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent.trim();
    }

    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

/* ---------------------------------------------------------
   3. SAFE MESSAGE RENDERING
   Never render user messages through innerHTML.
   --------------------------------------------------------- */

function renderMessage(message) {
  const body = $("chatBody");

  if (!body || !message || !message.id) return;

  if (currentMessages.has(String(message.id))) return;

  const content = String(message.content ?? "");

  if (!content || content.length > MAX_MESSAGE_LENGTH) return;

  const ownMessage = message.sender_id === currentUser?.id;

  const emptyState = $("welcome");
  if (emptyState) emptyState.hidden = true;

  const row = document.createElement("article");
  row.className = `message${ownMessage ? " message--own" : ""}`;
  row.dataset.messageId = String(message.id);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = content;

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const author = document.createElement("span");
  author.textContent = ownMessage ? "You" : "Partner";

  const time = document.createElement("time");
  time.className = "message-time";
  time.textContent = formatTime(message.created_at);

  meta.append(author, time);
  row.append(bubble, meta);
  body.appendChild(row);

  currentMessages.add(String(message.id));

  while (body.querySelectorAll(".message").length > MESSAGE_HISTORY_LIMIT) {
    const oldest = body.querySelector(".message");
    if (!oldest) break;

    currentMessages.delete(oldest.dataset.messageId);
    oldest.remove();
  }

  body.scrollTop = body.scrollHeight;
}

/* ---------------------------------------------------------
   4. INITIALIZE SUPABASE
   --------------------------------------------------------- */

function initializeSupabase() {
  if (!CONFIGURED) {
    setConnectionState("offline", "Backend not configured");
    updateChatStatus("Connect your Supabase project to begin.");

    setNotice(
      "matchNotice",
      "Add your Supabase project URL and publishable key in app.js. Database setup is also required.",
      "error"
    );

    return false;
  }

  if (!window.supabase?.createClient) {
    setConnectionState("offline", "Supabase library unavailable");
    toast("Supabase could not load. Check your internet connection.", "error");
    return false;
  }

  client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  return true;
}

/* ---------------------------------------------------------
   5. AUTHENTICATION UI
   --------------------------------------------------------- */

function openAuth(mode = "signin") {
  authMode = mode;
  updateAuthModal();
  showElement("authModal", true);
  $("authModal")?.setAttribute("aria-modal", "true");
  $("email")?.focus();
}

function closeAuth() {
  showElement("authModal", false);
  $("authModal")?.removeAttribute("aria-modal");
  setNotice("authNotice", "");

  const form = $("authForm");
  if (form) form.reset();
}

function updateAuthModal() {
  const isSignup = authMode === "signup";

  setText("authTitle", isSignup ? "Create your account" : "Welcome back");
  setText(
    "authDescription",
    isSignup
      ? "Create an account to use NexChat."
      : "Sign in to continue to NexChat."
  );

  setText("authSubmit", isSignup ? "Create account" : "Sign in");

  const switchText = $("authSwitchText");
  if (switchText) {
    switchText.textContent = isSignup
      ? "Already have an account? "
      : "New to NexChat? ";
  }

  setText("authSwitch", isSignup ? "Sign in" : "Create account");

  showElement("confirmPasswordWrap", isSignup);
  showElement("forgotButton", !isSignup);

  const confirmPassword = $("confirmPassword");
  if (confirmPassword) {
    confirmPassword.required = isSignup;
  }

  setNotice("authNotice", "");
}

async function handleAuthSubmit(event) {
  event.preventDefault();

  if (!client) {
    setNotice("authNotice", "Supabase is not configured.", "error");
    return;
  }

  const email = $("email")?.value.trim();
  const password = $("password")?.value;
  const confirmPassword = $("confirmPassword")?.value;

  if (!email || !password) {
    setNotice("authNotice", "Enter your email and password.", "error");
    return;
  }

  if (password.length < 8) {
    setNotice(
      "authNotice",
      "Use a password with at least 8 characters.",
      "error"
    );
    return;
  }

  if (authMode === "signup" && password !== confirmPassword) {
    setNotice("authNotice", "Your passwords do not match.", "error");
    return;
  }

  setBusy("authSubmit", true, "Please wait…");
  setNotice("authNotice", "");

  try {
    let result;

    if (authMode === "signup") {
      result = await client.auth.signUp({
        email,
        password
      });
    } else {
      result = await client.auth.signInWithPassword({
        email,
        password
      });
    }

    if (result.error) throw result.error;

    if (
      authMode === "signup" &&
      !result.data.session
    ) {
      setNotice(
        "authNotice",
        "Check your email for the confirmation link before signing in.",
        "success"
      );
      return;
    }

    closeAuth();
    toast(
      authMode === "signup" ? "Account created." : "Signed in successfully.",
      "success"
    );
  } catch (error) {
    setNotice(
      "authNotice",
      error.message || "Authentication failed. Try again.",
      "error"
    );
  } finally {
    setBusy("authSubmit", false);
  }
}

async function handleForgotPassword() {
  if (!client) {
    setNotice("authNotice", "Supabase is not configured.", "error");
    return;
  }

  const email = $("email")?.value.trim();

  if (!email) {
    setNotice("authNotice", "Enter your email address first.", "error");
    $("email")?.focus();
    return;
  }

  try {
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${window.location.pathname}`
    });

    if (error) throw error;

    setNotice(
      "authNotice",
      "If password recovery is enabled, check your email for the recovery link.",
      "success"
    );
  } catch (error) {
    setNotice(
      "authNotice",
      error.message || "Unable to start password recovery.",
      "error"
    );
  }
}

function updateAuthButton() {
  const button = $("authButton");

  if (!button) return;

  if (currentUser) {
    button.textContent = "Sign out";
    button.dataset.action = "signout";
  } else {
    button.textContent = "Sign in";
    button.dataset.action = "signin";
  }
}

async function handleAuthButton() {
  if (!client) {
    openAuth("signin");
    return;
  }

  if (!currentUser) {
    openAuth("signin");
    return;
  }

  if (currentRoomId) {
    await leaveCurrentChat();
  }

  const { error } = await client.auth.signOut();

  if (error) {
    toast("Could not sign out. Please try again.", "error");
  } else {
    toast("Signed out.", "success");
  }
}

async function handleAuthState() {
  if (!client) return;

  if (authSubscription) {
    authSubscription.data.subscription.unsubscribe();
  }

  const { data } = await client.auth.onAuthStateChange(
    (event, session) => {
      currentUser = session?.user ?? null;

      updateAuthButton();

      if (!currentUser) {
        clearCurrentChat();
        updateChatStatus("Sign in to start chatting.");
      } else {
        updateChatStatus("Choose a language and find a partner.");
      }

      if (event === "PASSWORD_RECOVERY") {
        openAuth("signin");
        setNotice(
          "authNotice",
          "Password recovery started. Follow the instructions sent to your email.",
          "success"
        );
      }
    }
  );

  authSubscription = { data };
}

/* ---------------------------------------------------------
   6. MATCHMAKING
   Required RPC contract:
   find_or_create_match(language_code text)
   returns room_id, partner_id

   The backend must validate membership and create rooms
   atomically. Client-side checks are not security controls.
   --------------------------------------------------------- */

async function findPartner() {
  if (!client) {
    toast("Connect Supabase before searching.", "error");
    return;
  }

  if (!currentUser) {
    openAuth("signin");
    return;
  }

  if (isSearching) return;

  if (currentRoomId) {
    await leaveCurrentChat();
  }

  isSearching = true;
  const requestId = ++activeRequest;

  setBusy("findButton", true, "Finding partner…");
  setDisabled("nextButton", true);
  setDisabled("leaveButton", true);

  setConnectionState("connecting", "Searching");
  updateChatStatus("Looking for someone to chat with…");

  setNotice("matchNotice", "Searching for an available partner…");

  try {
    const language = $("languageSelect")?.value || "any";

    const { data, error } = await client.rpc(RPC.findMatch, {
      language_code: language
    });

    if (error) throw error;

    if (requestId !== activeRequest) return;

    const match = Array.isArray(data) ? data[0] : data;

    if (!match?.room_id || !match?.partner_id) {
      setNotice(
        "matchNotice",
        "No partner is available right now. Try again shortly."
      );
      updateChatStatus("Waiting for a match.");
      setConnectionState("online", "Connected");
      return;
    }

    currentRoomId = match.room_id;
    currentPartnerId = match.partner_id;

    currentMessages.clear();

    const body = $("chatBody");
    if (body) body.replaceChildren();

    showElement("welcome", false);
    showElement("chatIntroBanner", true);

    updateChatStatus("Connected to a partner");
    setText("chatTitle", "Your conversation");
    setText("partnerAvatar", "N");
    setText("chatStatus", "Connected");
    setText("matchNotice", "You're connected. Be respectful and stay safe.");

    setConnectionState("online", "Connected");
    setDisabled("nextButton", false);
    setDisabled("leaveButton", false);

    await loadMessageHistory();
    await subscribeToMessages();

    toast("Partner found. Say hello!", "success");
  } catch (error) {
    console.error("Matchmaking error:", error);

    setNotice(
      "matchNotice",
      "Could not find a partner. Check your backend setup and try again.",
      "error"
    );

    updateChatStatus("Unable to connect.");
    setConnectionState("offline", "Connection issue");
  } finally {
    isSearching = false;
    setBusy("findButton", false);
  }
}

/* ---------------------------------------------------------
   7. LOAD CHAT HISTORY
   Database RLS must restrict reads to active room members.
   --------------------------------------------------------- */

async function loadMessageHistory() {
  if (!client || !currentRoomId) return;

  const roomId = currentRoomId;

  const { data, error } = await client
    .from(TABLES.messages)
    .select("id, room_id, sender_id, content, created_at")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true })
    .limit(MESSAGE_HISTORY_LIMIT);

  if (error) {
    console.error("Message history error:", error);
    toast("Could not load previous messages.", "error");
    return;
  }

  if (currentRoomId !== roomId) return;

  for (const message of data || []) {
    renderMessage(message);
  }
}

/* ---------------------------------------------------------
   8. REALTIME MESSAGES
   The database must reject inserts into rooms where the
   sender is not an active member.
   --------------------------------------------------------- */

async function subscribeToMessages() {
  if (!client || !currentRoomId) return;

  removeMessageSubscription();

  const roomId = currentRoomId;

  messageChannel = client
    .channel(`nexchat-room-${roomId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: TABLES.messages,
        filter: `room_id=eq.${roomId}`
      },
      (payload) => {
        if (currentRoomId !== roomId) return;

        renderMessage(payload.new);
      }
    )
    .subscribe((status) => {
      if (currentRoomId !== roomId) return;

      if (status === "SUBSCRIBED") {
        setConnectionState("online", "Connected");
      } else if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT"
      ) {
        setConnectionState("offline", "Reconnecting");
      }
    });
}

function removeMessageSubscription() {
  if (client && messageChannel) {
    client.removeChannel(messageChannel);
  }

  messageChannel = null;
}

/* ---------------------------------------------------------
   9. SEND MESSAGE
   --------------------------------------------------------- */

async function sendMessage(event) {
  event.preventDefault();

  if (!client || !currentUser) {
    openAuth("signin");
    return;
  }

  if (!currentRoomId || !currentPartnerId) {
    toast("Find a partner before sending a message.", "warning");
    return;
  }

  if (isSending) return;

  const input = $("messageInput");
  const content = input?.value.trim();

  if (!content) return;

  if (content.length > MAX_MESSAGE_LENGTH) {
    toast(`Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.`, "error");
    return;
  }

  const now = Date.now();

  if (now - lastMessageAt < 500) {
    toast("Please wait a moment before sending another message.", "warning");
    return;
  }

  const roomId = currentRoomId;

  isSending = true;
  setDisabled("sendButton", true);

  try {
    const { error } = await client
      .from(TABLES.messages)
      .insert({
        room_id: roomId,
        sender_id: currentUser.id,
        content
      });

    if (error) throw error;

    if (currentRoomId !== roomId) return;

    lastMessageAt = Date.now();

    if (input) {
      input.value = "";
      input.focus();
    }

    updateCharacterCount();
  } catch (error) {
    console.error("Send message error:", error);

    toast(
      "Message could not be sent. Check your connection and room permissions.",
      "error"
    );
  } finally {
    isSending = false;
    setDisabled("sendButton", false);
  }
}

function updateCharacterCount() {
  const input = $("messageInput");
  const count = $("characterCount");

  if (!input || !count) return;

  count.textContent = `${input.value.length}/${MAX_MESSAGE_LENGTH}`;
}

/* ---------------------------------------------------------
   10. LEAVE CHAT
   Required RPC:
   leave_chat(room_id_input)

   Server must verify the caller is a member and close or
   remove their membership atomically.
   --------------------------------------------------------- */

async function leaveCurrentChat() {
  if (!client || !currentRoomId || isLeaving) return;

  isLeaving = true;

  const roomId = currentRoomId;

  currentRoomId = null;
  currentPartnerId = null;
  activeRequest++;

  removeMessageSubscription();

  setDisabled("nextButton", true);
  setDisabled("leaveButton", true);

  try {
    const { error } = await client.rpc(RPC.leaveChat, {
      room_id_input: roomId
    });

    if (error) throw error;
  } catch (error) {
    console.error("Leave chat error:", error);

    toast(
      "Your local chat has closed, but the server could not confirm the leave action.",
      "error"
    );
  } finally {
    clearCurrentChat();
    isLeaving = false;
  }
}

function clearCurrentChat() {
  removeMessageSubscription();

  currentRoomId = null;
  currentPartnerId = null;
  currentMessages.clear();

  const body = $("chatBody");

  if (body) body.replaceChildren();

  showElement("welcome", true);
  showElement("chatIntroBanner", true);

  setText("chatTitle", "Ready to connect");
  setText("chatSubtitle", "Your next conversation starts here.");
  setText("chatStatus", "Not connected");
  setText("partnerAvatar", "?");

  setNotice("matchNotice", "");

  setDisabled("nextButton", true);
  setDisabled("leaveButton", true);

  if (currentUser) {
    updateChatStatus("Choose a language and find a partner.");
  } else {
    updateChatStatus("Sign in to start chatting.");
  }
}

/* ---------------------------------------------------------
   11. BLOCK PARTNER
   Required RPC:
   block_user(blocked_user_id)

   Server must verify identity, store the block, and prevent
   future matching. Leaving a room alone is not blocking.
   --------------------------------------------------------- */

async function blockCurrentPartner() {
  if (!client || !currentUser || !currentPartnerId) {
    toast("There is no active partner to block.", "warning");
    return;
  }

  const partnerId = currentPartnerId;

  try {
    const { error } = await client.rpc(RPC.blockUser, {
      blocked_user_id: partnerId
    });

    if (error) throw error;

    await leaveCurrentChat();

    toast("Partner blocked.", "success");
  } catch (error) {
    console.error("Block partner error:", error);

    toast(
      "Could not block this partner. Please try again.",
      "error"
    );
  }
}

/* ---------------------------------------------------------
   12. REPORT PARTNER
   Required RPC:
   report_user(reported_user_id, report_reason, chat_room_id)

   Validate the report and authorize it on the server.
   Do not rely on a browser-side report as moderation.
   --------------------------------------------------------- */

async function reportCurrentPartner(reason, details = "") {
  if (!client || !currentUser || !currentPartnerId) {
    toast("There is no active partner to report.", "warning");
    return;
  }

  const allowedReasons = [
    "harassment",
    "inappropriate",
    "spam",
    "threats",
    "other"
  ];

  if (!allowedReasons.includes(reason)) {
    toast("Choose a valid report reason.", "error");
    return;
  }

  const roomId = currentRoomId;
  const partnerId = currentPartnerId;

  try {
    const { error } = await client.rpc(RPC.reportUser, {
      reported_user_id: partnerId,
      report_reason: reason,
      chat_room_id: roomId
    });

    if (error) throw error;

    closeAction();
    toast("Report submitted. Thank you for helping keep NexChat safer.", "success");

    await leaveCurrentChat();
  } catch (error) {
    console.error("Report partner error:", error);

    setNotice(
      "actionNotice",
      "The report could not be submitted. Please try again.",
      "error"
    );
  }
}

/* ---------------------------------------------------------
   13. SAFETY ACTION MODAL
   --------------------------------------------------------- */

function openAction(mode) {
  if (!currentPartnerId) {
    toast("Connect to a partner first.", "warning");
    return;
  }

  actionMode = mode;

  const isReport = mode === "report";

  setText(
    "actionTitle",
    isReport ? "Report this partner" : "Block this partner"
  );

  setText(
    "actionDescription",
    isReport
      ? "Tell us why you are reporting this conversation."
      : "You will leave this conversation and should not be matched with this user again."
  );

  showElement("reportReasonGroup", isReport);
  showElement("reportDetailsGroup", isReport);
  showElement("actionModal", true);

  setNotice("actionNotice", "");
}

function closeAction() {
  showElement("actionModal", false);
  $("actionModal")?.removeAttribute("aria-modal");

  actionMode = null;

  const form = $("reportDetails");
  if (form) form.value = "";
}

async function confirmAction() {
  if (actionMode === "block") {
    await blockCurrentPartner();
    closeAction();
    return;
  }

  if (actionMode === "report") {
    const reason = $("reportReason")?.value;
    const details = $("reportDetails")?.value.trim() || "";

    await reportCurrentPartner(reason, details);
  }
}

/* ---------------------------------------------------------
   14. MOBILE NAVIGATION
   --------------------------------------------------------- */

function toggleMobileMenu() {
  const menu = $("mobileMenu");
  const button = $("mobileMenuButton");

  if (!menu) return;

  const shouldOpen = menu.hidden;

  menu.hidden = !shouldOpen;

  if (button) {
    button.setAttribute("aria-expanded", String(shouldOpen));
  }
}

function closeMobileMenu() {
  const menu = $("mobileMenu");
  const button = $("mobileMenuButton");

  if (menu) menu.hidden = true;

  if (button) button.setAttribute("aria-expanded", "false");
}

/* ---------------------------------------------------------
   15. CHAT OPTIONS
   --------------------------------------------------------- */

function toggleChatOptions() {
  const menu = $("chatOptionsMenu");
  const button = $("chatOptionsButton");

  if (!menu) return;

  const shouldOpen = menu.hidden;

  menu.hidden = !shouldOpen;

  if (button) {
    button.setAttribute("aria-expanded", String(shouldOpen));
  }
}

function closeChatOptions() {
  const menu = $("chatOptionsMenu");
  const button = $("chatOptionsButton");

  if (menu) menu.hidden = true;

  if (button) button.setAttribute("aria-expanded", "false");
}

/* ---------------------------------------------------------
   16. EVENT LISTENERS
   --------------------------------------------------------- */

function bindEvents() {
  $("authButton")?.addEventListener("click", handleAuthButton);

  $("closeAuth")?.addEventListener("click", closeAuth);

  $("authForm")?.addEventListener("submit", handleAuthSubmit);

  $("authSwitch")?.addEventListener("click", () => {
    authMode = authMode === "signin" ? "signup" : "signin";
    updateAuthModal();
  });

  $("forgotButton")?.addEventListener("click", handleForgotPassword);

  $("heroStart")?.addEventListener("click", findPartner);
  $("bottomStart")?.addEventListener("click", findPartner);
  $("findButton")?.addEventListener("click", findPartner);

  $("nextButton")?.addEventListener("click", async () => {
    if (currentRoomId) await leaveCurrentChat();
    await findPartner();
  });

  $("leaveButton")?.addEventListener("click", leaveCurrentChat);

  $("messageForm")?.addEventListener("submit", sendMessage);

  $("messageInput")?.addEventListener("input", updateCharacterCount);

  $("closeAction")?.addEventListener("click", closeAction);
  $("cancelAction")?.addEventListener("click", closeAction);

  $("confirmAction")?.addEventListener("click", confirmAction);

  $("chatOptionsButton")?.addEventListener("click", toggleChatOptions);

  $("chatMenuReport")?.addEventListener("click", () => {
    closeChatOptions();
    openAction("report");
  });

  $("chatMenuBlock")?.addEventListener("click", () => {
    closeChatOptions();
    openAction("block");
  });

  $("chatMenuLeave")?.addEventListener("click", async () => {
    closeChatOptions();
    await leaveCurrentChat();
  });

  $("mobileMenuButton")?.addEventListener("click", toggleMobileMenu);

  $("mobileMenu")?.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeMobileMenu);
  });

  $("authModal")?.addEventListener("click", (event) => {
    if (event.target === $("authModal")) closeAuth();
  });

  $("actionModal")?.addEventListener("click", (event) => {
    if (event.target === $("actionModal")) closeAction();
  });

  document.addEventListener("click", (event) => {
    const menu = $("chatOptionsMenu");
    const button = $("chatOptionsButton");

    if (
      menu &&
      !menu.hidden &&
      !menu.contains(event.target) &&
      !button?.contains(event.target)
    ) {
      closeChatOptions();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAuth();
      closeAction();
      closeMobileMenu();
      closeChatOptions();
    }
  });

  window.addEventListener("online", () => {
    if (client) {
      setConnectionState("connecting", "Reconnecting");
    }
  });

  window.addEventListener("offline", () => {
    setConnectionState("offline", "You are offline");
  });
}

/* ---------------------------------------------------------
   17. START APPLICATION
   --------------------------------------------------------- */

async function startApp() {
  const year = $("currentYear");

  if (year) year.textContent = new Date().getFullYear();

  bindEvents();
  updateCharacterCount();

  setDisabled("nextButton", true);
  setDisabled("leaveButton", true);

  showElement("chatOptionsMenu", false);
  showElement("mobileMenu", false);
  showElement("authModal", false);
  showElement("actionModal", false);

  if (!initializeSupabase()) {
    return;
  }

  setConnectionState("connecting", "Connecting");

  try {
    const { data, error } = await client.auth.getSession();

    if (error) throw error;

    currentUser = data.session?.user ?? null;

    updateAuthButton();

    if (currentUser) {
      updateChatStatus("Choose a language and find a partner.");
    } else {
      updateChatStatus("Sign in to start chatting.");
    }

    await handleAuthState();

    setConnectionState("online", "Connected");
  } catch (error) {
    console.error("Startup error:", error);

    setConnectionState("offline", "Connection issue");

    toast(
      "Could not initialize your account session. Refresh and try again.",
      "error"
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startApp, { once: true });
} else {
  startApp();
}
