// The publishable Razorpay key id. This is the ONLY Razorpay credential that
// the browser is allowed to see. The secret stays on the server.
//
// Resolution order:
//   1. Build/runtime-injected NEXT_PUBLIC_RAZORPAY_KEY_ID (window.__ENV.*)
//   2. Public /api/payments/config endpoint (fetched lazily before checkout)
//   3. The key returned by /create-order (always trusted, comes from server)
const paymentConfig = {
  key: (typeof window !== "undefined"
    && window.__ENV
    && window.__ENV.NEXT_PUBLIC_RAZORPAY_KEY_ID)
    || "",
};

async function ensurePaymentKey() {
  if (paymentConfig.key) return paymentConfig.key;
  try {
    const response = await fetch(`${apiBaseUrl}/api/payments/config`);
    if (!response.ok) return "";
    const data = await response.json();
    if (data && data.keyId) {
      paymentConfig.key = data.keyId;
    }
  } catch (_error) {
    // Silent fallback: /create-order will still return a key.
  }
  return paymentConfig.key;
}

// Fallback only — the server is authoritative and returns the active plan's
// limit on every /me response (currentUser.replyLimit / remainingReplies).
const FREE_REPLY_LIMIT = 20;

function getApiBaseUrl() {
  const hostname = window.location.hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return "http://localhost:3000";
  }

  return "https://ai-auto-reply-tool.onrender.com";
}

const apiBaseUrl = getApiBaseUrl();
const pageQuery = new URLSearchParams(window.location.search);
const widgetMode = pageQuery.get("widget") === "1";
const publicWorkspaceIdFromQuery = pageQuery.get("workspace") || "";
let authToken = localStorage.getItem("authToken") || "";
let currentUser = null;
let historyData = [];
let leadsData = [];
let notificationsData = [];
let followupLogs = [];
let bookingData = [];
let crmConfig = null;
let voiceSessions = [];
let authSessionId = 0;
let loginAttemptId = 0;
let chatbotSessionId = localStorage.getItem("chatbotSessionId") || "";
let chatbotMessages = [];
let chatbotConfig = {
  title: "Website Chatbot",
  quickReplies: [
    "Pricing details chahiye",
    "Demo book karna hai",
    "WhatsApp setup kaise hota hai?",
    "Mujhe contact karo",
  ],
};

function setLandingStatus(message) {
  const authStatus = document.getElementById("auth-status");
  if (authStatus) {
    authStatus.innerText = message;
  }
}

function setAppStatus(message) {
  const appStatus = document.getElementById("app-status");
  if (appStatus) {
    appStatus.innerText = message;
  }
}

// Upgrade status helper: writes to whichever status banner is currently
// visible (landing #auth-status when signed-out / on the pricing section,
// dashboard #app-status when inside the app). This guarantees users see
// payment / checkout messages no matter which page they are on.
function setUpgradeStatus(message) {
  const text = String(message || "");
  setLandingStatus(text);
  setAppStatus(text);
  if (text) {
    console.log("[upgrade]", text);
  }
}

function setChatbotStatus(message) {
  const chatbotStatus = document.getElementById("chatbot-status");
  if (chatbotStatus) {
    chatbotStatus.innerText = message;
  }
}

function setWhatsAppStatus(message) {
  const whatsappStatus = document.getElementById("whatsapp-status");
  if (whatsappStatus) {
    whatsappStatus.innerText = message;
  }
}

function setInstagramStatus(message) {
  const instagramStatus = document.getElementById("instagram-status");
  if (instagramStatus) {
    instagramStatus.innerText = message;
  }
}

function setBookingStatus(message) {
  const bookingStatus = document.getElementById("booking-status");
  if (bookingStatus) {
    bookingStatus.innerText = message;
  }
}

function setCrmStatus(message) {
  const crmStatus = document.getElementById("crm-status");
  if (crmStatus) {
    crmStatus.innerText = message;
  }
}

