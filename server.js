const express = require("express");
const cors = require("cors");
const compression = require("compression");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const { initializeApp: initializeFirebaseApp, cert, applicationDefault, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const Razorpay = require("razorpay");
require("dotenv").config();

const app = express();
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const ENABLE_REQUEST_LOGS = /^(1|true|yes)$/i.test(process.env.ENABLE_REQUEST_LOGS || "true");
const GLOBAL_RATE_LIMIT_WINDOW_MS = Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 120;
const SENSITIVE_RATE_LIMIT_WINDOW_MS = Number(process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS) || 60 * 1000;
const SENSITIVE_RATE_LIMIT_MAX = Number(process.env.SENSITIVE_RATE_LIMIT_MAX) || 30;

function logInfo(message, meta = {}) {
  if (!ENABLE_REQUEST_LOGS) return;
  console.log(`[INFO] ${message}`, Object.keys(meta).length ? meta : "");
}

function logError(message, meta = {}) {
  console.error(`[ERROR] ${message}`, Object.keys(meta).length ? meta : "");
}

function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs, maxRequests }) {
  const store = new Map();
  return function rateLimiter(req, res, next) {
    const key = `${getRequestIp(req)}:${req.path}`;
    const now = Date.now();
    const bucket = store.get(key) || { count: 0, start: now };
    if (now - bucket.start > windowMs) {
      bucket.count = 0;
      bucket.start = now;
    }
    bucket.count += 1;
    store.set(key, bucket);
    if (bucket.count > maxRequests) {
      return res.status(429).json({ message: "Too many requests. Please try again shortly." });
    }
    next();
  };
}

const globalRateLimiter = createRateLimiter({
  windowMs: GLOBAL_RATE_LIMIT_WINDOW_MS,
  maxRequests: GLOBAL_RATE_LIMIT_MAX,
});
const sensitiveRateLimiter = createRateLimiter({
  windowMs: SENSITIVE_RATE_LIMIT_WINDOW_MS,
  maxRequests: SENSITIVE_RATE_LIMIT_MAX,
});

app.set("trust proxy", 1);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || !CORS_ALLOWED_ORIGINS.length || CORS_ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Blocked by CORS policy"));
  },
}));
app.use(compression());
app.use(express.json());
app.use(globalRateLimiter);
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.set("x-request-id", requestId);
  res.on("finish", () => {
    logInfo("request", {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
});
const whatsappWebhookJsonParser = express.json({
  verify: (req, _res, buffer) => {
    req.rawBody = buffer.toString("utf8");
  },
});
app.use(express.static(path.join(__dirname, "frontend")));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    databaseMode,
    mongoReady: isDatabaseReady(),
    firestoreReady: isFirestoreReady(),
    timestamp: new Date().toISOString(),
  });
});

const paymentConfig = {
  key_id: process.env.KEY_ID || "YOUR_KEY_ID",
  key_secret: process.env.KEY_SECRET || "YOUR_KEY_SECRET",
};

// Keep supporting the old env name so existing deployments don't silently break.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINIAI_API_KEY || "";
const GEMINI_API_URL = process.env.GEMINI_API_URL || "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS = (process.env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.0-flash,gemini-flash-latest")
  .split(",")
  .map((model) => model.trim().replace(/^models\//, ""))
  .filter(Boolean);
const GEMINI_API_AUTH_MODE = process.env.GEMINI_API_AUTH_MODE || "header";
const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 4000;

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret";
const APP_WORKSPACE_ID = process.env.APP_WORKSPACE_ID || "replypilot-main";
const CHATBOT_TITLE = process.env.CHATBOT_TITLE || "ReplyPilot Assistant";
const CHATBOT_BUSINESS_CONTEXT = process.env.CHATBOT_BUSINESS_CONTEXT
  || "You are the website chatbot assistant for a business using ReplyPilot. Help visitors clearly, answer their questions professionally, and encourage them to share their name and contact details when useful.";
const WHATSAPP_GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v22.0";
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
const WHATSAPP_AUTO_REPLY_ENABLED = /^(1|true|yes)$/i.test(process.env.WHATSAPP_AUTO_REPLY_ENABLED || "false");
const WHATSAPP_BUSINESS_CONTEXT = process.env.WHATSAPP_BUSINESS_CONTEXT || CHATBOT_BUSINESS_CONTEXT;
const INSTAGRAM_BUSINESS_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";
const INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN || "";
const INSTAGRAM_WEBHOOK_VERIFY_TOKEN = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || WHATSAPP_WEBHOOK_VERIFY_TOKEN;
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || WHATSAPP_APP_SECRET;
const INSTAGRAM_AUTO_REPLY_ENABLED = /^(1|true|yes)$/i.test(process.env.INSTAGRAM_AUTO_REPLY_ENABLED || "false");
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY || "";
const MONGO_SERVER_SELECTION_TIMEOUT_MS = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 2000;

const premiumPlan = {
  amount: 19900,
  currency: "INR",
};
const FREE_REPLY_LIMIT = 5;
const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
  websiteChatbot: true,
  whatsappAssistant: true,
  leadCapture: true,
  analyticsDashboard: true,
});
const DEFAULT_FOLLOWUP_RULES = Object.freeze([
  {
    id: "whatsapp-no-reply-24h",
    enabled: true,
    delayHours: 24,
    maxAttempts: 2,
    channel: "whatsapp",
    template: "Hi {{name}}, bas follow-up kar raha hoon. Kya aapko abhi bhi details chahiye?",
  },
]);
const FOLLOWUP_RUN_INTERVAL_MS = Number(process.env.FOLLOWUP_RUN_INTERVAL_MS) || 10 * 60 * 1000;
const DEFAULT_BUSINESS_PROFILE = Object.freeze({
  brandName: "ReplyPilot Workspace",
  businessType: "",
  tagline: "",
  description: "",
  offerSummary: "",
  location: "",
  websiteUrl: "",
  supportEmail: "",
  supportPhone: "",
  tone: "Professional, polite, and helpful",
  welcomeMessage: "Hello! How can we help you today?",
  leadPrompt: "Please share your name and contact details so our team can help you further.",
  primaryGoal: "Capture leads and answer customer questions quickly",
  quickReplies: [
    "Pricing details chahiye",
    "Demo book karna hai",
    "Mujhe contact karo",
  ],
});

const razorpay = new Razorpay({
  key_id: paymentConfig.key_id,
  key_secret: paymentConfig.key_secret,
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || "ai_auto_reply";
const LOCAL_DB_DIR = path.join(__dirname, ".data");
const LOCAL_USERS_FILE = path.join(LOCAL_DB_DIR, "users.local.json");
let mongoClient = null;
let usersCollection = null;
let firestoreDb = null;
let databaseMode = "mongo";

const isDatabaseReady = () => Boolean(usersCollection);
const isFirestoreReady = () => Boolean(firestoreDb);

class AiReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiReplyError";
  }
}

async function connectDatabase() {
  try {
    mongoClient = createMongoClientWithFallback(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(MONGO_DB_NAME);
    usersCollection = db.collection("users");
    databaseMode = "mongo";

    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await usersCollection.createIndex({ publicWorkspaceId: 1 }, { unique: true, sparse: true });
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    enableLocalDatabaseFallback(error.message);
  }
}

function createMongoClientWithFallback(uri) {
  try {
    return new MongoClient(uri, {
      serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
      connectTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
    });
  } catch (error) {
    console.error("MongoDB URI parse failed:", error.message);

    if (uri !== "mongodb://127.0.0.1:27017") {
      console.error("Falling back to mongodb://127.0.0.1:27017");
      return new MongoClient("mongodb://127.0.0.1:27017", {
        serverSelectionTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
        connectTimeoutMS: MONGO_SERVER_SELECTION_TIMEOUT_MS,
      });
    }

    throw error;
  }
}

function ensureLocalDbStorage() {
  if (!fs.existsSync(LOCAL_DB_DIR)) {
    fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
  }

  if (!fs.existsSync(LOCAL_USERS_FILE)) {
    fs.writeFileSync(LOCAL_USERS_FILE, JSON.stringify({ users: [] }, null, 2));
  }
}

function cloneLocalValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function readLocalUsers() {
  ensureLocalDbStorage();

  try {
    const raw = fs.readFileSync(LOCAL_USERS_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch (error) {
    console.error("Local user store read failed:", error.message);
    return [];
  }
}

function writeLocalUsers(users) {
  ensureLocalDbStorage();
  fs.writeFileSync(
    LOCAL_USERS_FILE,
    JSON.stringify({ users: Array.isArray(users) ? users : [] }, null, 2)
  );
}

function normalizeLookupValue(value) {
  if (value === undefined || value === null) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object" && typeof value.toString === "function") {
    const normalized = value.toString();
    return normalized === "[object Object]" ? value : normalized;
  }

  return value;
}

function matchesLocalFilter(document, filter = {}) {
  return Object.entries(filter).every(([key, expectedValue]) => {
    return normalizeLookupValue(document?.[key]) === normalizeLookupValue(expectedValue);
  });
}

function applyLocalProjection(document, projection) {
  if (!projection || typeof projection !== "object") {
    return cloneLocalValue(document);
  }

  const includeKeys = Object.entries(projection)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => key);

  if (!includeKeys.length) {
    return cloneLocalValue(document);
  }

  const projected = { _id: cloneLocalValue(document?._id) };
  includeKeys.forEach((key) => {
    if (key in document) {
      projected[key] = cloneLocalValue(document[key]);
    }
  });
  return projected;
}

function applyLocalUpdate(document, update = {}) {
  const nextDocument = cloneLocalValue(document) || {};

  if (update.$set && typeof update.$set === "object") {
    Object.entries(update.$set).forEach(([key, value]) => {
      nextDocument[key] = cloneLocalValue(value);
    });
  }

  if (update.$inc && typeof update.$inc === "object") {
    Object.entries(update.$inc).forEach(([key, amount]) => {
      nextDocument[key] = Number(nextDocument[key] || 0) + Number(amount || 0);
    });
  }

  if (update.$unset && typeof update.$unset === "object") {
    Object.keys(update.$unset).forEach((key) => {
      delete nextDocument[key];
    });
  }

  if (update.$push && typeof update.$push === "object") {
    Object.entries(update.$push).forEach(([key, pushValue]) => {
      const currentItems = Array.isArray(nextDocument[key]) ? nextDocument[key].slice() : [];

      if (pushValue && typeof pushValue === "object" && Array.isArray(pushValue.$each)) {
        const eachItems = cloneLocalValue(pushValue.$each);
        const position = Number.isInteger(pushValue.$position) ? pushValue.$position : currentItems.length;
        currentItems.splice(position, 0, ...eachItems);

        if (Number.isInteger(pushValue.$slice)) {
          const sliceSize = pushValue.$slice;
          nextDocument[key] = sliceSize >= 0 ? currentItems.slice(0, sliceSize) : currentItems.slice(sliceSize);
          return;
        }

        nextDocument[key] = currentItems;
        return;
      }

      currentItems.push(cloneLocalValue(pushValue));
      nextDocument[key] = currentItems;
    });
  }

  return nextDocument;
}

function createLocalUsersCollection() {
  return {
    async createIndex() {
      return null;
    },
    async findOne(filter = {}, options = {}) {
      const users = readLocalUsers();
      const user = users.find((entry) => matchesLocalFilter(entry, filter));
      return user ? applyLocalProjection(user, options.projection) : null;
    },
    async insertOne(document) {
      const users = readLocalUsers();
      const nextDocument = {
        ...cloneLocalValue(document),
        _id: document?._id || crypto.randomUUID(),
      };
      users.push(nextDocument);
      writeLocalUsers(users);
      return { acknowledged: true, insertedId: nextDocument._id };
    },
    async updateOne(filter = {}, update = {}) {
      const users = readLocalUsers();
      const index = users.findIndex((entry) => matchesLocalFilter(entry, filter));
      if (index < 0) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }

      users[index] = applyLocalUpdate(users[index], update);
      writeLocalUsers(users);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
  };
}

function enableLocalDatabaseFallback(reason = "") {
  usersCollection = createLocalUsersCollection();
  databaseMode = "local-json";
  console.log(`Using local JSON user store${reason ? ` (${reason})` : ""}`);
}

function getUserLookupId(userId) {
  const normalizedId = String(userId || "").trim();
  if (!normalizedId) {
    return normalizedId;
  }

  return ObjectId.isValid(normalizedId) ? new ObjectId(normalizedId) : normalizedId;
}

function normalizeFirebasePrivateKey(privateKey) {
  return String(privateKey || "").replace(/\\n/g, "\n").trim();
}

function getFirebaseCredentialConfig() {
  if (FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: parsed.project_id,
          clientEmail: parsed.client_email,
          privateKey: parsed.private_key,
        };
      }
    } catch (error) {
      console.error("Firebase service account JSON parse failed:", error.message);
    }
  }

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    return {
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: normalizeFirebasePrivateKey(FIREBASE_PRIVATE_KEY),
    };
  }

  return null;
}

