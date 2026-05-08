/* eslint-disable no-console */
const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:3000";

async function run() {
  const checks = [
    { name: "health", path: "/health", expected: 200 },
    { name: "chatbot-config", path: "/api/chatbot/config", expected: 200 },
    { name: "widget-js", path: "/widget.js", expected: 200 },
  ];

  let failed = 0;
  for (const check of checks) {
    try {
      const response = await fetch(`${baseUrl}${check.path}`);
      const ok = response.status === check.expected;
      console.log(`${check.name}: ${response.status} ${ok ? "OK" : "FAIL"}`);
      if (!ok) failed += 1;
    } catch (error) {
      failed += 1;
      console.log(`${check.name}: ERROR ${error.message}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  } else {
    console.log("Smoke test passed.");
  }
}

run();