function setVoiceStatus(message) {
  const voiceStatus = document.getElementById("voice-status");
  if (voiceStatus) {
    voiceStatus.innerText = message;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCurrentSessionId() {
  return authSessionId;
}

function isCurrentSession(sessionId) {
  return sessionId === authSessionId;
}

function normalizeChannel(channel) {
  const normalized = String(channel || "").trim().toLowerCase();
  if (normalized === "whatsapp") return "whatsapp";
  if (normalized === "instagram") return "instagram";
  return "website";
}

function getChannelLabel(channel) {
  const normalized = normalizeChannel(channel);
  if (normalized === "whatsapp") return "WhatsApp";
  if (normalized === "instagram") return "Instagram";
  return "Website Chatbot";
}

function getLeadSourceLabel(source) {
  const value = String(source || "").trim();
  if (!value) {
    return "Not specified";
  }

  const normalized = value.toLowerCase();
  if (normalized === "website") return "Website Chatbot";
  if (normalized === "whatsapp") return "WhatsApp";
  if (normalized === "manual") return "Manual Entry";
  return value;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleString();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not available";
  }

  return date.toLocaleDateString();
}

function formatInputDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function truncateText(value, maxLength = 120) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function clearHistoryFiltersInputs() {
  const searchInput = document.getElementById("history-search");
  const dateInput = document.getElementById("history-date");
  const channelInput = document.getElementById("history-channel");
  if (searchInput) searchInput.value = "";
  if (dateInput) dateInput.value = "";
  if (channelInput) channelInput.value = "";
}

function clearWorkspaceInputs() {
  const elementIds = [
    "lead-name",
    "lead-contact",
    "lead-interest",
    "lead-notes",
    "business",
    "message",
    "current-password",
    "new-password",
    "followup-template",
    "instagram-recipient-id",
    "instagram-message",
    "booking-date",
    "booking-time",
    "booking-customer-name",
    "booking-customer-contact",
    "booking-note",
    "crm-webhook-url",
    "crm-api-key",
    "voice-transcript",
  ];

  elementIds.forEach((id) => {
    const element = document.getElementById(id);
    if (element) {
      element.value = "";
    }
  });

  const leadSource = document.getElementById("lead-source");
  const leadStatus = document.getElementById("lead-status");
  const channel = document.getElementById("conversation-channel");

  if (channel) {
    channel.value = "website";
  }
  if (leadSource) {
    leadSource.value = "website";
  }
  if (leadStatus) {
    leadStatus.value = "New";
  }
  const replyLanguage = document.getElementById("reply-language");
  const replyTone = document.getElementById("reply-tone");
  const replyFormality = document.getElementById("reply-formality");
  const followupEnabled = document.getElementById("followup-enabled");
  const followupDelayHours = document.getElementById("followup-delay-hours");
  const followupMaxAttempts = document.getElementById("followup-max-attempts");
  if (replyLanguage) replyLanguage.value = "auto";
  if (replyTone) replyTone.value = "professional";
  if (replyFormality) replyFormality.value = "neutral";
  if (followupEnabled) followupEnabled.value = "true";
  if (followupDelayHours) followupDelayHours.value = "24";
  if (followupMaxAttempts) followupMaxAttempts.value = "2";

  updateReplyContextChip();
}

function resetAppState() {
  historyData = [];
  leadsData = [];
  notificationsData = [];
  followupLogs = [];
  bookingData = [];
  crmConfig = null;
  voiceSessions = [];
  currentUser = null;

  const output = document.getElementById("output");
  const salesSuggestionOutput = document.getElementById("sales-suggestion-output");
  const historyList = document.getElementById("history-list");
  const profileSummary = document.getElementById("profile-summary");
  const automationSummary = document.getElementById("automation-summary");
  const leadList = document.getElementById("lead-list");
  const analyticsSummary = document.getElementById("analytics-summary");
  const analyticsCards = document.getElementById("analytics-cards");
  const channelHealth = document.getElementById("channel-health");
  const whatsappStatus = document.getElementById("whatsapp-status");
  const instagramStatus = document.getElementById("instagram-status");
  const bookingStatus = document.getElementById("booking-status");
  const crmStatus = document.getElementById("crm-status");
  const voiceStatus = document.getElementById("voice-status");
  const widgetSummary = document.getElementById("widget-summary");
  const notificationList = document.getElementById("notification-list");
  const notificationListProfile = document.getElementById("notification-list-profile");
  const followupLogList = document.getElementById("followup-log-list");
  const bookingSlotList = document.getElementById("booking-slot-list");
  const bookingList = document.getElementById("booking-list");
  const voiceSessionList = document.getElementById("voice-session-list");

  if (output) output.innerText = "";
  if (salesSuggestionOutput) salesSuggestionOutput.innerText = "";
  if (historyList) historyList.innerHTML = "";
  if (profileSummary) profileSummary.innerHTML = "";
  if (automationSummary) automationSummary.innerHTML = "";
  if (leadList) leadList.innerHTML = "";
  if (analyticsSummary) analyticsSummary.innerHTML = "";
  if (analyticsCards) analyticsCards.innerHTML = "";
  if (channelHealth) channelHealth.innerHTML = "";
  if (whatsappStatus) whatsappStatus.innerText = "";
  if (instagramStatus) instagramStatus.innerText = "";
  if (bookingStatus) bookingStatus.innerText = "";
  if (crmStatus) crmStatus.innerText = "";
  if (voiceStatus) voiceStatus.innerText = "";
  if (widgetSummary) widgetSummary.innerHTML = "";
  if (notificationList) notificationList.innerHTML = "";
  if (notificationListProfile) notificationListProfile.innerHTML = "";
  if (followupLogList) followupLogList.innerHTML = "";
  if (bookingSlotList) bookingSlotList.innerHTML = "";
  if (bookingList) bookingList.innerHTML = "";
  if (voiceSessionList) voiceSessionList.innerHTML = "";

  clearHistoryFiltersInputs();
  clearWorkspaceInputs();
}

function applyAuthenticatedSession(token, user = null) {
  authSessionId += 1;
  authToken = token;
  currentUser = user;

  if (token) {
    localStorage.setItem("authToken", token);
  } else {
    localStorage.removeItem("authToken");
  }

  return authSessionId;
}

function showLanding() {
  document.getElementById("landing-page").classList.remove("hidden");
  document.getElementById("app-page").classList.add("hidden");
}

function showApp() {
  document.getElementById("landing-page").classList.add("hidden");
  document.getElementById("app-page").classList.remove("hidden");
}

function showPricingPlans() {
  const landingPage = document.getElementById("landing-page");
  const appPage = document.getElementById("app-page");
  const pricingSection = document.getElementById("pricing");

  if (landingPage) {
    landingPage.classList.remove("hidden");
  }
  if (appPage) {
    appPage.classList.add("hidden");
  }

  window.location.hash = "pricing";
  pricingSection?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setVisibleView(viewId) {
  const views = document.querySelectorAll(".view");
  views.forEach((view) => view.classList.add("hidden"));
  document.getElementById(viewId).classList.remove("hidden");
}

function showView(viewId) {
  setVisibleView(viewId);

  if (viewId === "dashboard-view") {
    refreshWorkspace();
  }

  if (viewId === "history-view") {
    loadHistory();
  }

  if (viewId === "profile-view") {
    loadProfile();
  }
}

async function apiRequest(path, options = {}, requiresAuth = false) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };

  if (requiresAuth && authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function getUserLanguageContext() {
  const locale = typeof navigator !== "undefined" ? navigator.language || "" : "";
  const languages = typeof navigator !== "undefined" && Array.isArray(navigator.languages)
    ? navigator.languages.filter(Boolean).slice(0, 5)
    : [];

  return { locale, languages };
}

function getActiveWorkspaceId() {
  return publicWorkspaceIdFromQuery || currentUser?.publicWorkspaceId || "";
}

function getChatbotVisitorPayload() {
  return {
    name: document.getElementById("chatbot-name")?.value.trim() || "",
    contact: document.getElementById("chatbot-contact")?.value.trim() || "",
    interest: document.getElementById("chatbot-interest")?.value.trim() || "",
  };
}

function getLeadPayload() {
  return {
    channel: normalizeChannel(document.getElementById("conversation-channel")?.value),
    name: document.getElementById("lead-name")?.value.trim() || "",
    contact: document.getElementById("lead-contact")?.value.trim() || "",
    source: document.getElementById("lead-source")?.value || "",
    interest: document.getElementById("lead-interest")?.value.trim() || "",
    status: document.getElementById("lead-status")?.value || "New",
    notes: document.getElementById("lead-notes")?.value.trim() || "",
  };
}

function getIntegrationStatus() {
  return currentUser?.integrationStatus || {};
}

function getChatbotSessionId() {
  if (!chatbotSessionId) {
    chatbotSessionId = localStorage.getItem("chatbotSessionId") || `chat-${Date.now()}`;
    localStorage.setItem("chatbotSessionId", chatbotSessionId);
  }

  return chatbotSessionId;
}

function updateChatbotSessionId(nextSessionId) {
  if (!nextSessionId) {
    return;
  }

  chatbotSessionId = nextSessionId;
  localStorage.setItem("chatbotSessionId", chatbotSessionId);
}

function ensureChatbotWelcomeMessage() {
  if (chatbotMessages.length) {
    return;
  }

  chatbotMessages = [
    {
      role: "bot",
      text: chatbotConfig.welcomeMessage || "Hello! Main aapke questions answer kar sakta hoon aur aapka lead save kar sakta hoon. Apna message bhejiye.",
    },
  ];
}

function renderChatbotMessages() {
  const container = document.getElementById("chatbot-messages");
  if (!container) {
    return;
  }

  ensureChatbotWelcomeMessage();
  container.innerHTML = chatbotMessages
    .map((item) => `
      <article class="chatbot-bubble chatbot-bubble-${escapeHtml(item.role)}">
        <span>${escapeHtml(item.role === "bot" ? "Bot" : "You")}</span>
        <p>${escapeHtml(item.text)}</p>
      </article>
    `)
    .join("");

  container.scrollTop = container.scrollHeight;
}

function renderChatbotQuickReplies() {
  const container = document.getElementById("chatbot-quick-replies");
  if (!container) {
    return;
  }

  container.innerHTML = (chatbotConfig.quickReplies || [])
    .map((reply) => `
      <button type="button" class="ghost-btn quick-reply-btn" data-quick-reply="${escapeHtml(reply)}">
        ${escapeHtml(reply)}
      </button>
    `)
    .join("");

  container.querySelectorAll("[data-quick-reply]").forEach((button) => {
    button.addEventListener("click", () => {
      sendChatbotMessage(button.getAttribute("data-quick-reply") || "");
    });
  });
}

function appendChatbotMessage(role, text) {
  chatbotMessages.push({ role, text });
  renderChatbotMessages();
}

function toggleChatbot(forceState) {
  const widget = document.getElementById("chatbot-widget");
  if (!widget) {
    return;
  }

  const shouldOpen = typeof forceState === "boolean"
    ? forceState
    : widget.classList.contains("hidden");

  widget.classList.toggle("hidden", !shouldOpen);

  if (shouldOpen) {
    ensureChatbotWelcomeMessage();
    renderChatbotMessages();
    renderChatbotQuickReplies();
    loadChatbotConfig();
    document.getElementById("chatbot-input")?.focus();
  }
}

function getBusinessProfilePayload() {
  return {
    brandName: document.getElementById("business-brand-name")?.value.trim() || "",
    businessType: document.getElementById("business-type")?.value.trim() || "",
    tagline: document.getElementById("business-tagline")?.value.trim() || "",
    description: document.getElementById("business-description")?.value.trim() || "",
    offerSummary: document.getElementById("business-offer-summary")?.value.trim() || "",
    location: document.getElementById("business-location")?.value.trim() || "",
    websiteUrl: document.getElementById("business-website-url")?.value.trim() || "",
    supportEmail: document.getElementById("business-support-email")?.value.trim() || "",
    supportPhone: document.getElementById("business-support-phone")?.value.trim() || "",
    tone: document.getElementById("business-tone")?.value.trim() || "",
    welcomeMessage: document.getElementById("business-welcome-message")?.value.trim() || "",
    leadPrompt: document.getElementById("business-lead-prompt")?.value.trim() || "",
    primaryGoal: document.getElementById("business-primary-goal")?.value.trim() || "",
    quickReplies: document.getElementById("business-quick-replies")?.value.trim() || "",
  };
}

function getReplyPreferencesPayload() {
  return {
    targetLanguage: document.getElementById("reply-language")?.value || "auto",
    tone: document.getElementById("reply-tone")?.value || "professional",
    formality: document.getElementById("reply-formality")?.value || "neutral",
  };
}

function getFollowupRulesPayload() {
  return {
    rules: [
      {
        id: "whatsapp-no-reply-24h",
        channel: "whatsapp",
        enabled: document.getElementById("followup-enabled")?.value === "true",
        delayHours: Number(document.getElementById("followup-delay-hours")?.value || 24),
        maxAttempts: Number(document.getElementById("followup-max-attempts")?.value || 2),
        template: document.getElementById("followup-template")?.value.trim()
          || "Hi {{name}}, bas follow-up kar raha hoon. Kya aapko abhi bhi details chahiye?",
      },
    ],
  };
}

function fillFollowupRuleForm() {
  const firstRule = (currentUser?.followupRules || [])[0];
  if (!firstRule) {
    return;
  }

  const enabled = document.getElementById("followup-enabled");
  const delayHours = document.getElementById("followup-delay-hours");
  const maxAttempts = document.getElementById("followup-max-attempts");
  const template = document.getElementById("followup-template");
  if (enabled) enabled.value = firstRule.enabled ? "true" : "false";
  if (delayHours) delayHours.value = String(firstRule.delayHours || 24);
  if (maxAttempts) maxAttempts.value = String(firstRule.maxAttempts || 2);
  if (template) template.value = firstRule.template || "";
}

function renderFollowupLogs() {
  const container = document.getElementById("followup-log-list");
  if (!container) {
    return;
  }

  if (!followupLogs.length) {
    container.innerHTML = "<p>No follow-up activity yet.</p>";
    return;
  }

  container.innerHTML = followupLogs
    .slice(0, 6)
    .map((log) => `
      <article class="history-item">
        <div class="tag-row">
          <span class="tag">${escapeHtml(String(log.status || "pending").toUpperCase())}</span>
          <span class="tag">${escapeHtml(formatDateTime(log.createdAt))}</span>
        </div>
        <p><strong>${escapeHtml(log.leadName || "Lead")}</strong> (${escapeHtml(log.leadContact || "No contact")})</p>
        <p>${escapeHtml(log.message || "")}</p>
      </article>
    `)
    .join("");
}

function renderBookingList() {
  const container = document.getElementById("booking-list");
  if (!container) {
    return;
  }

  if (!bookingData.length) {
    container.innerHTML = "<p>No appointments yet.</p>";
    return;
  }

  container.innerHTML = bookingData
    .slice(0, 8)
    .map((item) => `
      <article class="history-item">
        <div class="tag-row">
          <span class="tag">${escapeHtml(item.date || "")}</span>
          <span class="tag">${escapeHtml(item.time || "")}</span>
          <span class="tag">${escapeHtml(item.status || "Confirmed")}</span>
        </div>
        <p><strong>${escapeHtml(item.customerName || "Customer")}</strong></p>
        <p>${escapeHtml(item.customerContact || "")}</p>
        <p>${escapeHtml(item.note || "")}</p>
      </article>
    `)
    .join("");
}

function fillCrmForm() {
  const provider = document.getElementById("crm-provider");
  const webhookUrl = document.getElementById("crm-webhook-url");
  const apiKey = document.getElementById("crm-api-key");
  const enabled = document.getElementById("crm-enabled");
  if (provider) provider.value = crmConfig?.provider || "none";
  if (webhookUrl) webhookUrl.value = crmConfig?.webhookUrl || "";
  if (apiKey) apiKey.value = crmConfig?.apiKey || "";
  if (enabled) enabled.value = crmConfig?.enabled ? "true" : "false";
}

function renderVoiceSessions() {
  const container = document.getElementById("voice-session-list");
  if (!container) {
    return;
  }

  if (!voiceSessions.length) {
    container.innerHTML = "<p>No voice sessions yet.</p>";
    return;
  }

  container.innerHTML = voiceSessions
    .slice(0, 6)
    .map((item) => `
      <article class="history-item">
        <div class="tag-row">
          <span class="tag">${escapeHtml(getChannelLabel(item.channel))}</span>
          <span class="tag">${escapeHtml(item.language || "auto")}</span>
          <span class="tag">${escapeHtml(formatDateTime(item.createdAt))}</span>
        </div>
        <p><strong>Transcript:</strong> ${escapeHtml(item.transcript || "")}</p>
        <p><strong>AI Reply:</strong> ${escapeHtml(item.reply || "")}</p>
      </article>
    `)
    .join("");
}

function fillBusinessProfileForm(profile = {}) {
  const fields = {
    "business-brand-name": profile.brandName || "",
    "business-type": profile.businessType || "",
    "business-tagline": profile.tagline || "",
    "business-description": profile.description || "",
    "business-offer-summary": profile.offerSummary || "",
    "business-location": profile.location || "",
    "business-website-url": profile.websiteUrl || "",
    "business-support-email": profile.supportEmail || "",
    "business-support-phone": profile.supportPhone || "",
    "business-tone": profile.tone || "",
    "business-welcome-message": profile.welcomeMessage || "",
    "business-lead-prompt": profile.leadPrompt || "",
    "business-primary-goal": profile.primaryGoal || "",
    "business-quick-replies": Array.isArray(profile.quickReplies) ? profile.quickReplies.join(", ") : "",
  };

  Object.entries(fields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) {
      element.value = value;
    }
  });
}