function connectFirestore() {
  try {
    const existingApp = getApps()[0];
    const credentialConfig = getFirebaseCredentialConfig();

    if (!existingApp && !credentialConfig && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.log("Firestore not configured. Firebase lead storage disabled.");
      firestoreDb = null;
      return;
    }

    const firebaseApp = existingApp || initializeFirebaseApp(
      credentialConfig
        ? {
          credential: cert({
            projectId: credentialConfig.projectId,
            clientEmail: credentialConfig.clientEmail,
            privateKey: credentialConfig.privateKey,
          }),
        }
        : {
          credential: applicationDefault(),
        }
    );

    firestoreDb = getFirestore(firebaseApp);
    console.log("Firestore connected");
  } catch (error) {
    firestoreDb = null;
    console.error("Firestore init failed:", error.message);
  }
}

connectDatabase();
connectFirestore();

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

function getUserIdFromToken(req) {
  try {
    const token = getBearerToken(req);
    if (!token) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.id;
  } catch (_error) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const userId = getUserIdFromToken(req);
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  res.set("Cache-Control", "no-store, private, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Vary", "Authorization");
  req.authUserId = userId;
  next();
}

function getAutomationSettings(user) {
  const userSettings = user && typeof user.automationSettings === "object" && user.automationSettings
    ? user.automationSettings
    : {};

  return {
    ...DEFAULT_AUTOMATION_SETTINGS,
    ...userSettings,
  };
}

function getLeadPipeline(user) {
  return Array.isArray(user?.leadPipeline) ? user.leadPipeline : [];
}

function getUserNotifications(user) {
  return Array.isArray(user?.notifications) ? user.notifications : [];
}

function getUserAppointments(user) {
  return Array.isArray(user?.appointments) ? user.appointments : [];
}

function getUserCrmConfig(user) {
  const raw = user && typeof user.crmConfig === "object" ? user.crmConfig : {};
  return {
    provider: String(raw.provider || "none").trim().toLowerCase(),
    webhookUrl: String(raw.webhookUrl || "").trim(),
    apiKey: String(raw.apiKey || "").trim(),
    enabled: Boolean(raw.enabled),
    fieldMapping: raw.fieldMapping && typeof raw.fieldMapping === "object"
      ? raw.fieldMapping
      : {
        name: "name",
        contact: "contact",
        interest: "interest",
        source: "source",
        status: "status",
      },
  };
}

function getUserVoiceSessions(user) {
  return Array.isArray(user?.voiceSessions) ? user.voiceSessions : [];
}

function buildDailySlots(dateText, appointments = []) {
  const date = String(dateText || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return [];
  }

  const slots = [];
  for (let hour = 10; hour <= 18; hour += 1) {
    for (const minute of [0, 30]) {
      if (hour === 18 && minute > 0) {
        continue;
      }
      const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      slots.push(time);
    }
  }

  const bookedSet = new Set(
    appointments
      .filter((item) => String(item?.date || "") === date)
      .map((item) => String(item?.time || ""))
  );

  return slots
    .map((time) => ({ time, available: !bookedSet.has(time) }))
    .filter((slot) => slot.available);
}

function normalizeQuickReplies(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  return DEFAULT_BUSINESS_PROFILE.quickReplies.slice();
}

function normalizeBusinessProfile(profile = {}) {
  const merged = {
    ...DEFAULT_BUSINESS_PROFILE,
    ...(profile && typeof profile === "object" ? profile : {}),
  };

  return {
    brandName: String(merged.brandName || DEFAULT_BUSINESS_PROFILE.brandName).trim() || DEFAULT_BUSINESS_PROFILE.brandName,
    businessType: String(merged.businessType || "").trim(),
    tagline: String(merged.tagline || "").trim(),
    description: String(merged.description || "").trim(),
    offerSummary: String(merged.offerSummary || "").trim(),
    location: String(merged.location || "").trim(),
    websiteUrl: String(merged.websiteUrl || "").trim(),
    supportEmail: String(merged.supportEmail || "").trim(),
    supportPhone: String(merged.supportPhone || "").trim(),
    tone: String(merged.tone || DEFAULT_BUSINESS_PROFILE.tone).trim() || DEFAULT_BUSINESS_PROFILE.tone,
    welcomeMessage: String(merged.welcomeMessage || DEFAULT_BUSINESS_PROFILE.welcomeMessage).trim() || DEFAULT_BUSINESS_PROFILE.welcomeMessage,
    leadPrompt: String(merged.leadPrompt || DEFAULT_BUSINESS_PROFILE.leadPrompt).trim() || DEFAULT_BUSINESS_PROFILE.leadPrompt,
    primaryGoal: String(merged.primaryGoal || DEFAULT_BUSINESS_PROFILE.primaryGoal).trim() || DEFAULT_BUSINESS_PROFILE.primaryGoal,
    quickReplies: normalizeQuickReplies(merged.quickReplies),
  };
}

function getUserBusinessProfile(user) {
  return normalizeBusinessProfile(user?.businessProfile);
}

function generatePublicWorkspaceId(seed = "") {
  const seedPart = String(seed || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const randomPart = crypto.randomUUID().slice(0, 8);
  return `${seedPart || "workspace"}-${randomPart}`;
}

async function ensureUserWorkspaceIdentity(user) {
  if (!usersCollection || !user?._id) {
    return user;
  }

  const updates = {};
  if (!user.publicWorkspaceId) {
    updates.publicWorkspaceId = generatePublicWorkspaceId(user.email || user._id.toString());
  }
  if (!user.businessProfile) {
    updates.businessProfile = normalizeBusinessProfile({
      brandName: user.email ? user.email.split("@")[0] : DEFAULT_BUSINESS_PROFILE.brandName,
    });
  }
  if (!Array.isArray(user.notifications)) {
    updates.notifications = [];
  }

  if (!Object.keys(updates).length) {
    return user;
  }

  await usersCollection.updateOne(
    { _id: user._id },
    { $set: updates }
  );

  return {
    ...user,
    ...updates,
  };
}

function sortNotifications(items) {
  return items
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime();
      const bTime = new Date(b?.createdAt || 0).getTime();
      return bTime - aTime;
    });
}

