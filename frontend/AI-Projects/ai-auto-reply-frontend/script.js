
// Payment config (only once at the top)
const paymentConfig = {
  key: "YOUR_KEY_ID",
};
const apiBaseUrl = "https://ai-auto-reply-tool.onrender.com";
let authToken = localStorage.getItem("authToken") || "";
let currentUser = null;
let historyData = [];

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

function showLanding() {
  document.getElementById("landing-page").classList.remove("hidden");
  document.getElementById("app-page").classList.add("hidden");
}

function showApp() {
  document.getElementById("landing-page").classList.add("hidden");
  document.getElementById("app-page").classList.remove("hidden");
}

function showView(viewId) {
  const views = document.querySelectorAll(".view");
  views.forEach((view) => view.classList.add("hidden"));
  document.getElementById(viewId).classList.remove("hidden");

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

  try {
    const { response, data } = await apiRequest("/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok || !data.token) {
      console.error("Login error:", data);
      setLandingStatus(data.message || "Login failed");
      return;
    }
    authToken = data.token;
    localStorage.setItem("authToken", authToken);
    currentUser = data.user || null;
    showApp();
    showView("dashboard-view");
    await loadProfile();
    await loadHistory();
    setAppStatus("Login successful.");
  } catch (err) {
    console.error("Login exception:", err);
    setLandingStatus("Login failed (network or CORS error)");
  }
}

function logout() {
  authToken = "";
  currentUser = null;
  localStorage.removeItem("authToken");
  document.getElementById("output").innerText = "";
  document.getElementById("history-list").innerHTML = "";
  document.getElementById("profile-summary").innerHTML = "";
  showLanding();
  setLandingStatus("Logged out successfully.");
}

async function loadProfile() {
  const { response, data } = await apiRequest("/me", { method: "GET" }, true);

  if (!response.ok) {
    if (response.status === 401) {
      logout();
      return;
    }
    setAppStatus(data.message || "Failed to load profile.");
    return;
  }

  currentUser = data.user;
  const premiumText = currentUser.premium ? "Active" : "Inactive";
  const paymentText = currentUser.lastPaymentId || "Not available";
  const orderText = currentUser.lastOrderId || "Not available";
  const activatedAtText = currentUser.premiumActivatedAt
    ? new Date(currentUser.premiumActivatedAt).toLocaleString()
    : "Not available";
  const expiryText = currentUser.premiumExpiresAt
    ? new Date(currentUser.premiumExpiresAt).toLocaleDateString()
    : "Not available";

  document.getElementById("profile-summary").innerHTML = `
    <p><strong>Email:</strong> ${currentUser.email}</p>
    <p><strong>Plan:</strong> ${currentUser.planName || "Free"}</p>
    <p><strong>Premium Status:</strong> ${premiumText}</p>
    <p><strong>Usage Count:</strong> ${currentUser.usage}</p>
    <p><strong>Last Payment ID:</strong> ${paymentText}</p>
    <p><strong>Last Order ID:</strong> ${orderText}</p>
    <p><strong>Premium Activated:</strong> ${activatedAtText}</p>
    <p><strong>Premium Expires:</strong> ${expiryText}</p>
  `;
}

async function loadHistory() {
  const { response, data } = await apiRequest("/history", { method: "GET" }, true);

  if (!response.ok) {
    setAppStatus(data.message || "Failed to load history.");
    return;
  }

  historyData = data.history || [];
  applyHistoryFilters();
}

function renderHistory(items) {
  const historyList = document.getElementById("history-list");
  if (!items.length) {
    historyList.innerHTML = "<p>No replies found for selected filters.</p>";
    return;
  }

  historyList.innerHTML = items
    .map((item) => {
      const createdAt = new Date(item.createdAt).toLocaleString();
      const businessLine = item.business ? `<p><strong>Business:</strong> ${item.business}</p>` : "";
      return `<div class="history-item"><p><strong>Message:</strong> ${item.message}</p>${businessLine}<p><strong>Reply:</strong> ${item.reply}</p><p><small>${createdAt}</small></p></div>`;
    })
    .join("");
}

function applyHistoryFilters() {
  const search = document.getElementById("history-search")?.value.trim().toLowerCase() || "";
  const selectedDate = document.getElementById("history-date")?.value || "";

  const filtered = historyData.filter((item) => {
    const textMatch = !search
      || item.message?.toLowerCase().includes(search)
      || item.reply?.toLowerCase().includes(search)
      || item.business?.toLowerCase().includes(search);

    const itemDate = item.createdAt ? new Date(item.createdAt).toISOString().slice(0, 10) : "";
    const dateMatch = !selectedDate || itemDate === selectedDate;

    return textMatch && dateMatch;
  });

  renderHistory(filtered);
}

function clearHistoryFilters() {
  const searchInput = document.getElementById("history-search");
  const dateInput = document.getElementById("history-date");
  if (searchInput) searchInput.value = "";
  if (dateInput) dateInput.value = "";
  renderHistory(historyData);
}

async function generateReply() {
  const business = document.getElementById("business").value.trim();
  const message = document.getElementById("message").value.trim();

  if (!message) {
    setAppStatus("Please enter customer message.");
    return;
  }

  const { response, data } = await apiRequest(
    "/api/reply",
    {
      method: "POST",
      body: JSON.stringify({ business, message }),
    },
    true
  );

  if (!response.ok) {
    setAppStatus(data.reply || data.message || "Failed to generate reply.");
    return;
  }

  document.getElementById("output").innerText = data.reply || "No reply generated.";
  setAppStatus("Reply generated.");
  await loadProfile();
  await loadHistory();
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

  setAppStatus(data.message || "Password update request sent.");
  if (response.ok) {
    document.getElementById("current-password").value = "";
    document.getElementById("new-password").value = "";
  }
}

async function verifyPayment(paymentResponse) {
  const { data } = await apiRequest(
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

  setAppStatus(data.message || "Premium updated");
  await loadProfile();
}

function upgradeToPremium() {
  if (!authToken) {
    setAppStatus("Login first to upgrade your account.");
    return;
  }

  if (!window.Razorpay) {
    setAppStatus("Razorpay SDK not loaded.");
    return;
  }

  createOrderAndOpenCheckout();
}

async function createOrderAndOpenCheckout() {
  const { response, data } = await apiRequest("/create-order", { method: "POST" }, true);

  if (!response.ok) {
    setAppStatus(data.message || "Unable to create order.");
    return;
  }

  const options = {
    key: data.key || paymentConfig.key,
    amount: data.amount,
    currency: data.currency,
    order_id: data.orderId,
    name: "AI Auto Reply Tool",
    description: "Premium Upgrade",
    handler: async function(paymentResponse) {
      await verifyPayment(paymentResponse);
    },
    theme: {
      color: "#38bdf8",
    },
  };

  const razorpayInstance = new window.Razorpay(options);
  razorpayInstance.open();
}

async function bootstrap() {
  if (!authToken) {
    showLanding();
    return;
  }

  const { response } = await apiRequest("/me", { method: "GET" }, true);
  if (!response.ok) {
    logout();
    return;
  }

  showApp();
  showView("dashboard-view");
  await loadProfile();
  await loadHistory();
}

bootstrap();