function renderNotifications() {
  const containers = [
    document.getElementById("notification-list"),
    document.getElementById("notification-list-profile"),
  ].filter(Boolean);

  if (!containers.length) {
    return;
  }

  const html = notificationsData.length
    ? notificationsData
      .slice(0, 8)
      .map((item) => `
        <article class="notification-item ${item.read ? "notification-read" : "notification-unread"}">
          <div class="lead-card-header">
            <div>
              <h3>${escapeHtml(item.title || "New activity")}</h3>
              <p>${escapeHtml(item.message || "")}</p>
            </div>
            <span class="status-badge">${escapeHtml(item.read ? "Read" : "Unread")}</span>
          </div>
          <div class="tag-row">
            ${item.leadName ? `<span class="tag">${escapeHtml(item.leadName)}</span>` : ""}
            ${item.leadContact ? `<span class="tag">${escapeHtml(item.leadContact)}</span>` : ""}
            <span class="tag">${escapeHtml(formatDateTime(item.createdAt))}</span>
          </div>
        </article>
      `)
      .join("")
    : "<p>No notifications yet. New interested leads will appear here.</p>";

  containers.forEach((container) => {
    container.innerHTML = html;
  });
}

function renderWidgetSummary() {
  const summary = document.getElementById("widget-summary");
  const embed = document.getElementById("widget-embed-code");
  if (!summary || !embed) {
    return;
  }

  const workspaceId = currentUser?.publicWorkspaceId || "";
  const origin = window.location.origin;
  const widgetScriptUrl = `${origin}/widget.js`;
  const embedCode = workspaceId
    ? `<script>
  window.aiToolConfig = {
    businessId: "${workspaceId}"
  };
</script>
<script src="${widgetScriptUrl}"></script>`
    : "Save your business profile first to generate the widget snippet.";

  summary.innerHTML = buildSummaryLines([
    { label: "Workspace ID", value: workspaceId || "Not available" },
    { label: "Widget Script", value: widgetScriptUrl },
    { label: "Unread Notifications", value: String(currentUser?.unreadNotificationCount || 0) },
  ]);

  embed.value = embedCode;
}

function updateReplyContextChip() {
  const chip = document.getElementById("reply-context-chip");
  if (!chip) {
    return;
  }

  const channel = document.getElementById("conversation-channel")?.value || "website";
  chip.innerText = getChannelLabel(channel);
}