function buildBusinessProfileContext(profile) {
  const normalized = normalizeBusinessProfile(profile);

  return [
    `Brand name: ${normalized.brandName}`,
    normalized.businessType ? `Business type: ${normalized.businessType}` : "",
    normalized.tagline ? `Tagline: ${normalized.tagline}` : "",
    normalized.description ? `Business description: ${normalized.description}` : "",
    normalized.offerSummary ? `Offer summary: ${normalized.offerSummary}` : "",
    normalized.location ? `Location: ${normalized.location}` : "",
    normalized.websiteUrl ? `Website: ${normalized.websiteUrl}` : "",
    normalized.supportEmail ? `Support email: ${normalized.supportEmail}` : "",
    normalized.supportPhone ? `Support phone: ${normalized.supportPhone}` : "",
    `Preferred tone: ${normalized.tone}`,
    `Welcome style: ${normalized.welcomeMessage}`,
    `Lead capture prompt: ${normalized.leadPrompt}`,
    `Primary goal: ${normalized.primaryGoal}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function isLikelyInterestedLead(message, visitor = {}) {
  const messageText = String(message || "").trim();
  const combined = `${messageText} ${visitor?.interest || ""}`.toLowerCase();

  if (String(visitor?.contact || "").trim()) {
    return true;
  }

  if (String(visitor?.interest || "").trim()) {
    return true;
  }

  return /\b(price|pricing|quote|demo|book|booking|contact|call me|call back|interested|buy|purchase|plan|cost|consultation|appointment)\b/i.test(combined);
}

async function findUserByWorkspaceId(workspaceId) {
  if (!usersCollection || !workspaceId) {
    return null;
  }

  const user = await usersCollection.findOne({ publicWorkspaceId: String(workspaceId).trim() });
  return user ? ensureUserWorkspaceIdentity(user) : null;
}

async function addOwnerNotification(userId, notificationInput = {}) {
  if (!usersCollection || !userId) {
    return null;
  }

  const notification = {
    id: crypto.randomUUID(),
    type: String(notificationInput.type || "info").trim() || "info",
    title: String(notificationInput.title || "New activity").trim() || "New activity",
    message: String(notificationInput.message || "").trim(),
    leadName: String(notificationInput.leadName || "").trim(),
    leadContact: String(notificationInput.leadContact || "").trim(),
    workspaceId: String(notificationInput.workspaceId || "").trim(),
    read: false,
    createdAt: new Date(),
  };

  await usersCollection.updateOne(
    { _id: getUserLookupId(userId) },
    {
      $push: {
        notifications: {
          $each: [notification],
          $position: 0,
          $slice: 60,
        },
      },
    }
  );

  return notification;
}

function getIntegrationStatus() {
  return {
    databaseMode,
    firebaseReady: isFirestoreReady(),
    whatsappConfigured: Boolean(WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_ACCESS_TOKEN),
    instagramConfigured: Boolean(INSTAGRAM_BUSINESS_ACCOUNT_ID && INSTAGRAM_ACCESS_TOKEN),
    whatsappWebhookConfigured: Boolean(WHATSAPP_WEBHOOK_VERIFY_TOKEN),
    instagramWebhookConfigured: Boolean(INSTAGRAM_WEBHOOK_VERIFY_TOKEN),
    whatsappAutoReplyEnabled: WHATSAPP_AUTO_REPLY_ENABLED,
    instagramAutoReplyEnabled: INSTAGRAM_AUTO_REPLY_ENABLED,
    crmReady: false,
    chatbotTitle: CHATBOT_TITLE,
  };
}

function toPublicUser(user) {
  const premiumActive = Boolean(user.premium);
  const usage = user.usage || 0;
  const automationSettings = getAutomationSettings(user);
  const businessProfile = getUserBusinessProfile(user);
  const followupRules = getFollowupRules(user);
  const notifications = sortNotifications(getUserNotifications(user));

  return {
    id: user._id,
    email: user.email,
    publicWorkspaceId: user.publicWorkspaceId || "",
    premium: premiumActive,
    planName: user.planName || (premiumActive ? "Premium" : "Free"),
    usage,
    replyLimit: premiumActive ? null : FREE_REPLY_LIMIT,
    remainingReplies: premiumActive ? null : Math.max(FREE_REPLY_LIMIT - usage, 0),
    lastPaymentId: user.lastPaymentId || null,
    lastOrderId: user.lastOrderId || null,
    premiumActivatedAt: user.premiumActivatedAt || null,
    premiumExpiresAt: user.premiumExpiresAt || null,
    leadCount: getLeadPipeline(user).length,
    automationSettings,
    businessProfile,
    followupRules,
    unreadNotificationCount: notifications.filter((item) => !item.read).length,
    upcomingAppointmentCount: getUserAppointments(user).length,
    connectedChannels: [
      automationSettings.websiteChatbot ? "Website" : null,
      automationSettings.whatsappAssistant ? "WhatsApp" : null,
      getIntegrationStatus().instagramConfigured ? "Instagram" : null,
    ].filter(Boolean),
    integrationStatus: {
      ...getIntegrationStatus(),
      crmReady: Boolean(getUserCrmConfig(user).enabled && getUserCrmConfig(user).provider !== "none"),
    },
  };
}

async function buildPublicUser(user) {
  const preparedUser = await ensureUserWorkspaceIdentity(user);
  const publicUser = toPublicUser(preparedUser);

  if (!isFirestoreReady()) {
    return publicUser;
  }

  const leads = await listFirestoreLeads(publicUser.publicWorkspaceId || APP_WORKSPACE_ID, 500);
  return {
    ...publicUser,
    leadCount: leads.length,
  };
}

function normalizeChannel(channel) {
  const normalized = String(channel || "").trim().toLowerCase();
  if (normalized === "whatsapp") return "whatsapp";
  if (normalized === "instagram") return "instagram";
  return "website";
}

function normalizeReplyLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set(["auto", "english", "hindi", "hinglish"]);
  return allowed.has(normalized) ? normalized : "auto";
}

function normalizeReplyTone(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set(["professional", "warm", "casual", "sales"]);
  return allowed.has(normalized) ? normalized : "professional";
}

function normalizeReplyFormality(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = new Set(["formal", "neutral", "informal"]);
  return allowed.has(normalized) ? normalized : "neutral";
}

function normalizeFollowupRules(rulesInput = []) {
  const source = Array.isArray(rulesInput) ? rulesInput : [];
  const normalized = source
    .map((rule, index) => ({
      id: String(rule?.id || `rule-${index + 1}`).trim(),
      enabled: Boolean(rule?.enabled),
      delayHours: Math.max(1, Math.min(168, Number(rule?.delayHours) || 24)),
      maxAttempts: Math.max(1, Math.min(10, Number(rule?.maxAttempts) || 2)),
      channel: String(rule?.channel || "whatsapp").trim().toLowerCase() === "whatsapp" ? "whatsapp" : "website",
      template: String(rule?.template || "").trim()
        || "Hi {{name}}, bas follow-up kar raha hoon. Kya aapko abhi bhi details chahiye?",
    }))
    .filter((rule) => rule.id);

  if (normalized.length) {
    return normalized.slice(0, 8);
  }

  return DEFAULT_FOLLOWUP_RULES.map((rule) => ({ ...rule }));
}

function getFollowupRules(user) {
  return normalizeFollowupRules(user?.followupRules || DEFAULT_FOLLOWUP_RULES);
}

function getFollowupLogs(user) {
  return Array.isArray(user?.followupLogs) ? user.followupLogs : [];
}

function applyFollowupTemplate(template, lead = {}) {
  const fallbackName = String(lead?.name || "").trim() || "there";
  return String(template || "")
    .replace(/\{\{\s*name\s*\}\}/gi, fallbackName)
    .replace(/\{\{\s*interest\s*\}\}/gi, String(lead?.interest || "").trim() || "your request")
    .trim();
}

function normalizeLeadSource(source, fallbackChannel = "website") {
  const normalizedSource = String(source || "").trim().toLowerCase();

  switch (normalizedSource) {
    case "website":
    case "website chatbot":
      return "Website Chatbot";
    case "whatsapp":
      return "WhatsApp";
    case "instagram":
    case "instagram dm":
      return "Instagram";
    case "facebook":
      return "Facebook";
    case "manual":
    case "manual entry":
      return "Manual Entry";
    default:
      if (fallbackChannel === "whatsapp") return "WhatsApp";
      if (fallbackChannel === "instagram") return "Instagram";
      return "Website Chatbot";
  }
}

function normalizeLeadStatus(status) {
  const normalizedStatus = String(status || "").trim();
  const allowedStatuses = new Set(["New", "Qualified", "Follow-up", "Won", "Lost"]);
  return allowedStatuses.has(normalizedStatus) ? normalizedStatus : "New";
}

function hasLeadIdentity(leadInput = {}) {
  return Boolean(
    String(leadInput.name || "").trim()
    || String(leadInput.contact || "").trim()
    || String(leadInput.interest || "").trim()
  );
}

function hasFirebaseLeadIdentity(leadInput = {}) {
  return Boolean(hasLeadIdentity(leadInput) || String(leadInput.sessionId || "").trim());
}

function toPlainDate(value) {
  if (value?.toDate) {
    return value.toDate();
  }

  return value || null;
}

function toPlainFirestoreDocument(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
    createdAt: toPlainDate(data.createdAt),
    updatedAt: toPlainDate(data.updatedAt),
    lastActivityAt: toPlainDate(data.lastActivityAt),
  };
}

function buildLeadRecord(leadInput = {}, fallbackChannel = "website", existingLead = null) {
  const now = new Date();
  const noteParts = [
    String(existingLead?.notes || "").trim(),
    String(leadInput.notes || "").trim(),
  ].filter(Boolean);

  return {
    id: existingLead?.id || new ObjectId().toString(),
    name: String(leadInput.name || existingLead?.name || "").trim() || "Unnamed Lead",
    contact: String(leadInput.contact || existingLead?.contact || "").trim(),
    interest: String(leadInput.interest || existingLead?.interest || "").trim(),
    source: normalizeLeadSource(leadInput.source || existingLead?.source, fallbackChannel),
    status: normalizeLeadStatus(leadInput.status || existingLead?.status),
    notes: noteParts.join("\n"),
    assignedTo: String(leadInput.assignedTo ?? existingLead?.assignedTo ?? "").trim(),
    lastChannel: normalizeChannel(leadInput.channel || existingLead?.lastChannel || fallbackChannel),
    createdAt: existingLead?.createdAt || now,
    updatedAt: now,
    lastActivityAt: now,
  };
}

function sortLeadPipeline(leads) {
  return leads
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a?.lastActivityAt || a?.updatedAt || a?.createdAt || 0).getTime();
      const bTime = new Date(b?.lastActivityAt || b?.updatedAt || b?.createdAt || 0).getTime();
      return bTime - aTime;
    });
}

function sortHistoryRecords(items) {
  return items
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a?.createdAt || 0).getTime();
      const bTime = new Date(b?.createdAt || 0).getTime();
      return bTime - aTime;
    });
}

async function upsertLeadForUser(user, leadInput = {}, fallbackChannel = "website") {
  if (!hasLeadIdentity(leadInput)) {
    return null;
  }

  const leads = getLeadPipeline(user);
  const normalizedName = String(leadInput.name || "").trim().toLowerCase();
  const normalizedContact = String(leadInput.contact || "").trim().toLowerCase();
  const nextLeads = leads.slice();
  const matchedIndex = nextLeads.findIndex((lead) => {
    const leadName = String(lead?.name || "").trim().toLowerCase();
    const leadContact = String(lead?.contact || "").trim().toLowerCase();

    if (normalizedContact && leadContact && normalizedContact === leadContact) {
      return true;
    }

    return Boolean(normalizedName && leadName && normalizedName === leadName);
  });

  let savedLead;
  if (matchedIndex >= 0) {
    savedLead = buildLeadRecord(leadInput, fallbackChannel, nextLeads[matchedIndex]);
    nextLeads[matchedIndex] = savedLead;
  } else {
    savedLead = buildLeadRecord(leadInput, fallbackChannel);
    nextLeads.unshift(savedLead);
  }

  const sortedLeads = sortLeadPipeline(nextLeads);
  await usersCollection.updateOne(
    { _id: user._id },
    { $set: { leadPipeline: sortedLeads } }
  );

  return savedLead;
}

async function listFirestoreLeads(workspaceId = APP_WORKSPACE_ID, limit = 60) {
  if (!isFirestoreReady()) {
    return [];
  }

  const normalizedWorkspaceId = String(workspaceId || APP_WORKSPACE_ID);
  const normalizedLimit = Math.max(1, Number(limit) || 60);

  try {
    const snapshot = await firestoreDb
      .collection("workspace_leads")
      .where("workspaceId", "==", normalizedWorkspaceId)
      .orderBy("lastActivityAt", "desc")
      .limit(normalizedLimit)
      .get();

    return snapshot.docs.map(toPlainFirestoreDocument);
  } catch (error) {
    // Keep a safe fallback path when a required Firestore index is missing.
    console.warn("Firestore lead query fallback:", error.message);
    const snapshot = await firestoreDb
      .collection("workspace_leads")
      .where("workspaceId", "==", normalizedWorkspaceId)
      .get();
    return sortLeadPipeline(snapshot.docs.map(toPlainFirestoreDocument)).slice(0, normalizedLimit);
  }
}

async function listFirestoreHistory(workspaceId = APP_WORKSPACE_ID, limit = 120) {
  if (!isFirestoreReady()) {
    return [];
  }

  const normalizedWorkspaceId = String(workspaceId || APP_WORKSPACE_ID);
  const normalizedLimit = Math.max(1, Number(limit) || 120);

  try {
    const snapshot = await firestoreDb
      .collection("workspace_history")
      .where("workspaceId", "==", normalizedWorkspaceId)
      .orderBy("createdAt", "desc")
      .limit(normalizedLimit)
      .get();

    return snapshot.docs.map(toPlainFirestoreDocument);
  } catch (error) {
    // Keep a safe fallback path when a required Firestore index is missing.
    console.warn("Firestore history query fallback:", error.message);
    const snapshot = await firestoreDb
      .collection("workspace_history")
      .where("workspaceId", "==", normalizedWorkspaceId)
      .get();
    return sortHistoryRecords(snapshot.docs.map(toPlainFirestoreDocument)).slice(0, normalizedLimit);
  }
}

async function findFirestoreLead(workspaceId = APP_WORKSPACE_ID, leadInput = {}, fallbackChannel = "website") {
  if (!isFirestoreReady()) {
    return null;
  }

  const normalizedContact = String(leadInput.contact || "").trim();
  const normalizedSessionId = String(leadInput.sessionId || "").trim();
  const normalizedName = String(leadInput.name || "").trim().toLowerCase();
  const normalizedWorkspaceId = String(workspaceId || APP_WORKSPACE_ID);

  if (normalizedContact) {
    try {
      const contactSnapshot = await firestoreDb
        .collection("workspace_leads")
        .where("workspaceId", "==", normalizedWorkspaceId)
        .where("contact", "==", normalizedContact)
        .orderBy("lastActivityAt", "desc")
        .limit(1)
        .get();
      if (!contactSnapshot.empty) {
        return toPlainFirestoreDocument(contactSnapshot.docs[0]);
      }
    } catch (_error) {
      // Fallback handled below.
    }
  }

  if (normalizedSessionId) {
    try {
      const sessionSnapshot = await firestoreDb
        .collection("workspace_leads")
        .where("workspaceId", "==", normalizedWorkspaceId)
        .where("sessionId", "==", normalizedSessionId)
        .orderBy("lastActivityAt", "desc")
        .limit(1)
        .get();
      if (!sessionSnapshot.empty) {
        return toPlainFirestoreDocument(sessionSnapshot.docs[0]);
      }
    } catch (_error) {
      // Fallback handled below.
    }
  }

  const leads = await listFirestoreLeads(workspaceId, 300);

  if (normalizedName) {
    const byName = leads.find((lead) => {
      return String(lead.name || "").trim().toLowerCase() === normalizedName
        && normalizeChannel(lead.lastChannel || fallbackChannel) === normalizeChannel(fallbackChannel);
    });

    if (byName) {
      return byName;
    }
  }

  return null;
}

function buildFirestoreLeadRecord(workspaceId = APP_WORKSPACE_ID, leadInput = {}, fallbackChannel = "website", existingLead = null) {
  const baseLead = buildLeadRecord(leadInput, fallbackChannel, existingLead);
  const now = new Date();

  return {
    ...baseLead,
    workspaceId: String(workspaceId || APP_WORKSPACE_ID),
    sessionId: String(leadInput.sessionId || existingLead?.sessionId || "").trim(),
    leadType: String(leadInput.leadType || existingLead?.leadType || "inbound").trim() || "inbound",
    lastMessage: String(leadInput.lastMessage || existingLead?.lastMessage || "").trim(),
    lastReply: String(leadInput.lastReply || existingLead?.lastReply || "").trim(),
    integration: String(leadInput.integration || existingLead?.integration || fallbackChannel).trim(),
    createdAt: existingLead?.createdAt || now,
    updatedAt: now,
    lastActivityAt: now,
  };
}

async function saveFirestoreLead(workspaceId = APP_WORKSPACE_ID, leadInput = {}, fallbackChannel = "website") {
  if (!isFirestoreReady() || !hasFirebaseLeadIdentity(leadInput)) {
    return null;
  }

  const existingLead = await findFirestoreLead(workspaceId, leadInput, fallbackChannel);
  const nextLead = buildFirestoreLeadRecord(workspaceId, leadInput, fallbackChannel, existingLead);

  if (existingLead?.id) {
    await firestoreDb.collection("workspace_leads").doc(existingLead.id).set(nextLead, { merge: true });
    return { ...nextLead, id: existingLead.id };
  }

  const ref = await firestoreDb.collection("workspace_leads").add(nextLead);
  return { ...nextLead, id: ref.id };
}

async function saveFirestoreHistory(workspaceId = APP_WORKSPACE_ID, entry = {}) {
  if (!isFirestoreReady()) {
    return null;
  }

  const payload = {
    workspaceId: String(workspaceId || APP_WORKSPACE_ID),
    sessionId: String(entry.sessionId || "").trim(),
    message: String(entry.message || "").trim(),
    reply: String(entry.reply || "").trim(),
    business: String(entry.business || "").trim(),
    channel: normalizeChannel(entry.channel),
    automationMode: String(entry.automationMode || "auto").trim() || "auto",
    leadId: String(entry.leadId || "").trim(),
    leadName: String(entry.leadName || "").trim(),
    leadContact: String(entry.leadContact || "").trim(),
    leadSource: normalizeLeadSource(entry.leadSource, normalizeChannel(entry.channel)),
    integration: String(entry.integration || normalizeChannel(entry.channel)).trim(),
    language: normalizeReplyLanguage(entry.language),
    tone: normalizeReplyTone(entry.tone),
    formality: normalizeReplyFormality(entry.formality),
    createdAt: new Date(),
  };

  const ref = await firestoreDb.collection("workspace_history").add(payload);
  return { ...payload, id: ref.id };
}

function getChatbotSessionId(rawSessionId) {
  const candidate = String(rawSessionId || "").trim();
  return candidate || `chat-${crypto.randomUUID()}`;
}

function normalizeWhatsappRecipient(value) {
  return String(value || "").replace(/[^\d]/g, "").trim();
}

function normalizeInstagramRecipient(value) {
  return String(value || "").trim();
}

function validateEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function validatePasswordStrength(value) {
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(String(value || ""));
}

function sanitizeText(value, maxLength = 2000) {
  return String(value || "").trim().slice(0, maxLength);
}

async function withRetry(taskFn, options = {}) {
  const retries = Number(options.retries ?? 2);
  const delayMs = Number(options.delayMs ?? 400);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await taskFn();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

function getWhatsAppApiUrl() {
  return `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

function getInstagramApiUrl() {
  return `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${INSTAGRAM_BUSINESS_ACCOUNT_ID}/messages`;
}

async function sendWhatsAppTextMessage(to, body) {
  const recipient = normalizeWhatsappRecipient(to);
  if (!recipient) {
    throw new Error("WhatsApp recipient is required.");
  }

  if (!WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_ACCESS_TOKEN) {
    throw new Error("WhatsApp Cloud API credentials are not configured.");
  }

  const response = await withRetry(() => fetch(getWhatsAppApiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "text",
      text: {
        body: String(body || "").trim(),
        preview_url: false,
      },
    }),
  }), { retries: 2, delayMs: 500 });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage = data?.error?.message || "WhatsApp message send failed.";
    throw new Error(errorMessage);
  }

  return data;
}

