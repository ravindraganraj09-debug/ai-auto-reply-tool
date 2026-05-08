(() => {
  const config = window.aiToolConfig || {};
  const businessId = String(config.businessId || "").trim();

  if (!businessId) {
    // Fail fast so client knows configuration is missing.
    console.error("ReplyPilot widget: missing aiToolConfig.businessId");
    return;
  }

  const currentScript = document.currentScript;
  let baseUrl = window.location.origin;
  if (currentScript?.src) {
    try {
      baseUrl = new URL(currentScript.src).origin;
    } catch (_error) {
      // Keep page origin as fallback.
    }
  }

  const iframe = document.createElement("iframe");
  iframe.src = `${baseUrl}/index.html?widget=1&workspace=${encodeURIComponent(businessId)}`;
  iframe.title = "ReplyPilot Chat Widget";
  iframe.style.position = "fixed";
  iframe.style.right = "20px";
  iframe.style.bottom = "20px";
  iframe.style.width = "380px";
  iframe.style.maxWidth = "calc(100vw - 24px)";
  iframe.style.height = "620px";
  iframe.style.border = "0";
  iframe.style.borderRadius = "22px";
  iframe.style.boxShadow = "0 20px 50px rgba(15, 23, 42, 0.25)";
  iframe.style.zIndex = "2147483647";
  iframe.loading = "lazy";
  iframe.allow = "clipboard-write";

  const mount = () => {
    if (!document.body) {
      return;
    }
    document.body.appendChild(iframe);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