function syncLeadSourceToChannel() {
  const channel = normalizeChannel(document.getElementById("conversation-channel")?.value);
  const sourceSelect = document.getElementById("lead-source");
  if (!sourceSelect) {
    return;
  }

  if (!sourceSelect.value || sourceSelect.value === "website" || sourceSelect.value === "whatsapp" || sourceSelect.value === "instagram") {
    sourceSelect.value = channel;
  }

  updateReplyContextChip();
}

function buildSummaryLines(lines) {
  return lines
    .map((line) => `<div class="summary-line"><strong>${escapeHtml(line.label)}</strong><span>${escapeHtml(line.value)}</span></div>`)
    .join("");
}

function computeAnalytics() {
  const totalLeads = leadsData.length;
  const totalReplies = historyData.length;
  const autoReplies = historyData.filter((item) => String(item.automationMode || "").toLowerCase() === "auto").length;
  const websiteReplies = historyData.filter((item) => normalizeChannel(item.channel) === "website").length;
  const whatsappReplies = historyData.filter((item) => normalizeChannel(item.channel) === "whatsapp").length;
  const activeLeads = leadsData.filter((lead) => !["Won", "Lost"].includes(String(lead.status || ""))).length;
  const wonLeads = leadsData.filter((lead) => String(lead.status || "") === "Won").length;
  const qualifiedLeads = leadsData.filter((lead) => ["Qualified", "Follow-up"].includes(String(lead.status || ""))).length;
  const repliesLast7Days = historyData.filter((item) => {
    const createdTime = new Date(item.createdAt).getTime();
    return Number.isFinite(createdTime) && createdTime >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  }).length;

  return {
    totalLeads,
    totalReplies,
    autoReplies,
    websiteReplies,
    whatsappReplies,
    activeLeads,
    wonLeads,
    qualifiedLeads,
    repliesLast7Days,
    automationCoverage: totalReplies ? Math.round((autoReplies / totalReplies) * 100) : 0,
  };
}

function renderAnalyticsCards() {
  const container = document.getElementById("analytics-cards");
  if (!container) {
    return;
  }

  const analytics = computeAnalytics();
  const remainingReplies = currentUser?.premium
    ? "Unlimited"
    : `${currentUser?.remainingReplies ?? FREE_REPLY_LIMIT} left`;
  const currentPlan = currentUser?.planName || "Free";

  const cards = [
    {
      label: "Total Leads",
      value: analytics.totalLeads,
      note: `${analytics.activeLeads} active in pipeline`,
    },
    {
      label: "AI Replies",
      value: analytics.totalReplies,
      note: `${analytics.repliesLast7Days} sent in the last 7 days`,
    },
    {
      label: "Automation",
      value: `${analytics.automationCoverage}%`,
      note: `${analytics.websiteReplies} website and ${analytics.whatsappReplies} WhatsApp replies`,
    },
    {
      label: `${currentPlan} Plan`,
      value: remainingReplies,
      note: currentUser?.premium ? "Premium workspace active" : "Free quota before upgrade",
    },
  ];

  container.innerHTML = cards
    .map((card) => `
      <article class="metric-card">
        <span class="metric-label">${escapeHtml(card.label)}</span>
        <strong class="metric-value">${escapeHtml(card.value)}</strong>
        <span class="metric-note">${escapeHtml(card.note)}</span>
      </article>
    `)
    .join("");
}

function renderAnalyticsSummary() {
  const container = document.getElementById("analytics-summary");
  if (!container) {
    return;
  }

  const analytics = computeAnalytics();
  const integrationStatus = getIntegrationStatus();
  container.innerHTML = buildSummaryLines([
    { label: "Qualified Leads", value: String(analytics.qualifiedLeads) },
    { label: "Won Leads", value: String(analytics.wonLeads) },
    { label: "Website Replies", value: String(analytics.websiteReplies) },
    { label: "WhatsApp Replies", value: String(analytics.whatsappReplies) },
    { label: "Firebase Storage", value: integrationStatus.firebaseReady ? "Ready" : "Not configured" },
    { label: "WhatsApp Cloud API", value: integrationStatus.whatsappConfigured ? "Configured" : "Pending setup" },
    { label: "Instagram DM API", value: integrationStatus.instagramConfigured ? "Configured" : "Pending setup" },
    { label: "Connected Channels", value: currentUser?.connectedChannels?.join(", ") || "Website, WhatsApp" },
    { label: "Reply Usage", value: currentUser?.premium ? "Unlimited" : `${currentUser?.usage || 0}/${currentUser?.replyLimit || FREE_REPLY_LIMIT}` },
  ]);
}

function renderChannelHealth() {
  const container = document.getElementById("channel-health");
  if (!container) {
    return;
  }

  const analytics = computeAnalytics();
  const integrationStatus = getIntegrationStatus();
  const modules = [
    {
      label: "Website Chatbot",
      detail: `${analytics.websiteReplies} website conversations tracked`,
      active: true,
    },
    {
      label: "Firebase Lead Storage",
      detail: integrationStatus.firebaseReady
        ? `${analytics.totalLeads} leads available in the admin pipeline`
        : "Add Firebase credentials to enable shared lead storage",
      active: Boolean(integrationStatus.firebaseReady),
    },
    {
      label: "Admin Dashboard",
      detail: `${analytics.qualifiedLeads} qualified or follow-up leads ready for action`,
      active: true,
    },
    {
      label: "WhatsApp Integration",
      detail: integrationStatus.whatsappConfigured
        ? `${analytics.whatsappReplies} WhatsApp reply activities tracked`
        : "Configure Meta phone number ID and access token",
      active: Boolean(integrationStatus.whatsappConfigured),
    },
    {
      label: "Instagram DM Integration",
      detail: integrationStatus.instagramConfigured
        ? "Instagram webhook and DM API ready"
        : "Configure Instagram business account ID and access token",
      active: Boolean(integrationStatus.instagramConfigured),
    },
  ];

  container.innerHTML = modules
    .map((item) => `
      <div class="channel-status-card">
        <div>
          <strong>${escapeHtml(item.label)}</strong>
          <p>${escapeHtml(item.detail)}</p>
        </div>
        <span class="status-badge">${item.active ? "Active" : "Off"}</span>
      </div>
    `)
    .join("");
}

function renderLeadList(items = leadsData) {
  const leadList = document.getElementById("lead-list");
  if (!leadList) {
    return;
  }

  const inboxScope = document.getElementById("inbox-scope")?.value || "all";
  const mineEmail = String(currentUser?.email || "").trim().toLowerCase();
  const scopedItems = items.filter((lead) => {
    const assignedTo = String(lead?.assignedTo || "").trim().toLowerCase();
    if (inboxScope === "mine") {
      return Boolean(mineEmail && assignedTo && assignedTo === mineEmail);
    }
    if (inboxScope === "unassigned") {
      return !assignedTo;
    }
    return true;
  });

  if (!scopedItems.length) {
    leadList.innerHTML = "<p>No leads captured yet. Save a lead from the dashboard form to start the pipeline.</p>";
    return;
  }

  leadList.innerHTML = scopedItems
    .slice(0, 6)
    .map((lead) => {
      const contactLine = lead.contact ? `<p>${escapeHtml(lead.contact)}</p>` : "";
      const notesLine = lead.notes ? `<p>${escapeHtml(truncateText(lead.notes, 88))}</p>` : "";
      const routeLabel = lead.lastChannel ? getChannelLabel(lead.lastChannel) : "Manual Routing";
      const assignee = String(lead.assignedTo || "").trim();
      const assignmentLine = `
        <div class="history-filters">
          <select id="lead-assignee-${escapeHtml(lead.id)}">
            <option value="">Unassigned</option>
            <option value="${escapeHtml(currentUser?.email || "")}" ${assignee.toLowerCase() === String(currentUser?.email || "").toLowerCase() ? "selected" : ""}>${escapeHtml(currentUser?.email || "Me")}</option>
          </select>
          <button type="button" class="ghost-btn" onclick="assignLead('${escapeHtml(lead.id)}')">Assign</button>
        </div>
      `;

      return `
        <article class="lead-card">
          <div class="lead-card-header">
            <div>
              <h3>${escapeHtml(lead.name || "Unnamed Lead")}</h3>
              <p>${escapeHtml(lead.interest || "General inquiry")}</p>
            </div>
            <span class="status-badge">${escapeHtml(lead.status || "New")}</span>
          </div>
          <div class="tag-row">
            <span class="tag">${escapeHtml(getLeadSourceLabel(lead.source))}</span>
            <span class="tag">${escapeHtml(routeLabel)}</span>
            <span class="tag">${escapeHtml(formatDate(lead.lastActivityAt || lead.updatedAt || lead.createdAt))}</span>
            <span class="tag">${escapeHtml(assignee ? `Assigned: ${assignee}` : "Unassigned")}</span>
          </div>
          ${contactLine}
          ${notesLine}
          ${assignmentLine}
        </article>
      `;
    })
    .join("");
}