async function sendInstagramTextMessage(recipientId, body) {
  const recipient = normalizeInstagramRecipient(recipientId);
  if (!recipient) {
    throw new Error("Instagram recipient is required.");
  }

  if (!INSTAGRAM_BUSINESS_ACCOUNT_ID || !INSTAGRAM_ACCESS_TOKEN) {
    throw new Error("Instagram API credentials are not configured.");
  }

  const response = await withRetry(() => fetch(getInstagramApiUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${INSTAGRAM_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: recipient },
      message: { text: String(body || "").trim() },
    }),
  }), { retries: 2, delayMs: 500 });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage = data?.error?.message || "Instagram message send failed.";
    throw new Error(errorMessage);
  }

  return data;
}

function getDueFollowupItemsForUser(user) {
  const rules = getFollowupRules(user).filter((rule) => rule.enabled && rule.channel === "whatsapp");
  const leads = getLeadPipeline(user);
  const now = Date.now();
  const followupLogs = getFollowupLogs(user);
  const dueItems = [];

  for (const rule of rules) {
    for (const lead of leads) {
      const contact = normalizeWhatsappRecipient(lead?.contact);
      if (!contact) {
        continue;
      }

      const leadStatus = String(lead?.status || "").trim();
      if (leadStatus === "Won" || leadStatus === "Lost") {
        continue;
      }

      const lastActivityAt = new Date(lead?.lastActivityAt || lead?.updatedAt || lead?.createdAt || Date.now()).getTime();
      if (!Number.isFinite(lastActivityAt)) {
        continue;
      }

      const dueAt = lastActivityAt + (rule.delayHours * 60 * 60 * 1000);
      if (dueAt > now) {
        continue;
      }

      const relatedLogs = followupLogs.filter((log) =>
        log?.ruleId === rule.id
        && normalizeWhatsappRecipient(log?.leadContact) === contact
      );

      if (relatedLogs.length >= rule.maxAttempts) {
        continue;
      }

      const recentSuccess = relatedLogs.find((log) => log?.status === "sent");
      if (recentSuccess) {
        continue;
      }

      dueItems.push({
        rule,
        lead,
        leadContact: contact,
      });
    }
  }

  return dueItems;
}

async function runWhatsappFollowupsForUser(user) {
  const dueItems = getDueFollowupItemsForUser(user);
  if (!dueItems.length) {
    return { sent: 0, attempted: 0 };
  }

  const nextLogs = getFollowupLogs(user).slice();
  let sent = 0;
  let attempted = 0;
  for (const item of dueItems) {
    attempted += 1;
    const payloadMessage = applyFollowupTemplate(item.rule.template, item.lead);
    const logEntry = {
      id: `fup-${crypto.randomUUID()}`,
      ruleId: item.rule.id,
      channel: item.rule.channel,
      leadName: String(item.lead?.name || "").trim(),
      leadContact: item.leadContact,
      message: payloadMessage,
      status: "failed",
      createdAt: new Date(),
    };

    try {
      await sendWhatsAppTextMessage(item.leadContact, payloadMessage);
      logEntry.status = "sent";
      sent += 1;
    } catch (error) {
      logEntry.error = String(error?.message || "Unknown follow-up error");
    }

    nextLogs.unshift(logEntry);
  }

  await usersCollection.updateOne(
    { _id: user._id },
    {
      $set: { followupLogs: nextLogs.slice(0, 200) },
    }
  );

  return { sent, attempted };
}

async function runScheduledWhatsappFollowups() {
  if (!isDatabaseReady()) {
    return;
  }

  if (typeof usersCollection?.find !== "function") {
    // Local JSON fallback collection does not expose find cursor APIs.
    // Scheduler should run only with Mongo-backed collections.
    return;
  }

  try {
    const cursor = usersCollection.find({}, { projection: { _id: 1, leadPipeline: 1, followupRules: 1, followupLogs: 1 } });
    while (await cursor.hasNext()) {
      const user = await cursor.next();
      if (!user) {
        continue;
      }
      await runWhatsappFollowupsForUser(user);
    }
  } catch (error) {
    console.error("Scheduled WhatsApp follow-ups failed:", error.message);
  }
}

function verifyWhatsAppWebhookSignature(req) {
  if (!WHATSAPP_APP_SECRET || !req.rawBody) {
    return true;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const actualSignature = signatureHeader.slice(7);
  const expectedSignature = crypto
    .createHmac("sha256", WHATSAPP_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature));
  } catch (_error) {
    return false;
  }
}

function verifyInstagramWebhookSignature(req) {
  if (!INSTAGRAM_APP_SECRET || !req.rawBody) {
    return true;
  }

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const actualSignature = signatureHeader.slice(7);
  const expectedSignature = crypto
    .createHmac("sha256", INSTAGRAM_APP_SECRET)
    .update(req.rawBody)
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(actualSignature), Buffer.from(expectedSignature));
  } catch (_error) {
    return false;
  }
}

function extractWhatsAppText(message = {}) {
  if (message.type === "text") {
    return String(message.text?.body || "").trim();
  }

  if (message.type === "button") {
    return String(message.button?.text || "").trim();
  }

  if (message.type === "interactive") {
    return String(
      message.interactive?.button_reply?.title
      || message.interactive?.list_reply?.title
      || ""
    ).trim();
  }

  return "";
}

function extractInstagramText(event = {}) {
  const messageText = String(event?.message?.text || "").trim();
  if (messageText) {
    return messageText;
  }

  const postbackText = String(event?.postback?.title || event?.postback?.payload || "").trim();
  return postbackText;
}

async function processIncomingWhatsAppPayload(payload = {}) {
  const workspaceOwner = await findUserByWorkspaceId(APP_WORKSPACE_ID);
  const workspaceId = workspaceOwner?.publicWorkspaceId || APP_WORKSPACE_ID;

  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change.value || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const profileName = String(contacts[0]?.profile?.name || "").trim();

      for (const message of messages) {
        const incomingText = extractWhatsAppText(message);
        if (!incomingText) {
          continue;
        }

        const from = normalizeWhatsappRecipient(message.from);
        const lead = await saveFirestoreLead(workspaceId, {
          name: profileName || "WhatsApp Lead",
          contact: from,
          source: "WhatsApp",
          channel: "whatsapp",
          status: "New",
          interest: "WhatsApp inquiry",
          sessionId: `whatsapp:${from}`,
          leadType: "whatsapp",
          integration: "whatsapp-cloud-api",
          lastMessage: incomingText,
        }, "whatsapp");

        if (workspaceOwner) {
          await upsertLeadForUser(workspaceOwner, {
            name: profileName || "WhatsApp Lead",
            contact: from,
            source: "WhatsApp",
            channel: "whatsapp",
            status: "New",
            interest: "WhatsApp inquiry",
            notes: `Last WhatsApp message: ${incomingText}`,
          }, "whatsapp");
          await addOwnerNotification(workspaceOwner._id.toString(), {
            type: "whatsapp",
            title: "New WhatsApp inquiry",
            message: `${profileName || from || "A WhatsApp lead"} sent a new message.`,
            leadName: profileName || "WhatsApp Lead",
            leadContact: from,
            workspaceId,
          });
        }

        let reply = "";
        if (WHATSAPP_AUTO_REPLY_ENABLED) {
          try {
            reply = await generateAiReply(incomingText, WHATSAPP_BUSINESS_CONTEXT, "WhatsApp inbound message");
            await sendWhatsAppTextMessage(from, reply);
          } catch (error) {
            console.error("WhatsApp auto reply failed:", error.message);
          }
        }

        await saveFirestoreHistory(workspaceId, {
          sessionId: `whatsapp:${from}`,
          message: incomingText,
          reply,
          business: WHATSAPP_BUSINESS_CONTEXT,
          channel: "whatsapp",
          automationMode: reply ? "whatsapp-auto" : "whatsapp-inbox",
          leadId: lead?.id || "",
          leadName: lead?.name || profileName || "WhatsApp Lead",
          leadContact: lead?.contact || from,
          leadSource: "WhatsApp",
          integration: "whatsapp-cloud-api",
        });
      }
    }
  }
}

async function processIncomingInstagramPayload(payload = {}) {
  const workspaceOwner = await findUserByWorkspaceId(APP_WORKSPACE_ID);
  const workspaceId = workspaceOwner?.publicWorkspaceId || APP_WORKSPACE_ID;
  const businessProfile = workspaceOwner
    ? getUserBusinessProfile(workspaceOwner)
    : normalizeBusinessProfile({ brandName: CHATBOT_TITLE });
  const businessContext = buildBusinessProfileContext(businessProfile) || CHATBOT_BUSINESS_CONTEXT;

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      const senderId = String(event?.sender?.id || "").trim();
      const incomingText = extractInstagramText(event);
      if (!senderId || !incomingText) {
        continue;
      }

      const localeHint = buildLocaleHint("", [], "");
      const reply = INSTAGRAM_AUTO_REPLY_ENABLED
        ? await generateAiReply(incomingText, businessContext, localeHint)
        : "";

      let savedLead = null;
      if (workspaceOwner) {
        savedLead = await upsertLeadForUser(workspaceOwner, {
          name: "Instagram Lead",
          contact: senderId,
          interest: incomingText.slice(0, 80),
          notes: "Inbound Instagram DM",
          source: "Instagram",
          channel: "instagram",
          status: "New",
        }, "instagram");

        await addOwnerNotification(workspaceOwner._id.toString(), {
          type: "instagram",
          title: "New Instagram DM lead",
          message: "A lead sent a new Instagram DM.",
          leadName: savedLead?.name || "Instagram Lead",
          leadContact: senderId,
          workspaceId,
        });
      }

      const firestoreLead = await saveFirestoreLead(workspaceId, {
        name: "Instagram Lead",
        contact: senderId,
        interest: incomingText.slice(0, 80),
        notes: "Inbound Instagram DM",
        source: "Instagram",
        channel: "instagram",
        status: "New",
        sessionId: `instagram:${senderId}`,
        leadType: "instagram-dm",
        integration: "instagram-graph-api",
        lastMessage: incomingText,
        lastReply: reply,
      }, "instagram");

      const effectiveLead = firestoreLead || savedLead;

      if (workspaceOwner) {
        await usersCollection.updateOne(
          { _id: workspaceOwner._id },
          {
            $push: {
              replyHistory: {
                message: incomingText,
                business: businessContext,
                reply,
                channel: "instagram",
                automationMode: reply ? "instagram-auto" : "instagram-inbox",
                leadName: effectiveLead?.name || "Instagram Lead",
                leadContact: effectiveLead?.contact || senderId,
                leadSource: "Instagram",
                createdAt: new Date(),
              },
            },
          }
        );
      }

      await saveFirestoreHistory(workspaceId, {
        sessionId: `instagram:${senderId}`,
        message: incomingText,
        reply,
        business: businessContext,
        channel: "instagram",
        automationMode: reply ? "instagram-auto" : "instagram-inbox",
        leadId: effectiveLead?.id || "",
        leadName: effectiveLead?.name || "Instagram Lead",
        leadContact: effectiveLead?.contact || senderId,
        leadSource: "Instagram",
        integration: "instagram-graph-api",
      });

      if (reply) {
        try {
          await sendInstagramTextMessage(senderId, reply);
        } catch (error) {
          console.error("Instagram auto reply failed:", error.message);
        }
      }
    }
  }
}

const LOW_QUALITY_ENDING_RE = /\b(of|for|with|at|to|and|or)\.$/i;
const GENERIC_THANKS_RE = /^(thank you for reaching out|thank you for your inquiry|thank you for your message)\b[,\s!.\n-]*/i;
const GENERIC_GREETING_RE = /^(hello|hi|dear)\b[,\s!.\n-]*/i;

function isMedicalBusiness(business) {
  return /\b(medical|medicine|pharmacy|chemist|clinic|doctor|hospital|drug)\b/i.test(String(business || ""));
}

function buildLocaleHint(locale, languageHints, acceptLanguage) {
  const localeText = String(locale || "").trim();
  const hintList = Array.isArray(languageHints)
    ? languageHints.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const acceptLanguageText = String(acceptLanguage || "").trim();

  const parts = [];
  if (localeText) {
    parts.push(`Primary locale: ${localeText}`);
  }
  if (hintList.length) {
    parts.push(`Browser languages: ${hintList.join(", ")}`);
  }
  if (acceptLanguageText) {
    parts.push(`Accept-Language header: ${acceptLanguageText}`);
  }

  return parts.length ? parts.join(" | ") : "No locale hint provided";
}

function buildPrompt(message, business, localeHint) {
  const trimmedMessage = String(message || "").trim();
  const trimmedBusiness = String(business || "").trim();
  const instructions = [
    "You are writing a real customer support reply for a small business.",
    "Write one complete, ready-to-send message in plain text.",
    "Tone must be professional, polite, helpful, and business-like.",
    "Sound like a real business owner or support representative, not a bot.",
    "Answer the customer's actual question in the first meaningful sentence.",
    "Adapt the reply to the business context.",
    "Use relevant business details naturally, such as business type, location, service, or sales channel, when they are provided.",
    "Reply in the same language as the customer's message.",
    "Preserve the customer's script and language. Do not switch to Hindi, Hinglish, or English unless the customer used that language.",
    "If the customer writes in French, reply in French. If the customer writes in Japanese, reply in Japanese. If the customer writes in Hindi, reply in Hindi. If the customer writes in English, reply in English.",
    "If the customer mixes languages, reply in the dominant language and tone used by the customer.",
    "Keep it natural, clear, and useful. Use 2 to 4 short sentences.",
    "Preferred structure: optional short greeting, direct answer, then one helpful next step or follow-up.",
    "A brief greeting or warm closing is fine when it feels natural and professional.",
    "Do not mention AI, templates, placeholders, policies, or internal notes.",
    "Do not invent stock, price, delivery time, or appointment availability if it is not confirmed.",
    "If availability or details are unknown, say you will check or confirm and ask one short follow-up only if needed.",
    "Mention the key product, service, or request from the customer message when natural.",
    "For product or stock questions, give a direct store-style answer such as availability, checking availability, or asking one short follow-up.",
    "For booking or reservation questions, guide the customer toward confirmation by asking the most useful next detail, such as time, date, guest count, or preferred slot.",
    "For product sales questions, if exact stock is not confirmed, reassure the customer that you can check and ask the most relevant detail, such as model, quantity, color, or variant.",
    "If the customer's message language is short, ambiguous, or unclear, use the locale hint to choose the reply language.",
    "Support global languages and scripts, including English, Hindi, French, Spanish, Arabic, Japanese, Korean, Chinese, Portuguese, German, Russian, and other languages used by the customer.",
    "Finish with a complete sentence.",
  ];

  if (isMedicalBusiness(trimmedBusiness)) {
    instructions.push("For medical or pharmacy businesses, do not give dosage, diagnosis, treatment, or unsafe medical advice. Focus on product availability, store help, and safe pharmacist or doctor guidance when relevant.");
  }

  return [
    ...instructions,
    "Examples:",
    'Customer message: "Can I book a table for tonight?" | Business context: "I run a restaurant in Nagpur" | Good reply: "Hello, yes, we can help with a table booking for tonight at our restaurant in Nagpur. Please share your preferred time and number of guests so we can confirm the reservation for you."',
    'Customer message: "Do you have iPhone 13 in stock?" | Business context: "I sell mobile phones online" | Good reply: "Hello, thank you for your inquiry. We can check iPhone 13 availability for you right away. Please share your preferred storage variant or color, and we will confirm the exact stock for you."',
    'Customer message: "you have any cosmetics ?" | Business context: "general store shop" | Good reply: "Yes, we have cosmetics available. Which product do you need? I can confirm the exact availability for you."',
    'Customer message: "i want saridon ?" | Business context: "medical" | Good reply: "Saridon ki availability main check karke confirm karta hoon. Aap quantity bata dijiye."',
    'Customer message: "Avez-vous des cosmétiques ?" | Business context: "general store shop" | Good reply: "Oui, nous avons des cosmétiques. Quel produit cherchez-vous ? Je peux confirmer la disponibilité exacte."',
    'Customer message: "¿Tienen maquillaje?" | Business context: "general store shop" | Good reply: "Sí, tenemos maquillaje. ¿Qué producto busca? Puedo confirmar la disponibilidad exacta."',
    'Customer message: "هل لديكم دواء للصداع؟" | Business context: "medical store" | Good reply: "نعم، يمكنني التحقق من توفر دواء للصداع. ما اسم المنتج الذي تحتاجه؟"',
    'Customer message: "明日配達できますか？" | Business context: "flower shop" | Good reply: "明日の配達が可能か確認いたします。お届け先を教えてください。"',
    `Locale hint: ${localeHint}`,
    `Business context: ${trimmedBusiness || "general customer support business"}`,
    `Customer message: ${trimmedMessage}`,
    "Write only the final reply.",
  ].join("\n");
}

function buildRepairPrompt(message, business, previousReply, localeHint) {
  const trimmedBusiness = String(business || "").trim() || "general customer support business";

  return [
    "Rewrite the business reply below so it becomes a strong, ready-to-send customer reply.",
    "Fix generic greetings, incomplete sentences, weak answers, and missing business context.",
    "Make the tone professional, polite, helpful, and business-like.",
    "Answer the customer's actual question directly.",
    "Keep the reply in the same language and script as the customer's message.",
    "If the message language is unclear, use the locale hint to choose the correct language.",
    "Do not invent stock, price, delivery, or appointment details if not confirmed.",
    "Use the business context naturally.",
    "Keep it concise, natural, and complete in 2 to 4 short sentences.",
    'Example style: "Hello, yes, we have cosmetics available. Please let us know which product you need, and we will confirm the exact availability for you."',
    "Write only the improved final reply.",
    `Locale hint: ${localeHint}`,
    `Business context: ${trimmedBusiness}`,
    `Customer message: ${String(message || "").trim()}`,
    `Weak reply: ${String(previousReply || "").trim()}`,
  ].join("\n");
}

function extractGeneratedText(aiData) {
  const parts = aiData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => part?.text || "")
    .join("\n")
    .trim();
}

function sanitizeGeneratedText(text) {
  return String(text || "")
    .replace(/^["'`\s]+|["'`\s]+$/g, "")
    .trim();
}

function extractBusinessContextField(business, label) {
  const pattern = new RegExp(`${label}:\\s*([^|]+)`, "i");
  const match = String(business || "").match(pattern);
  return match?.[1]?.trim() || "";
}

function detectFallbackReplyStyle(message, localeHint) {
  const combined = `${String(message || "")} ${String(localeHint || "")}`.toLowerCase();

  if (/[\u0900-\u097f]/.test(String(message || ""))) {
    return "hindi";
  }

  if (/\b(aap|mujhe|chahiye|karna|hai|kya|kripya|bataiye|sampark|jaldi|booking|price)\b/.test(combined)) {
    return "hinglish";
  }

  return "english";
}

function buildFallbackAiReply(message, business, localeHint) {
  const messageText = String(message || "").trim();
  const lowerMessage = messageText.toLowerCase();
  const brandName = extractBusinessContextField(business, "Brand name") || "our team";
  const leadPrompt = extractBusinessContextField(business, "Lead capture prompt")
    || "Please share your name and contact details so our team can help you further.";
  const style = detectFallbackReplyStyle(messageText, localeHint);

  if (style === "hindi") {
    if (/\b(price|pricing|quote|cost|plan)\b/i.test(lowerMessage)) {
      return `${brandName} ki pricing aapki requirement ke hisaab se share ki ja sakti hai. Kripya apni exact need ya preferred plan batayiye, phir hum aapko sahi details bhej denge. ${leadPrompt}`;
    }

    if (/\b(book|booking|demo|appointment|schedule)\b/i.test(lowerMessage)) {
      return `${brandName} ke liye hum demo ya booking arrange kar sakte hain. Kripya apna preferred time aur contact detail share kar dijiye, phir hum aage confirm kar denge.`;
    }

    if (/\b(available|availability|stock|have)\b/i.test(lowerMessage)) {
      return `${brandName} ke liye main availability check karne me madad kar sakta hoon. Kripya product ya requirement ka thoda aur detail share kijiye, phir hum jaldi confirm kar denge.`;
    }

    return `${brandName} se sampark karne ke liye dhanyavaad. Kripya apni requirement aur best contact detail share kijiye, taki hum aapko sahi tareeke se help kar saken.`;
  }

  if (style === "hinglish") {
    if (/\b(price|pricing|quote|cost|plan)\b/i.test(lowerMessage)) {
      return `Thanks for reaching out to ${brandName}. Hum aapki requirement ke hisaab se right pricing share kar sakte hain. Please apna use case ya preferred plan bata dijiye, aur saath me contact detail share kar dijiye.`;
    }

    if (/\b(book|booking|demo|appointment|schedule)\b/i.test(lowerMessage)) {
      return `${brandName} ke liye demo ya booking arrange ki ja sakti hai. Please preferred time slot aur best contact number share kar dijiye, hum next step confirm kar denge.`;
    }

    if (/\b(available|availability|stock|have)\b/i.test(lowerMessage)) {
      return `Yes, hum availability check karne me help kar sakte hain for ${brandName}. Please exact requirement ya product detail share kijiye, phir hum jaldi confirm kar denge.`;
    }

    return `Thanks for contacting ${brandName}. Please apni requirement aur best contact detail share kijiye, taki hum aapko quickly guide kar saken.`;
  }

  if (/\b(price|pricing|quote|cost|plan)\b/i.test(lowerMessage)) {
    return `Thanks for reaching out to ${brandName}. We can share the right pricing based on your requirement. Please tell us what you need and share your best contact details so our team can follow up quickly.`;
  }

  if (/\b(book|booking|demo|appointment|schedule)\b/i.test(lowerMessage)) {
    return `Thanks for your interest in ${brandName}. We can help you arrange a demo or booking. Please share your preferred time and best contact number so we can confirm the next step.`;
  }

  if (/\b(available|availability|stock|have)\b/i.test(lowerMessage)) {
    return `Thanks for checking with ${brandName}. We can help confirm availability for you. Please share the exact product or requirement, and we will guide you further.`;
  }

  return `Thanks for contacting ${brandName}. We can help with your request. Please share a little more detail along with your best contact information so our team can assist you properly.`;
}

function computeLeadScore(lead = {}, incomingMessage = "") {
  let score = 25;
  const text = `${lead.interest || ""} ${lead.notes || ""} ${incomingMessage || ""}`.toLowerCase();
  if (String(lead.contact || "").trim()) score += 20;
  if (String(lead.name || "").trim() && String(lead.name || "").trim().toLowerCase() !== "unnamed lead") score += 10;
  if (/\b(price|pricing|quote|cost|plan|budget)\b/i.test(text)) score += 15;
  if (/\b(book|booking|demo|appointment|schedule)\b/i.test(text)) score += 15;
  if (/\b(urgent|today|now|asap|immediately)\b/i.test(text)) score += 10;
  if (String(lead.status || "").trim() === "Qualified") score += 10;
  if (String(lead.status || "").trim() === "Follow-up") score += 5;
  if (["Won", "Lost"].includes(String(lead.status || "").trim())) score = 10;
  return Math.max(0, Math.min(100, score));
}

function getScoreBand(score) {
  if (score >= 75) return "Hot";
  if (score >= 50) return "Warm";
  return "Cold";
}

function buildSalesCloserSuggestion(lead = {}, message = "") {
  const score = computeLeadScore(lead, message);
  const band = getScoreBand(score);
  const leadName = String(lead.name || "").trim() || "Customer";
  const interest = String(lead.interest || "").trim() || "their requirement";
  const nextAction = score >= 75
    ? "Share a direct CTA with time-bound next step and ask for confirmation."
    : score >= 50
      ? "Clarify requirement, present one best-fit option, then ask a closing question."
      : "Build trust first with one helpful answer and ask one qualification question.";

  const draft = score >= 75
    ? `Hi ${leadName}, thanks for your interest in ${interest}. I can finalize this for you today. Would you like me to reserve the best option and share the payment/booking link now?`
    : score >= 50
      ? `Hi ${leadName}, thanks for your message. Based on ${interest}, I can suggest the most suitable option. Would you prefer the faster plan or the budget-friendly plan so I can close this for you?`
      : `Hi ${leadName}, thanks for reaching out. I can guide you with the best option for ${interest}. Could you share your main goal and timeline so I can recommend the right next step?`;

  return { score, band, nextAction, draft };
}

function responseLooksLowQuality(reply) {
  const trimmedReply = sanitizeGeneratedText(reply);
  const lowerReply = trimmedReply.toLowerCase();
  const withoutGreeting = trimmedReply.replace(GENERIC_GREETING_RE, "").trim();
  const withoutGreetingAndThanks = withoutGreeting.replace(GENERIC_THANKS_RE, "").trim();

  if (!trimmedReply) {
    return true;
  }

  if (trimmedReply.length < 24) {
    return true;
  }

  if (/^hello[,!. ]+thank you for reaching out/i.test(lowerReply) && withoutGreetingAndThanks.length < 32) {
    return true;
  }

  if (/^thank you for reaching out/i.test(lowerReply) && withoutGreetingAndThanks.length < 32) {
    return true;
  }

  if (/^(hello|hi|dear)\b/i.test(lowerReply) && withoutGreetingAndThanks.split(/\s+/).filter(Boolean).length <= 4) {
    return true;
  }

  if (LOW_QUALITY_ENDING_RE.test(trimmedReply)) {
    return true;
  }

  if (!/[.!?]"?$/.test(trimmedReply)) {
    return true;
  }

  return false;
}

function buildGenerationConfig(model) {
  const config = {
    temperature: 0.45,
    maxOutputTokens: 320,
  };

  if (/gemini-2\.5/i.test(String(model || ""))) {
    config.thinkingConfig = {
      thinkingBudget: 0,
    };
  }

  return config;
}

async function requestGeminiReply(prompt) {
  if (!GEMINI_API_KEY) {
    throw new AiReplyError("Gemini API key is not configured.");
  }

  let lastErrorMessage = "Gemini returned no usable text.";

  for (const model of GEMINI_MODELS) {
    const baseUrl = `${GEMINI_API_URL}/${model}:generateContent`;
    const requestUrl = GEMINI_API_AUTH_MODE === "query"
      ? `${baseUrl}?key=${encodeURIComponent(GEMINI_API_KEY)}`
      : baseUrl;

    const requestHeaders = {
      "Content-Type": "application/json",
    };

    if (GEMINI_API_AUTH_MODE === "bearer") {
      requestHeaders.Authorization = `Bearer ${GEMINI_API_KEY}`;
    } else if (GEMINI_API_AUTH_MODE === "header" || !GEMINI_API_AUTH_MODE) {
      requestHeaders["x-goog-api-key"] = GEMINI_API_KEY;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);

    try {
      const aiResponse = await fetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
              ],
            },
          ],
          generationConfig: buildGenerationConfig(model),
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        lastErrorMessage = `Gemini API error (${model}) ${aiResponse.status}: ${errorText}`;
        console.error(lastErrorMessage);
        clearTimeout(timeout);
        continue;
      }

      const aiData = await aiResponse.json();
      const generatedText = sanitizeGeneratedText(extractGeneratedText(aiData));
      clearTimeout(timeout);

      if (generatedText) {
        return generatedText;
      }

      lastErrorMessage = `Gemini returned an empty reply for model ${model}.`;
      console.error(lastErrorMessage);
    } catch (error) {
      clearTimeout(timeout);
      lastErrorMessage = `Gemini request failed for ${model}: ${error.message}`;
      console.error(lastErrorMessage);

      if (error?.name === "AbortError" || /fetch failed|network|enotfound|econnrefused|timed out/i.test(String(error.message || ""))) {
        break;
      }
    }
  }

  throw new AiReplyError(lastErrorMessage);
}