function applyInboxFilters() {
  renderLeadList(leadsData);
}

function renderProfileSummary() {
  const profileSummary = document.getElementById("profile-summary");
  if (!profileSummary) {
    return;
  }

  if (!currentUser) {
    profileSummary.innerHTML = "<p>Profile details will appear after login.</p>";
    return;
  }

  const subscriptionStatus = currentUser.subscriptionStatus
    ? `${currentUser.subscriptionStatus}${currentUser.subscriptionCancelAtCycleEnd ? " (cancels at cycle end)" : ""}`
    : "None";

  profileSummary.innerHTML = buildSummaryLines([
    { label: "Email", value: currentUser.email || "Not available" },
    { label: "Workspace ID", value: currentUser.publicWorkspaceId || "Not available" },
    { label: "Workspace Storage", value: getIntegrationStatus().databaseMode === "local-json" ? "Local JSON (dev mode)" : "MongoDB" },
    { label: "Plan", value: currentUser.planName || "Free" },
    { label: "Premium Status", value: currentUser.premium ? "Active" : "Inactive" },
    { label: "Subscription", value: subscriptionStatus },
    { label: "Usage Count", value: String(currentUser.usage || 0) },
    { label: "Remaining Replies", value: currentUser.premium && (currentUser.replyLimit === null || currentUser.replyLimit === undefined) ? "Unlimited" : String(currentUser.remainingReplies ?? FREE_REPLY_LIMIT) },
    { label: "Lead Count", value: String(currentUser.leadCount || 0) },
    { label: "Unread Notifications", value: String(currentUser.unreadNotificationCount || 0) },
    { label: "Premium Activated", value: formatDateTime(currentUser.premiumActivatedAt) },
    { label: "Premium Expires", value: formatDate(currentUser.premiumExpiresAt) },
  ]);

  const subscriptionActions = document.getElementById("subscription-actions");
  if (subscriptionActions) {
    const canCancel = Boolean(currentUser.subscriptionId)
      && !currentUser.subscriptionCancelAtCycleEnd
      && !["cancelled", "completed", "expired", "halted"].includes(String(currentUser.subscriptionStatus || "").toLowerCase());
    subscriptionActions.innerHTML = canCancel
      ? '<button type="button" class="ghost-btn" onclick="cancelSubscription()">Cancel Subscription</button>'
      : "";
  }
}

function renderAutomationSummary() {
  const automationSummary = document.getElementById("automation-summary");
  if (!automationSummary) {
    return;
  }

  if (!currentUser) {
    automationSummary.innerHTML = "<p>Automation modules will appear after login.</p>";
    return;
  }

  const settings = currentUser?.automationSettings || {};
  const integrationStatus = getIntegrationStatus();
  automationSummary.innerHTML = buildSummaryLines([
    { label: "Website Chatbot", value: settings.websiteChatbot === false ? "Disabled" : "Enabled" },
    { label: "WhatsApp Assistant", value: settings.whatsappAssistant === false ? "Disabled" : "Enabled" },
    { label: "Lead Capture", value: settings.leadCapture === false ? "Disabled" : "Enabled" },
    { label: "Analytics Dashboard", value: settings.analyticsDashboard === false ? "Disabled" : "Enabled" },
    { label: "Workspace Storage", value: integrationStatus.databaseMode === "local-json" ? "Local JSON (dev mode)" : "MongoDB" },
    { label: "Firebase Status", value: integrationStatus.firebaseReady ? "Connected" : "Not configured" },
    { label: "WhatsApp Webhook", value: integrationStatus.whatsappWebhookConfigured ? "Configured" : "Pending" },
    { label: "WhatsApp Auto Reply", value: integrationStatus.whatsappAutoReplyEnabled ? "Enabled" : "Manual mode" },
    { label: "Instagram Webhook", value: integrationStatus.instagramWebhookConfigured ? "Configured" : "Pending" },
    { label: "Instagram Auto Reply", value: integrationStatus.instagramAutoReplyEnabled ? "Enabled" : "Manual mode" },
    { label: "Channels", value: currentUser?.connectedChannels?.join(", ") || "Website, WhatsApp" },
  ]);
}

function renderDashboardSurface() {
  renderAnalyticsCards();
  renderAnalyticsSummary();
  renderChannelHealth();
  renderLeadList();
  renderProfileSummary();
  renderAutomationSummary();
  fillBusinessProfileForm(currentUser?.businessProfile || {});
  renderWidgetSummary();
  renderNotifications();
  renderFollowupLogs();
  renderBookingList();
  fillCrmForm();
  renderVoiceSessions();
  fillFollowupRuleForm();
  updateReplyContextChip();
}

function renderHistory(items) {
  const historyList = document.getElementById("history-list");
  if (!historyList) {
    return;
  }

  if (!items.length) {
    historyList.innerHTML = "<p>No conversations found for the selected filters.</p>";
    return;
  }

  historyList.innerHTML = items
    .map((item) => {
      const businessLine = item.business ? `<p><strong>Business:</strong> ${escapeHtml(item.business)}</p>` : "";
      const leadLine = item.leadName ? `<p><strong>Lead:</strong> ${escapeHtml(item.leadName)}</p>` : "";
      const sourceLine = item.leadSource ? `<span class="tag">${escapeHtml(getLeadSourceLabel(item.leadSource))}</span>` : "";

      return `
        <article class="history-item">
          <div class="history-meta">
            <div class="tag-row">
              <span class="tag">${escapeHtml(getChannelLabel(item.channel))}</span>
              ${sourceLine}
              <span class="tag">${escapeHtml((item.automationMode || "auto").toUpperCase())}</span>
              ${item.language ? `<span class="tag">${escapeHtml(String(item.language).toUpperCase())}</span>` : ""}
            </div>
            <small>${escapeHtml(formatDateTime(item.createdAt))}</small>
          </div>
          ${leadLine}
          <p><strong>Message:</strong> ${escapeHtml(item.message || "")}</p>
          ${businessLine}
          <p><strong>Reply:</strong> ${escapeHtml(item.reply || "")}</p>
        </article>
      `;
    })
    .join("");
}

function applyHistoryFilters() {
  const search = document.getElementById("history-search")?.value.trim().toLowerCase() || "";
  const selectedDate = document.getElementById("history-date")?.value || "";
  const selectedChannel = normalizeChannel(document.getElementById("history-channel")?.value || "") || "";

  const filtered = historyData.filter((item) => {
    const haystack = [
      item.message,
      item.reply,
      item.business,
      item.leadName,
      item.leadSource,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");

    const textMatch = !search || haystack.includes(search);
    const itemDate = formatInputDate(item.createdAt);
    const dateMatch = !selectedDate || itemDate === selectedDate;
    const channelMatch = !document.getElementById("history-channel")?.value
      || normalizeChannel(item.channel) === selectedChannel;

    return textMatch && dateMatch && channelMatch;
  });

  renderHistory(filtered);
}

function clearHistoryFilters() {
  clearHistoryFiltersInputs();
  renderHistory(historyData);
}

async function signup() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    const { data, response } = await apiRequest("/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!response?.ok) {
      console.error("Signup error:", data);
    }
    setLandingStatus(data.message || "Signup completed");
  } catch (err) {
    console.error("Signup exception:", err);
    setLandingStatus("Signup failed (network or CORS error)");
  }
}

async function login() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const attemptId = ++loginAttemptId;

  try {
    const { response, data } = await apiRequest("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (attemptId !== loginAttemptId) {
      return;
    }
    if (!response.ok || !data.token) {
      console.error("Login error:", data);
      setLandingStatus(data.message || "Login failed");
      return;
    }

    const sessionId = applyAuthenticatedSession(data.token, data.user || null);
    resetAppState();
    showApp();
    setVisibleView("dashboard-view");
    await refreshWorkspace(sessionId);
    if (!isCurrentSession(sessionId)) {
      return;
    }
    setAppStatus("Login successful.");
  } catch (err) {
    if (attemptId !== loginAttemptId) {
      return;
    }
    console.error("Login exception:", err);
    setLandingStatus("Login failed (network or CORS error)");
  }
}

function logout() {
  applyAuthenticatedSession("", null);
  resetAppState();
  showLanding();
  setLandingStatus("Logged out successfully.");
  setAppStatus("");
}

async function loadProfile(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/me", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    setAppStatus(data.message || "Failed to load profile.");
    return false;
  }

  currentUser = data.user;
  if (render) {
    renderDashboardSurface();
  }
  return true;
}

async function loadNotifications(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/notifications", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    notificationsData = [];
    if (render) {
      renderNotifications();
    }
    return false;
  }

  notificationsData = data.notifications || [];
  if (render) {
    renderNotifications();
    renderDashboardSurface();
  }
  return true;
}

async function loadHistory(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/history", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    historyData = [];
    if (render) {
      renderHistory([]);
      renderDashboardSurface();
    }
    setAppStatus(data.message || "Failed to load history.");
    return false;
  }

  historyData = data.history || [];
  if (render) {
    applyHistoryFilters();
    renderDashboardSurface();
  }
  return true;
}

async function loadLeads(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/leads", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    leadsData = [];
    if (render) {
      renderLeadList([]);
      renderDashboardSurface();
    }
    setAppStatus(data.message || "Failed to load leads.");
    return false;
  }

  leadsData = data.leads || [];
  if (render) {
    renderLeadList(leadsData);
    renderDashboardSurface();
  }
  return true;
}

async function loadFollowupLogs(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/api/followups/logs", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    followupLogs = [];
    if (render) {
      renderFollowupLogs();
    }
    return false;
  }

  followupLogs = data.logs || [];
  if (render) {
    renderFollowupLogs();
  }
  return true;
}

async function loadBookingList(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/api/booking/list", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    bookingData = [];
    if (render) renderBookingList();
    return false;
  }

  bookingData = data.appointments || [];
  if (render) renderBookingList();
  return true;
}

async function loadCrmConfig(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/api/crm/config", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    crmConfig = null;
    if (render) fillCrmForm();
    return false;
  }

  crmConfig = data.config || null;
  if (render) fillCrmForm();
  return true;
}

async function loadVoiceSessions(sessionId = getCurrentSessionId(), options = {}) {
  const { render = true } = options;
  const { response, data } = await apiRequest("/api/voice/sessions", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return false;
  }

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return false;
    }
    voiceSessions = [];
    if (render) renderVoiceSessions();
    return false;
  }

  voiceSessions = data.sessions || [];
  if (render) renderVoiceSessions();
  return true;
}

async function refreshWorkspace(sessionId = getCurrentSessionId()) {
  await Promise.all([
    loadProfile(sessionId, { render: false }),
    loadHistory(sessionId, { render: false }),
    loadLeads(sessionId, { render: false }),
    loadNotifications(sessionId, { render: false }),
    loadFollowupLogs(sessionId, { render: false }),
    loadBookingList(sessionId, { render: false }),
    loadCrmConfig(sessionId, { render: false }),
    loadVoiceSessions(sessionId, { render: false }),
  ]);
  if (!isCurrentSession(sessionId)) {
    return;
  }
  applyHistoryFilters();
  renderDashboardSurface();
}

async function captureLead() {
  const leadPayload = getLeadPayload();
  if (!leadPayload.name && !leadPayload.contact && !leadPayload.interest) {
    setAppStatus("Add lead name, contact, or interest before saving the lead.");
    return;
  }

  const { response, data } = await apiRequest(
    "/leads",
    {
      method: "POST",
      body: JSON.stringify(leadPayload),
    },
    true
  );

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return;
    }
    setAppStatus(data.message || "Failed to save lead.");
    return;
  }

  leadsData = data.leads || [];
  renderLeadList(leadsData);
  renderDashboardSurface();
  await loadProfile();
  setAppStatus(data.message || "Lead saved successfully.");
}

async function assignLead(leadId) {
  const lead = leadsData.find((item) => String(item.id) === String(leadId));
  if (!lead) {
    setAppStatus("Lead not found for assignment.");
    return;
  }

  const assigneeInput = document.getElementById(`lead-assignee-${leadId}`);
  const assignedTo = assigneeInput?.value?.trim() || "";

  const payload = {
    channel: lead.lastChannel || "website",
    name: lead.name || "",
    contact: lead.contact || "",
    source: lead.source || "",
    interest: lead.interest || "",
    status: lead.status || "New",
    notes: lead.notes || "",
    assignedTo,
  };

  const { response, data } = await apiRequest(
    "/leads",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setAppStatus(data.message || "Failed to assign lead.");
    return;
  }

  leadsData = data.leads || [];
  renderLeadList(leadsData);
  setAppStatus(assignedTo ? `Lead assigned to ${assignedTo}.` : "Lead marked as unassigned.");
}

async function loadChatbotConfig() {
  try {
    const workspaceId = getActiveWorkspaceId();
    const path = workspaceId
      ? `/api/chatbot/config?workspace=${encodeURIComponent(workspaceId)}`
      : "/api/chatbot/config";
    const { response, data } = await apiRequest(path, { method: "GET" });
    if (!response.ok) {
      return;
    }

    chatbotConfig = {
      ...chatbotConfig,
      ...data,
    };

    const title = document.getElementById("chatbot-title");
    if (title) {
      title.innerText = chatbotConfig.title || "Website Chatbot";
    }

    if (chatbotMessages.length === 1 && chatbotMessages[0]?.role === "bot") {
      chatbotMessages[0].text = chatbotConfig.welcomeMessage || chatbotMessages[0].text;
      renderChatbotMessages();
    }

    renderChatbotQuickReplies();
  } catch (_error) {
    // Keep local defaults if config is unavailable.
  }
}

async function sendChatbotMessage(prefilledMessage = "") {
  const input = document.getElementById("chatbot-input");
  const text = String(prefilledMessage || input?.value || "").trim();
  if (!text) {
    setChatbotStatus("Apna message type kijiye.");
    return;
  }

  appendChatbotMessage("visitor", text);
  if (input && !prefilledMessage) {
    input.value = "";
  }

  setChatbotStatus("Reply generate ho raha hai...");

  const { locale, languages } = getUserLanguageContext();
  const { response, data } = await apiRequest("/api/chatbot/message", {
    method: "POST",
    body: JSON.stringify({
      message: text,
      sessionId: getChatbotSessionId(),
      workspaceId: getActiveWorkspaceId(),
      visitor: getChatbotVisitorPayload(),
      locale,
      languages,
    }),
  });

  if (!response.ok) {
    setChatbotStatus(data.message || "Chatbot abhi unavailable hai.");
    appendChatbotMessage("bot", "Sorry, abhi reply generate nahi ho pa raha. Please thodi der baad try kijiye.");
    return;
  }

  updateChatbotSessionId(data.sessionId);
  appendChatbotMessage("bot", data.reply || "Thank you! Hum aapse jaldi connect karenge.");
  if (data.leadSaved && data.ownerNotified) {
    setChatbotStatus("Reply shown, lead saved, and owner notified.");
  } else if (data.leadSaved) {
    setChatbotStatus("Reply shown and lead saved.");
  } else if (data.firebaseReady) {
    setChatbotStatus("Reply shown to customer.");
  } else {
    setChatbotStatus("Reply shown. Lead save system abhi fully configured nahi hai.");
  }
}