async function generateAiReply(message, business, localeHint) {
  try {
    if (!GEMINI_API_KEY) {
      return buildFallbackAiReply(message, business, localeHint);
    }

    const firstReply = await requestGeminiReply(buildPrompt(message, business, localeHint));

    if (!responseLooksLowQuality(firstReply)) {
      return firstReply;
    }

    try {
      const repairedReply = await requestGeminiReply(buildRepairPrompt(message, business, firstReply, localeHint));
      return responseLooksLowQuality(repairedReply) ? firstReply : repairedReply;
    } catch (_error) {
      return firstReply;
    }
  } catch (error) {
    if (error instanceof AiReplyError) {
      return buildFallbackAiReply(message, business, localeHint);
    }

    throw error;
  }
}

app.get("/api/chatbot/config", async (req, res) => {
  const workspaceId = String(req.query.workspace || APP_WORKSPACE_ID).trim();
  const workspaceOwner = await findUserByWorkspaceId(workspaceId);
  const businessProfile = workspaceOwner ? getUserBusinessProfile(workspaceOwner) : normalizeBusinessProfile({
    brandName: CHATBOT_TITLE,
  });

  res.json({
    title: businessProfile.brandName || CHATBOT_TITLE,
    welcomeMessage: businessProfile.welcomeMessage,
    leadPrompt: businessProfile.leadPrompt,
    quickReplies: businessProfile.quickReplies?.length
      ? businessProfile.quickReplies
      : [
        "Pricing details chahiye",
        "Demo book karna hai",
        "WhatsApp setup kaise hota hai?",
        "Mujhe contact karo",
      ],
    firebaseReady: isFirestoreReady(),
    workspaceId,
  });
});

app.post("/api/chatbot/message", async (req, res) => {
  try {
    const { message, visitor, locale, languages, sessionId: rawSessionId, workspaceId: rawWorkspaceId } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "Visitor message is required." });
    }

    const workspaceId = String(rawWorkspaceId || req.query.workspace || APP_WORKSPACE_ID).trim();
    const workspaceOwner = await findUserByWorkspaceId(workspaceId);
    const businessProfile = workspaceOwner
      ? getUserBusinessProfile(workspaceOwner)
      : normalizeBusinessProfile({ brandName: CHATBOT_TITLE });
    const localeHint = buildLocaleHint(locale, languages, req.headers["accept-language"]);
    const sessionId = getChatbotSessionId(rawSessionId);
    const visitorData = visitor && typeof visitor === "object" ? visitor : {};
    const businessContext = buildBusinessProfileContext(businessProfile) || CHATBOT_BUSINESS_CONTEXT;
    const reply = await generateAiReply(String(message).trim(), businessContext, localeHint);
    const interestedLead = isLikelyInterestedLead(message, visitorData);

    let savedLead = null;
    if (workspaceOwner && interestedLead) {
      savedLead = await upsertLeadForUser(workspaceOwner, {
        name: visitorData.name || "Website Lead",
        contact: visitorData.contact,
        interest: visitorData.interest || String(message).trim().slice(0, 80),
        notes: visitorData.notes || `${businessProfile.leadPrompt}\nLast message: ${String(message).trim()}`,
        source: "Website Chatbot",
        channel: "website",
        status: "New",
      }, "website");

      await addOwnerNotification(workspaceOwner._id.toString(), {
        type: "lead",
        title: "New interested website lead",
        message: `${savedLead?.name || "A website visitor"} showed buying intent in the chatbot.`,
        leadName: savedLead?.name || "",
        leadContact: savedLead?.contact || "",
        workspaceId,
      });
    }

    const firestoreLead = interestedLead
      ? await saveFirestoreLead(workspaceId, {
        name: visitorData.name || "Website Lead",
        contact: visitorData.contact,
        interest: visitorData.interest || String(message).trim().slice(0, 80),
        notes: visitorData.notes,
        source: "Website Chatbot",
        channel: "website",
        status: visitorData.status || "New",
        sessionId,
        leadType: "website-chatbot",
        integration: "website-chatbot",
        lastMessage: String(message).trim(),
        lastReply: reply,
      }, "website")
      : null;

    const effectiveLead = firestoreLead || savedLead;

    if (workspaceOwner) {
      await usersCollection.updateOne(
        { _id: workspaceOwner._id },
        {
          $push: {
            replyHistory: {
              message: String(message).trim(),
              business: businessContext,
              reply,
              channel: "website",
              automationMode: "website-chatbot",
              leadName: effectiveLead?.name || String(visitorData.name || "").trim(),
              leadContact: effectiveLead?.contact || String(visitorData.contact || "").trim(),
              leadSource: "Website Chatbot",
              createdAt: new Date(),
            },
          },
        }
      );
    }

    await saveFirestoreHistory(workspaceId, {
      sessionId,
      message: String(message).trim(),
      reply,
      business: businessContext,
      channel: "website",
      automationMode: "website-chatbot",
      leadId: effectiveLead?.id || "",
      leadName: effectiveLead?.name || String(visitorData.name || "").trim(),
      leadContact: effectiveLead?.contact || String(visitorData.contact || "").trim(),
      leadSource: "Website Chatbot",
      integration: "website-chatbot",
    });

    res.json({
      reply,
      sessionId,
      lead: effectiveLead,
      leadSaved: Boolean(effectiveLead),
      ownerNotified: Boolean(workspaceOwner && interestedLead),
      firebaseReady: isFirestoreReady(),
    });
  } catch (error) {
    const publicMessage = error instanceof AiReplyError
      ? "Chatbot reply unavailable right now. Check Gemini API configuration and try again."
      : "Failed to process chatbot message right now. Please try again.";

    res.status(503).json({ message: publicMessage });
  }
});

app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(503).send("Webhook verify token is not configured.");
  }

  if (mode === "subscribe" && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.get("/api/instagram/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return res.status(503).send("Instagram webhook verify token is not configured.");
  }

  if (mode === "subscribe" && token === INSTAGRAM_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/api/whatsapp/webhook", sensitiveRateLimiter, whatsappWebhookJsonParser, (req, res) => {
  if (!verifyWhatsAppWebhookSignature(req)) {
    return res.sendStatus(403);
  }

  if (req.body?.object !== "whatsapp_business_account") {
    return res.sendStatus(404);
  }

  processIncomingWhatsAppPayload(req.body).catch((error) => {
    console.error("WhatsApp webhook processing failed:", error.message);
  });

  return res.sendStatus(200);
});

app.post("/api/instagram/webhook", sensitiveRateLimiter, whatsappWebhookJsonParser, (req, res) => {
  if (!verifyInstagramWebhookSignature(req)) {
    return res.status(401).json({ message: "Invalid Instagram webhook signature." });
  }

  processIncomingInstagramPayload(req.body)
    .catch((error) => {
      console.error("Instagram webhook processing failed:", error);
    });

  return res.sendStatus(200);
});

app.post("/api/whatsapp/send", requireAuth, async (req, res) => {
  try {
    const { to, message, leadName, leadContact, leadSource } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ message: "WhatsApp message is required." });
    }

    const authUser = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    const preparedUser = authUser ? await ensureUserWorkspaceIdentity(authUser) : null;
    const workspaceId = preparedUser?.publicWorkspaceId || APP_WORKSPACE_ID;
    const result = await sendWhatsAppTextMessage(to || leadContact, String(message).trim());
    const recipient = normalizeWhatsappRecipient(to || leadContact);

    const savedLead = await saveFirestoreLead(workspaceId, {
      name: String(leadName || "").trim() || "WhatsApp Lead",
      contact: recipient,
      interest: "WhatsApp follow-up",
      source: leadSource || "WhatsApp",
      channel: "whatsapp",
      status: "Follow-up",
      sessionId: recipient ? `whatsapp:${recipient}` : "",
      leadType: "whatsapp",
      integration: "whatsapp-cloud-api",
      lastReply: String(message).trim(),
    }, "whatsapp");

    if (preparedUser) {
      await addOwnerNotification(preparedUser._id.toString(), {
        type: "whatsapp",
        title: "WhatsApp message sent",
        message: `A WhatsApp reply was sent to ${savedLead?.name || recipient || "a contact"}.`,
        leadName: savedLead?.name || "",
        leadContact: savedLead?.contact || recipient,
        workspaceId,
      });
    }

    await saveFirestoreHistory(workspaceId, {
      sessionId: recipient ? `whatsapp:${recipient}` : "",
      message: "",
      reply: String(message).trim(),
      business: WHATSAPP_BUSINESS_CONTEXT,
      channel: "whatsapp",
      automationMode: "whatsapp-manual",
      leadId: savedLead?.id || "",
      leadName: savedLead?.name || String(leadName || "").trim(),
      leadContact: savedLead?.contact || recipient,
      leadSource: leadSource || "WhatsApp",
      integration: "whatsapp-cloud-api",
    });

    res.json({ success: true, result });
  } catch (error) {
    res.status(503).json({ message: error.message || "Failed to send WhatsApp message." });
  }
});

app.post("/api/instagram/send", requireAuth, async (req, res) => {
  try {
    const recipientId = normalizeInstagramRecipient(req.body?.recipientId);
    const message = String(req.body?.message || "").trim();
    const leadName = String(req.body?.leadName || "").trim() || "Instagram Lead";

    if (!recipientId || !message) {
      return res.status(400).json({ message: "recipientId and message are required." });
    }

    const authUser = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!authUser) {
      return res.status(404).json({ message: "User not found." });
    }
    const preparedUser = await ensureUserWorkspaceIdentity(authUser);
    const workspaceId = preparedUser?.publicWorkspaceId || APP_WORKSPACE_ID;

    await sendInstagramTextMessage(recipientId, message);

    const savedLead = await saveFirestoreLead(workspaceId, {
      name: leadName,
      contact: recipientId,
      interest: "Instagram DM",
      notes: "Sent via dashboard Instagram integration",
      source: "Instagram",
      channel: "instagram",
      status: "Follow-up",
      sessionId: `instagram:${recipientId}`,
      leadType: "instagram-dm",
      integration: "instagram-graph-api",
      lastMessage: message,
      lastReply: message,
    }, "instagram");

    await saveFirestoreHistory(workspaceId, {
      sessionId: `instagram:${recipientId}`,
      message,
      reply: message,
      business: buildBusinessProfileContext(getUserBusinessProfile(preparedUser)),
      channel: "instagram",
      automationMode: "instagram-manual",
      leadId: savedLead?.id || "",
      leadName: savedLead?.name || leadName,
      leadContact: savedLead?.contact || recipientId,
      leadSource: "Instagram",
      integration: "instagram-graph-api",
    });

    res.json({ message: "Instagram message sent successfully." });
  } catch (error) {
    res.status(500).json({ message: error.message || "Instagram send failed." });
  }
});

app.post("/signup", sensitiveRateLimiter, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ success: false, message: "Database unavailable. Try again." });
    }

    const email = sanitizeText(req.body?.email, 320).toLowerCase();
    const password = String(req.body?.password || "");
    if (!validateEmail(email)) {
      return res.status(400).json({ success: false, message: "Valid email is required." });
    }

    if (!validatePasswordStrength(password)) {
      return res.status(400).json({ success: false, message: "Password must be 8+ chars with upper, lower, number, and special character." });
    }

    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const publicWorkspaceId = generatePublicWorkspaceId(email);
    await usersCollection.insertOne({
      email,
      password: hashed,
      publicWorkspaceId,
      usage: 0,
      premium: false,
      planName: "Free",
      businessProfile: normalizeBusinessProfile({
        brandName: email ? email.split("@")[0] : DEFAULT_BUSINESS_PROFILE.brandName,
      }),
      automationSettings: { ...DEFAULT_AUTOMATION_SETTINGS },
      leadPipeline: [],
      notifications: [],
      replyHistory: [],
    });

    res.status(201).json({ success: true, message: "User created successfully. Please login." });
  } catch (_error) {
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

app.post("/login", sensitiveRateLimiter, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, private, max-age=0");
    res.set("Pragma", "no-cache");

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const email = sanitizeText(req.body?.email, 320).toLowerCase();
    const password = String(req.body?.password || "");
    if (!validateEmail(email) || !password) {
      return res.status(400).json({ message: "Valid email and password are required." });
    }

    const user = await usersCollection.findOne({ email });
    if (!user) {
      return res.json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.json({ message: "Wrong password" });
    }

    const token = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, user: await buildPublicUser(user) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/me", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ user: await buildPublicUser(user) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/business-profile", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const preparedUser = await ensureUserWorkspaceIdentity(user);
    res.json({
      publicWorkspaceId: preparedUser.publicWorkspaceId,
      businessProfile: getUserBusinessProfile(preparedUser),
    });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/business-profile", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const businessProfile = normalizeBusinessProfile(req.body || {});
    await usersCollection.updateOne(
      { _id: getUserLookupId(req.authUserId) },
      { $set: { businessProfile } }
    );

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    const preparedUser = user ? await ensureUserWorkspaceIdentity(user) : null;

    res.json({
      message: "Business profile saved successfully.",
      businessProfile,
      publicWorkspaceId: preparedUser?.publicWorkspaceId || "",
    });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/notifications", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { notifications: 1 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ notifications: sortNotifications(getUserNotifications(user)).slice(0, 50) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/notifications/read-all", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const notifications = sortNotifications(getUserNotifications(user)).map((item) => ({
      ...item,
      read: true,
    }));

    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { notifications } }
    );

    res.json({ message: "Notifications marked as read.", notifications });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/followups/rules", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { followupRules: 1 } }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ rules: getFollowupRules(user) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/followups/rules", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const rules = normalizeFollowupRules(req.body?.rules || []);
    await usersCollection.updateOne(
      { _id: getUserLookupId(req.authUserId) },
      { $set: { followupRules: rules } }
    );

    res.json({ message: "Follow-up rules saved successfully.", rules });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/followups/logs", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { followupLogs: 1 } }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ logs: getFollowupLogs(user).slice(0, 50) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/api/booking/slots", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const requestedDate = String(req.query.date || "").trim();
    if (!requestedDate) {
      return res.status(400).json({ message: "date is required (YYYY-MM-DD)." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { appointments: 1 } }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const slots = buildDailySlots(requestedDate, getUserAppointments(user));
    return res.json({ date: requestedDate, slots });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to fetch booking slots." });
  }
});

app.post("/api/booking/confirm", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const {
      date,
      time,
      customerName,
      customerContact,
      note,
      source,
    } = req.body || {};

    const bookingDate = String(date || "").trim();
    const bookingTime = String(time || "").trim();
    if (!bookingDate || !bookingTime) {
      return res.status(400).json({ message: "date and time are required." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const appointments = getUserAppointments(user);
    const alreadyBooked = appointments.some((item) =>
      String(item?.date || "") === bookingDate && String(item?.time || "") === bookingTime
    );
    if (alreadyBooked) {
      return res.status(409).json({ message: "This slot is already booked." });
    }

    const appointment = {
      id: `apt-${crypto.randomUUID()}`,
      date: bookingDate,
      time: bookingTime,
      customerName: String(customerName || "").trim() || "Walk-in lead",
      customerContact: String(customerContact || "").trim(),
      note: String(note || "").trim(),
      source: String(source || "Dashboard").trim(),
      status: "Confirmed",
      createdAt: new Date(),
    };

    const nextAppointments = [appointment, ...appointments].slice(0, 400);
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { appointments: nextAppointments } }
    );

    await addOwnerNotification(user._id.toString(), {
      type: "appointment",
      title: "Appointment booked",
      message: `${appointment.customerName} booked ${bookingDate} ${bookingTime}.`,
      leadName: appointment.customerName,
      leadContact: appointment.customerContact,
      workspaceId: user.publicWorkspaceId || APP_WORKSPACE_ID,
    });

    return res.json({ message: "Appointment confirmed.", appointment, appointments: nextAppointments.slice(0, 20) });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to confirm appointment." });
  }
});

app.get("/api/booking/list", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { appointments: 1 } }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const appointments = getUserAppointments(user)
      .slice()
      .sort((a, b) => {
        const aKey = `${a?.date || ""} ${a?.time || ""}`;
        const bKey = `${b?.date || ""} ${b?.time || ""}`;
        return bKey.localeCompare(aKey);
      })
      .slice(0, 50);

    return res.json({ appointments });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to fetch appointments." });
  }
});

app.get("/api/crm/config", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { crmConfig: 1 } }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.json({ config: getUserCrmConfig(user) });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to load CRM config." });
  }
});

app.post("/api/crm/config", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const raw = req.body && typeof req.body === "object" ? req.body : {};
    const config = getUserCrmConfig(raw);
    if (!["none", "hubspot", "zoho", "pipedrive", "webhook"].includes(config.provider)) {
      return res.status(400).json({ message: "Invalid CRM provider." });
    }

    await usersCollection.updateOne(
      { _id: getUserLookupId(req.authUserId) },
      { $set: { crmConfig: config } }
    );

    return res.json({ message: "CRM config saved.", config });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to save CRM config." });
  }
});

app.post("/api/crm/sync-leads", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const config = getUserCrmConfig(user);
    if (!config.enabled || config.provider === "none") {
      return res.status(400).json({ message: "CRM is not enabled." });
    }

    const leads = sortLeadPipeline(getLeadPipeline(user)).slice(0, 100);
    let synced = 0;
    const errors = [];

    if (config.provider === "webhook") {
      if (!config.webhookUrl) {
        return res.status(400).json({ message: "Webhook URL is required for webhook CRM provider." });
      }

      for (const lead of leads) {
        const payload = {
          name: lead.name || "",
          contact: lead.contact || "",
          interest: lead.interest || "",
          source: lead.source || "",
          status: lead.status || "",
          assignedTo: lead.assignedTo || "",
          updatedAt: lead.updatedAt || new Date(),
        };

        try {
          const webhookResponse = await fetch(config.webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
              provider: "replypilot",
              event: "lead.sync",
              lead: payload,
            }),
          });
          if (!webhookResponse.ok) {
            errors.push(`Lead ${lead.id}: webhook failed (${webhookResponse.status})`);
            continue;
          }
          synced += 1;
        } catch (error) {
          errors.push(`Lead ${lead.id}: ${error.message}`);
        }
      }
    } else {
      // MVP placeholder: mark as synced logically for native providers until OAuth adapters are added.
      synced = leads.length;
    }

    return res.json({
      message: "CRM lead sync completed.",
      provider: config.provider,
      total: leads.length,
      synced,
      failed: leads.length - synced,
      errors: errors.slice(0, 10),
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to sync leads to CRM." });
  }
});

app.post("/api/voice/session", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const {
      transcript,
      channel,
      lead,
      language,
    } = req.body || {};

    const cleanTranscript = String(transcript || "").trim();
    if (!cleanTranscript) {
      return res.status(400).json({ message: "transcript is required." });
    }

    const authUser = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!authUser) {
      return res.status(404).json({ message: "User not found." });
    }
    const user = await ensureUserWorkspaceIdentity(authUser);
    const normalizedChannel = normalizeChannel(channel);
    const workspaceId = user.publicWorkspaceId || APP_WORKSPACE_ID;
    const businessContext = buildBusinessProfileContext(getUserBusinessProfile(user));

    const localeHint = buildLocaleHint(language || "", [], req.headers["accept-language"]);
    const voiceReplyContext = [
      businessContext,
      "Input mode: voice conversation",
      "Voice assistant policy: give a direct and practical business answer first.",
      "Do not ask for name/contact details unless the customer explicitly asks for callback, booking confirmation, or quote follow-up.",
      "If the question is generic about services/support, provide a concise business capability answer in 2-3 sentences.",
    ].join(" | ");
    const aiReply = await generateAiReply(cleanTranscript, voiceReplyContext, localeHint);
    const leadPayload = lead && typeof lead === "object" ? lead : {};
    const savedLead = await upsertLeadForUser(user, leadPayload, normalizedChannel);

    const voiceSession = {
      id: `voice-${crypto.randomUUID()}`,
      transcript: cleanTranscript,
      reply: aiReply,
      channel: normalizedChannel,
      language: String(language || "auto").trim() || "auto",
      leadName: savedLead?.name || String(leadPayload.name || "").trim(),
      leadContact: savedLead?.contact || String(leadPayload.contact || "").trim(),
      createdAt: new Date(),
      ttsPreview: aiReply, // MVP text preview for future TTS provider hookup
    };

    const nextVoiceSessions = [voiceSession, ...getUserVoiceSessions(user)].slice(0, 100);
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { voiceSessions: nextVoiceSessions } }
    );

    await saveFirestoreHistory(workspaceId, {
      sessionId: voiceSession.id,
      message: cleanTranscript,
      reply: aiReply,
      business: businessContext,
      channel: normalizedChannel,
      automationMode: "voice-ai",
      leadId: savedLead?.id || "",
      leadName: voiceSession.leadName,
      leadContact: voiceSession.leadContact,
      leadSource: normalizedChannel,
      integration: "voice-ai",
      language: voiceSession.language,
      tone: "professional",
      formality: "neutral",
    });

    return res.json({
      message: "Voice session processed.",
      session: voiceSession,
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to process voice session." });
  }
});