async function saveBusinessProfile() {
  const payload = getBusinessProfilePayload();
  const { response, data } = await apiRequest(
    "/business-profile",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setAppStatus(data.message || "Failed to save business profile.");
    return;
  }

  await loadProfile();
  await loadChatbotConfig();
  setAppStatus(data.message || "Business profile saved successfully.");
}

async function generateReply() {
  const business = document.getElementById("business").value.trim();
  const message = document.getElementById("message").value.trim();
  const channel = normalizeChannel(document.getElementById("conversation-channel")?.value);
  const lead = getLeadPayload();
  const replyPreferences = getReplyPreferencesPayload();
  const { locale, languages } = getUserLanguageContext();

  if (!message) {
    setAppStatus("Please enter the incoming customer message.");
    return;
  }

  const { response, data } = await apiRequest(
    "/api/reply",
    {
      method: "POST",
      body: JSON.stringify({ business, message, locale, languages, channel, lead, ...replyPreferences }),
    },
    true
  );

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return;
    }
    setAppStatus(data.reply || data.message || "Failed to generate reply.");
    return;
  }

  document.getElementById("output").innerText = data.reply || "No reply generated.";
  setAppStatus("Reply generated and workspace activity updated.");
  await refreshWorkspace();
}

async function generateSalesSuggestion() {
  const lead = getLeadPayload();
  const message = document.getElementById("message")?.value.trim() || "";
  const output = document.getElementById("sales-suggestion-output");

  if (output) {
    output.innerText = "Generating sales closer suggestion...";
  }

  const { response, data } = await apiRequest(
    "/api/sales/next-best-action",
    {
      method: "POST",
      body: JSON.stringify({ lead, message }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    if (output) {
      output.innerText = data.message || "Failed to generate sales suggestion.";
    }
    return;
  }

  const content = [
    `Lead Score: ${data.score} (${data.band})`,
    `Next Action: ${data.nextAction}`,
    "",
    `Draft: ${data.draft}`,
  ].join("\n");

  if (output) {
    output.innerText = content;
  }
}

async function sendWhatsAppMessage() {
  const to = document.getElementById("whatsapp-to")?.value.trim() || "";
  const message = document.getElementById("whatsapp-message")?.value.trim() || "";
  const leadName = document.getElementById("lead-name")?.value.trim() || "";
  const leadContact = document.getElementById("lead-contact")?.value.trim() || "";
  const leadSource = document.getElementById("lead-source")?.value || "WhatsApp";

  if (!message) {
    setWhatsAppStatus("WhatsApp message likhiye.");
    return;
  }

  setWhatsAppStatus("WhatsApp message bheja ja raha hai...");
  const { response, data } = await apiRequest(
    "/api/whatsapp/send",
    {
      method: "POST",
      body: JSON.stringify({
        to: to || leadContact,
        message,
        leadName,
        leadContact: to || leadContact,
        leadSource,
      }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setWhatsAppStatus(data.message || "WhatsApp send failed.");
    return;
  }

  setWhatsAppStatus("WhatsApp message sent successfully.");
  await refreshWorkspace();
}

async function sendInstagramMessage() {
  const recipientId = document.getElementById("instagram-recipient-id")?.value.trim() || "";
  const message = document.getElementById("instagram-message")?.value.trim() || "";
  const leadName = document.getElementById("lead-name")?.value.trim() || "Instagram Lead";

  if (!recipientId || !message) {
    setInstagramStatus("Recipient ID aur message dono required hain.");
    return;
  }

  setInstagramStatus("Instagram DM bheja ja raha hai...");
  const { response, data } = await apiRequest(
    "/api/instagram/send",
    {
      method: "POST",
      body: JSON.stringify({ recipientId, message, leadName }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setInstagramStatus(data.message || "Instagram DM send failed.");
    return;
  }

  setInstagramStatus(data.message || "Instagram DM sent successfully.");
  await refreshWorkspace();
}

async function sendInstagramQuickTest() {
  const recipientIdInput = document.getElementById("instagram-recipient-id");
  const messageInput = document.getElementById("instagram-message");
  const recipientId = recipientIdInput?.value.trim() || "";

  if (!recipientId) {
    setInstagramStatus("Quick test ke liye recipient ID daaliye.");
    return;
  }

  if (messageInput && !messageInput.value.trim()) {
    messageInput.value = "Hi! This is a quick test DM from ReplyPilot Instagram integration.";
  }

  await sendInstagramMessage();
}

async function loadBookingSlots() {
  const bookingDate = document.getElementById("booking-date")?.value || "";
  const slotList = document.getElementById("booking-slot-list");
  if (!bookingDate) {
    setBookingStatus("Date select kijiye.");
    return;
  }

  const { response, data } = await apiRequest(`/api/booking/slots?date=${encodeURIComponent(bookingDate)}`, { method: "GET" }, true);
  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setBookingStatus(data.message || "Slots load failed.");
    return;
  }

  const slots = data.slots || [];
  if (slotList) {
    slotList.innerHTML = slots.length
      ? slots.map((slot) => `<button type="button" class="ghost-btn" onclick="selectBookingTime('${escapeHtml(slot.time)}')">${escapeHtml(slot.time)}</button>`).join(" ")
      : "<p>No slots available on selected date.</p>";
  }
  setBookingStatus(`Available slots loaded for ${bookingDate}.`);
}

function selectBookingTime(time) {
  const bookingTime = document.getElementById("booking-time");
  if (bookingTime) {
    bookingTime.value = time;
  }
}

async function confirmAppointmentBooking() {
  const payload = {
    date: document.getElementById("booking-date")?.value || "",
    time: document.getElementById("booking-time")?.value.trim() || "",
    customerName: document.getElementById("booking-customer-name")?.value.trim() || "",
    customerContact: document.getElementById("booking-customer-contact")?.value.trim() || "",
    note: document.getElementById("booking-note")?.value.trim() || "",
    source: "Dashboard Booking",
  };

  if (!payload.date || !payload.time) {
    setBookingStatus("Date aur time required hain.");
    return;
  }

  const { response, data } = await apiRequest(
    "/api/booking/confirm",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setBookingStatus(data.message || "Appointment booking failed.");
    return;
  }

  bookingData = data.appointments || bookingData;
  renderBookingList();
  setBookingStatus(data.message || "Appointment confirmed.");
}

async function saveCrmConfig() {
  const payload = {
    provider: document.getElementById("crm-provider")?.value || "none",
    webhookUrl: document.getElementById("crm-webhook-url")?.value.trim() || "",
    apiKey: document.getElementById("crm-api-key")?.value.trim() || "",
    enabled: document.getElementById("crm-enabled")?.value === "true",
  };

  const { response, data } = await apiRequest(
    "/api/crm/config",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setCrmStatus(data.message || "Failed to save CRM config.");
    return;
  }

  crmConfig = data.config || payload;
  fillCrmForm();
  setCrmStatus(data.message || "CRM config saved.");
}

async function syncLeadsToCrm() {
  setCrmStatus("Sync in progress...");
  const { response, data } = await apiRequest(
    "/api/crm/sync-leads",
    { method: "POST" },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setCrmStatus(data.message || "CRM sync failed.");
    return;
  }

  setCrmStatus(`${data.message} Synced ${data.synced}/${data.total}, Failed ${data.failed}.`);
}

async function processVoiceSession() {
  const transcript = document.getElementById("voice-transcript")?.value.trim() || "";
  const language = document.getElementById("voice-language")?.value || "auto";
  const channel = normalizeChannel(document.getElementById("conversation-channel")?.value || "website");
  const lead = getLeadPayload();

  if (!transcript) {
    setVoiceStatus("Voice transcript required hai.");
    return;
  }

  setVoiceStatus("Voice session process ho raha hai...");
  const { response, data } = await apiRequest(
    "/api/voice/session",
    {
      method: "POST",
      body: JSON.stringify({ transcript, language, channel, lead }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setVoiceStatus(data.message || "Voice session failed.");
    return;
  }

  if (data?.session) {
    voiceSessions = [data.session, ...voiceSessions].slice(0, 20);
    renderVoiceSessions();
    const output = document.getElementById("output");
    if (output) {
      output.innerText = data.session.reply || "";
    }
  }
  setVoiceStatus(data.message || "Voice session processed.");
}

async function saveFollowupRules() {
  const payload = getFollowupRulesPayload();
  const { response, data } = await apiRequest(
    "/api/followups/rules",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setWhatsAppStatus(data.message || "Failed to save follow-up rules.");
    return;
  }

  if (currentUser) {
    currentUser.followupRules = data.rules || [];
  }
  fillFollowupRuleForm();
  setWhatsAppStatus(data.message || "Follow-up rules saved.");
}

async function markNotificationsRead() {
  const { response, data } = await apiRequest(
    "/notifications/read-all",
    { method: "POST" },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  if (!response.ok) {
    setAppStatus(data.message || "Failed to mark notifications as read.");
    return;
  }

  notificationsData = data.notifications || [];
  renderNotifications();
  await loadProfile();
  setAppStatus(data.message || "Notifications updated.");
}

async function changePassword() {
  const currentPassword = document.getElementById("current-password").value;
  const newPassword = document.getElementById("new-password").value;

  const { response, data } = await apiRequest(
    "/change-password",
    {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  setAppStatus(data.message || "Password update request sent.");
  if (response.ok) {
    document.getElementById("current-password").value = "";
    document.getElementById("new-password").value = "";
  }
}

async function verifyPayment(paymentResponse) {
  const { response, data } = await apiRequest(
    "/verify-payment",
    {
      method: "POST",
      body: JSON.stringify({
        razorpay_order_id: paymentResponse.razorpay_order_id,
        razorpay_payment_id: paymentResponse.razorpay_payment_id,
        razorpay_signature: paymentResponse.razorpay_signature,
      }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  setAppStatus(data.message || "Premium updated");
  await refreshWorkspace();
}

// Plan-aware upgrade entry point used by every "Upgrade to <Plan>" button.
// Tries true auto-debit subscription first; if the server tells us the plan
// has no Razorpay plan id configured, transparently falls back to a one-time
// monthly order so the upgrade button still works.
async function upgradeToPlan(planId) {
  if (!planId || planId === "free") {
    setUpgradeStatus("You are already on the Free plan. Sign up to start using it.");
    window.location.hash = "contact";
    return;
  }

  if (!authToken) {
    setUpgradeStatus("Login first to upgrade your account.");
    window.location.hash = "contact";
    return;
  }

  if (!window.Razorpay) {
    setUpgradeStatus("Razorpay SDK not loaded. Refresh the page and try again.");
    return;
  }

  setUpgradeStatus(`Opening secure Razorpay checkout for the ${planId} plan...`);
  try {
    const startedSubscription = await createSubscriptionAndOpenCheckout(planId);
    if (!startedSubscription) {
      await createOrderAndOpenCheckout(planId);
    }
  } catch (error) {
    console.error("[upgrade] checkout failed", error);
    setUpgradeStatus("Unable to open payment checkout. Please try again in a moment.");
  }
}

async function upgradeToPremium() {
  return upgradeToPlan("starter");
}

// Returns true if the subscription checkout was opened (or auth failed and we
// already redirected). Returns false whenever recurring billing is not
// available for any reason (endpoint missing on an older backend, plan id not
// configured, network glitch, etc.) so the caller can fall back to the
// one-time order flow without the user noticing.
async function createSubscriptionAndOpenCheckout(planId) {
  await ensurePaymentKey();

  let response;
  let data;
  try {
    const result = await apiRequest(
      "/create-subscription",
      {
        method: "POST",
        body: JSON.stringify({ planId }),
      },
      true
    );
    response = result.response;
    data = result.data;
  } catch (_error) {
    return false;
  }

  if (response.status === 401) {
    logout();
    return true;
  }

  if (!response.ok || !data?.subscriptionId) {
    return false;
  }

  const checkoutKey = data.key || paymentConfig.key;
  if (!checkoutKey) {
    setUpgradeStatus("Payment key not configured. Please contact support.");
    return true;
  }

  const options = {
    key: checkoutKey,
    subscription_id: data.subscriptionId,
    name: "ReplyPilot",
    description: `${data.planName || "Premium"} plan (auto-debit, monthly)`,
    handler: async function handler(paymentResponse) {
      await verifySubscription(paymentResponse);
    },
    theme: {
      color: "#34d3a4",
    },
  };

  const razorpayInstance = new window.Razorpay(options);
  razorpayInstance.open();
  return true;
}

async function verifySubscription(paymentResponse) {
  const { response, data } = await apiRequest(
    "/verify-subscription",
    {
      method: "POST",
      body: JSON.stringify({
        razorpay_payment_id: paymentResponse.razorpay_payment_id,
        razorpay_subscription_id: paymentResponse.razorpay_subscription_id,
        razorpay_signature: paymentResponse.razorpay_signature,
      }),
    },
    true
  );

  if (response.status === 401) {
    logout();
    return;
  }

  setAppStatus(data?.message || "Subscription updated.");
  await refreshWorkspace();
}

async function cancelSubscription() {
  if (!authToken) return;
  if (!window.confirm("Cancel your subscription at the end of the current billing cycle?")) return;
  const { response, data } = await apiRequest("/cancel-subscription", { method: "POST", body: JSON.stringify({}) }, true);
  if (response.status === 401) {
    logout();
    return;
  }
  setAppStatus(data?.message || "Subscription update requested.");
  await refreshWorkspace();
}

async function createOrderAndOpenCheckout(planId) {
  await ensurePaymentKey();

  const { response, data } = await apiRequest(
    "/create-order",
    {
      method: "POST",
      body: JSON.stringify({ planId }),
    },
    true
  );

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return;
    }
    setUpgradeStatus(data.message || "Unable to create order.");
    return;
  }

  const checkoutKey = data.key || paymentConfig.key;
  if (!checkoutKey) {
    setUpgradeStatus("Payment key not configured. Please contact support.");
    return;
  }

  const options = {
    key: checkoutKey,
    amount: data.amount,
    currency: data.currency,
    order_id: data.orderId,
    name: "ReplyPilot",
    description: `${data.planName || "Premium"} plan (one-time monthly)`,
    handler: async function handler(paymentResponse) {
      await verifyPayment(paymentResponse);
    },
    theme: {
      color: "#34d3a4",
    },
  };

  const razorpayInstance = new window.Razorpay(options);
  razorpayInstance.open();
}

function bindWorkspaceControls() {
  const channelSelect = document.getElementById("conversation-channel");
  if (channelSelect) {
    channelSelect.addEventListener("change", syncLeadSourceToChannel);
  }

  const chatbotInput = document.getElementById("chatbot-input");
  if (chatbotInput) {
    chatbotInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendChatbotMessage();
      }
    });
  }

  syncLeadSourceToChannel();
  renderDashboardSurface();
  ensureChatbotWelcomeMessage();
  renderChatbotMessages();
  renderChatbotQuickReplies();
}

function applyWidgetMode() {
  if (!widgetMode) {
    return;
  }

  document.body.classList.add("widget-mode");
  document.getElementById("landing-page")?.classList.add("hidden");
  document.getElementById("app-page")?.classList.add("hidden");
  document.getElementById("chatbot-launcher")?.classList.add("hidden");
  document.querySelector(".footer-note")?.classList.add("hidden");
  toggleChatbot(true);
}

async function bootstrap() {
  applyWidgetMode();
  if (widgetMode) {
    resetAppState();
    applyWidgetMode();
    await loadChatbotConfig();
    return;
  }

  if (!authToken) {
    resetAppState();
    showLanding();
    return;
  }

  const sessionId = getCurrentSessionId();
  resetAppState();
  const { response } = await apiRequest("/me", { method: "GET" }, true);
  if (!isCurrentSession(sessionId)) {
    return;
  }
  if (!response.ok) {
    logout();
    return;
  }

  showApp();
  setVisibleView("dashboard-view");
  await refreshWorkspace(sessionId);
}

bindWorkspaceControls();
loadChatbotConfig();
bootstrap();