app.get("/api/voice/sessions", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { voiceSessions: 1 } }
    );
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.json({ sessions: getUserVoiceSessions(user).slice(0, 20) });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to load voice sessions." });
  }
});

app.get("/history", requireAuth, async (req, res) => {
  try {
    const authUser = isDatabaseReady()
      ? await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) })
      : null;
    const preparedUser = authUser ? await ensureUserWorkspaceIdentity(authUser) : null;
    if (!preparedUser) {
      return res.status(503).json({ message: "Workspace unavailable. Try again." });
    }
    const workspaceId = preparedUser.publicWorkspaceId || APP_WORKSPACE_ID;

    if (isFirestoreReady()) {
      const history = await listFirestoreHistory(workspaceId, 180);
      return res.json({ history });
    }

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { replyHistory: 1 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const history = (user.replyHistory || []).slice().reverse();
    res.json({ history });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.get("/leads", requireAuth, async (req, res) => {
  try {
    const authUser = isDatabaseReady()
      ? await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) })
      : null;
    const preparedUser = authUser ? await ensureUserWorkspaceIdentity(authUser) : null;
    if (!preparedUser) {
      return res.status(503).json({ message: "Workspace unavailable. Try again." });
    }
    const workspaceId = preparedUser.publicWorkspaceId || APP_WORKSPACE_ID;

    if (isFirestoreReady()) {
      const leads = await listFirestoreLeads(workspaceId, 120);
      return res.json({ leads });
    }

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne(
      { _id: getUserLookupId(req.authUserId) },
      { projection: { leadPipeline: 1 } }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ leads: sortLeadPipeline(getLeadPipeline(user)) });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/leads", requireAuth, async (req, res) => {
  try {
    const leadPayload = req.body || {};
    if (!hasLeadIdentity(leadPayload)) {
      return res.status(400).json({ message: "Lead name, contact, or interest is required." });
    }

    const fallbackChannel = normalizeChannel(leadPayload.channel);
    const authUser = isDatabaseReady()
      ? await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) })
      : null;
    const preparedUser = authUser ? await ensureUserWorkspaceIdentity(authUser) : null;
    const workspaceId = preparedUser?.publicWorkspaceId || APP_WORKSPACE_ID;

    if (isFirestoreReady()) {
      const savedLead = await saveFirestoreLead(workspaceId, {
        ...leadPayload,
        sessionId: leadPayload.sessionId || (leadPayload.contact ? `manual:${leadPayload.contact}` : ""),
        leadType: "manual",
        integration: fallbackChannel === "whatsapp" ? "whatsapp-dashboard" : "admin-dashboard",
      }, fallbackChannel);

      const leads = await listFirestoreLeads(workspaceId, 120);
      if (preparedUser?._id) {
        await addOwnerNotification(preparedUser._id.toString(), {
          type: "lead",
          title: "Lead saved from dashboard",
          message: `${savedLead?.name || "A new lead"} was saved to your pipeline.`,
          leadName: savedLead?.name || "",
          leadContact: savedLead?.contact || "",
          workspaceId,
        });
      }
      return res.json({
        message: "Lead saved successfully.",
        lead: savedLead,
        leads,
      });
    }

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!preparedUser) {
      return res.status(404).json({ message: "User not found." });
    }

    const savedLead = await upsertLeadForUser(preparedUser, leadPayload, fallbackChannel);
    const refreshedUser = await usersCollection.findOne(
      { _id: preparedUser._id },
      { projection: { leadPipeline: 1 } }
    );
    await addOwnerNotification(preparedUser._id.toString(), {
      type: "lead",
      title: "Lead saved from dashboard",
      message: `${savedLead?.name || "A new lead"} was saved to your pipeline.`,
      leadName: savedLead?.name || "",
      leadContact: savedLead?.contact || "",
      workspaceId,
    });

    res.json({
      message: "Lead saved successfully.",
      lead: savedLead,
      leads: sortLeadPipeline(getLeadPipeline(refreshedUser)),
    });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/change-password", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required." });
    }

    const strongPassword = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
    if (!strongPassword.test(newPassword || "")) {
      return res.status(400).json({ message: "New password must be 8+ chars with upper, lower, number, and special character." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword } }
    );

    res.json({ message: "Password updated successfully." });
  } catch (_error) {
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/api/reply", sensitiveRateLimiter, requireAuth, async (req, res) => {
  try {
    const {
      message,
      business,
      locale,
      languages,
      channel,
      lead,
      targetLanguage,
      tone,
      formality,
    } = req.body || {};
    const cleanMessage = sanitizeText(message, 4000);
    if (!cleanMessage) {
      return res.status(400).json({ reply: "Message is required." });
    }
    const localeHint = buildLocaleHint(locale, languages, req.headers["accept-language"]);
    const normalizedChannel = normalizeChannel(channel);
    const replyLanguage = normalizeReplyLanguage(targetLanguage);
    const replyTone = normalizeReplyTone(tone);
    const replyFormality = normalizeReplyFormality(formality);

    if (!isDatabaseReady()) {
      return res.status(503).json({ reply: "Database unavailable. Try again." });
    }

    const authUser = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    const user = authUser ? await ensureUserWorkspaceIdentity(authUser) : null;
    if (!user) {
      return res.status(404).json({ reply: "User not found." });
    }

    if (!user.premium && user.usage >= FREE_REPLY_LIMIT) {
      return res.json({ reply: "Limit reached! Upgrade to premium." });
    }

    const workspaceId = user.publicWorkspaceId || APP_WORKSPACE_ID;
    const baseBusinessContext = String(business || "").trim() || buildBusinessProfileContext(getUserBusinessProfile(user));
    const languageInstruction = replyLanguage === "auto"
      ? "Language preference: auto-detect from customer message."
      : `Language preference: reply in ${replyLanguage}.`;
    const businessContext = `${baseBusinessContext}\n\nReply style:\n- ${languageInstruction}\n- Tone: ${replyTone}\n- Formality: ${replyFormality}`;
    let reply;
    try {
      reply = await generateAiReply(cleanMessage, businessContext, localeHint);
    } catch (error) {
      const publicMessage = error instanceof AiReplyError
        ? "AI reply unavailable right now. Check Gemini API configuration and try again."
        : "Failed to generate AI reply right now. Please try again.";
      return res.status(503).json({ reply: publicMessage });
    }

    const savedLead = await upsertLeadForUser(user, lead || {}, normalizedChannel);
    const firestoreLead = await saveFirestoreLead(workspaceId, {
      ...(lead || {}),
      source: lead?.source || normalizedChannel,
      channel: normalizedChannel,
      sessionId: lead?.sessionId || (lead?.contact ? `${normalizedChannel}:${lead.contact}` : ""),
      integration: normalizedChannel === "whatsapp" ? "whatsapp-dashboard" : "admin-dashboard",
      lastMessage: cleanMessage,
      lastReply: reply,
    }, normalizedChannel);

    const effectiveLead = firestoreLead || savedLead;
    if (effectiveLead) {
      await addOwnerNotification(user._id.toString(), {
        type: normalizedChannel === "whatsapp" ? "whatsapp" : "lead",
        title: normalizedChannel === "whatsapp" ? "WhatsApp lead updated" : "Lead updated from dashboard",
        message: `${effectiveLead.name || "A lead"} has new conversation activity.`,
        leadName: effectiveLead.name || "",
        leadContact: effectiveLead.contact || "",
        workspaceId,
      });
    }

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $inc: { usage: 1 },
        $push: {
          replyHistory: {
            message: cleanMessage,
            business: businessContext,
            reply,
            channel: normalizedChannel,
            automationMode: "auto",
            language: replyLanguage,
            tone: replyTone,
            formality: replyFormality,
            leadName: effectiveLead?.name || String(lead?.name || "").trim(),
            leadContact: effectiveLead?.contact || String(lead?.contact || "").trim(),
            leadSource: effectiveLead?.source || normalizeLeadSource(lead?.source, normalizedChannel),
            createdAt: new Date(),
          },
        },
      }
    );

    await saveFirestoreHistory(workspaceId, {
      sessionId: String(lead?.sessionId || "").trim(),
      message: cleanMessage,
      reply,
      business: businessContext,
      channel: normalizedChannel,
      automationMode: normalizedChannel === "whatsapp" ? "whatsapp-auto" : "admin-auto",
      leadId: effectiveLead?.id || "",
      leadName: effectiveLead?.name || String(lead?.name || "").trim(),
      leadContact: effectiveLead?.contact || String(lead?.contact || "").trim(),
      leadSource: effectiveLead?.source || normalizeLeadSource(lead?.source, normalizedChannel),
      integration: normalizedChannel === "whatsapp" ? "whatsapp-dashboard" : "admin-dashboard",
      language: replyLanguage,
      tone: replyTone,
      formality: replyFormality,
    });

    res.json({ reply, lead: effectiveLead });
  } catch (_error) {
    res.status(500).json({ reply: "Internal server error." });
  }
});

app.post("/api/sales/next-best-action", requireAuth, async (req, res) => {
  try {
    const { lead, message } = req.body || {};
    const leadInput = lead && typeof lead === "object" ? lead : {};
    const incomingMessage = String(message || "").trim();

    const suggestion = buildSalesCloserSuggestion(leadInput, incomingMessage);
    let aiEnhancedDraft = suggestion.draft;
    try {
      const context = `
You are a sales closer assistant.
Lead score: ${suggestion.score} (${suggestion.band})
Lead name: ${String(leadInput.name || "").trim() || "Unknown"}
Lead interest: ${String(leadInput.interest || "").trim() || "Not specified"}
Incoming message: ${incomingMessage || "Not provided"}
Next best action: ${suggestion.nextAction}
Write one short conversion-focused response.
      `.trim();
      aiEnhancedDraft = await generateAiReply(incomingMessage || suggestion.draft, context, "Sales closer");
    } catch (_error) {
      // Keep deterministic fallback draft if AI is unavailable.
    }

    return res.json({
      score: suggestion.score,
      band: suggestion.band,
      nextAction: suggestion.nextAction,
      draft: aiEnhancedDraft || suggestion.draft,
    });
  } catch (_error) {
    return res.status(500).json({ message: "Failed to generate sales closer suggestion." });
  }
});

app.post("/create-order", requireAuth, async (req, res) => {
  try {
    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    const user = await usersCollection.findOne({ _id: getUserLookupId(req.authUserId) });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const order = await razorpay.orders.create({
      amount: premiumPlan.amount,
      currency: premiumPlan.currency,
      receipt: `p_${Date.now()}`,
      notes: {
        userId: req.authUserId,
      },
    });

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          pendingOrderId: order.id,
        },
      }
    );

    res.json({
      key: paymentConfig.key_id,
      amount: order.amount,
      currency: order.currency,
      orderId: order.id,
    });
  } catch (error) {
    console.error("Create order failed:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

app.post("/verify-payment", requireAuth, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body || {};

    if (!isDatabaseReady()) {
      return res.status(503).json({ message: "Database unavailable. Try again." });
    }

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Payment verification data is required." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", paymentConfig.key_secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature." });
    }

    const result = await usersCollection.updateOne(
      {
        _id: getUserLookupId(req.authUserId),
        pendingOrderId: razorpay_order_id,
      },
      {
        $set: {
          premium: true,
          planName: "Premium",
          lastPaymentId: razorpay_payment_id,
          lastOrderId: razorpay_order_id,
          premiumActivatedAt: new Date(),
          premiumExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        },
        $unset: {
          pendingOrderId: "",
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ message: "User not found or order mismatch." });
    }

    res.json({ message: "Premium activated successfully." });
  } catch (error) {
    console.error("Verify payment failed:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

const PORT = Number(process.env.PORT) || 3000;

process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logError("uncaughtException", { message: error?.message || "Unknown error" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setInterval(runScheduledWhatsappFollowups, FOLLOWUP_RUN_INTERVAL_MS);
});
