import { spaceQueryClient } from "@hatch/space-sdk/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import "./theme.css";

// ---- Crash recording ----
// The "hit a snag" screen used to swallow the real error, so a crash
// on a player's phone left no trace anywhere. Now every crash is
// recorded three ways: kept on the device (localStorage, survives the
// reload), sent to the site's own crash log (reportClientError — the
// Owner reads it back with getClientErrors), and shown in plain text
// on the snag screen itself so it can be screenshotted and sent in.
type CrashRecord = {
  message: string;
  stack: string;
  componentStack: string;
  at: string;
};

const CRASH_KEY = "vv-last-crash";
let crashReported = false;

function recordCrash(error: unknown, info?: ErrorInfo) {
  const err = error instanceof Error ? error : new Error(String(error));
  const record: CrashRecord = {
    message: err.message || err.name || "Unknown error",
    stack: (err.stack ?? "").slice(0, 4000),
    componentStack: (info?.componentStack ?? "").slice(0, 4000),
    at: new Date().toISOString(),
  };
  try {
    localStorage.setItem(CRASH_KEY, JSON.stringify(record));
  } catch {
    /* storage unavailable — the server report below still applies */
  }
  if (!crashReported) {
    crashReported = true;
    let playerKey = "";
    try {
      playerKey = localStorage.getItem("leonida-player-key") ?? "";
    } catch {
      /* storage unavailable */
    }
    api
      .reportClientError({
        playerKey: playerKey.slice(0, 80),
        message: record.message.slice(0, 500),
        stack: record.stack,
        componentStack: record.componentStack,
        screen: (document.title || "ViceSunshine").slice(0, 120),
        userAgent: (navigator.userAgent || "").slice(0, 300),
      })
      .catch(() => {
        /* offline or server unreachable — the on-device copy remains */
      });
  }
  return record;
}

function loadLastCrash(): CrashRecord | null {
  try {
    const raw = localStorage.getItem(CRASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CrashRecord>;
    if (typeof parsed.message !== "string") return null;
    return {
      message: parsed.message,
      stack: typeof parsed.stack === "string" ? parsed.stack : "",
      componentStack: typeof parsed.componentStack === "string" ? parsed.componentStack : "",
      at: typeof parsed.at === "string" ? parsed.at : "",
    };
  } catch {
    return null;
  }
}

// Last-resort fallback: if anything throws during render, show a readable
// message with a way back instead of a blank dark screen — and record
// what actually crashed (see recordCrash above).
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; crash: CrashRecord | null }
> {
  override state: { failed: boolean; crash: CrashRecord | null } = {
    failed: false,
    crash: null,
  };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ crash: recordCrash(error, info) });
  }

  override render() {
    if (this.state.failed) {
      const crash = this.state.crash ?? loadLastCrash();
      const detail = crash
        ? [crash.message, crash.stack, crash.componentStack].filter(Boolean).join("\n")
        : "";
      return (
        <div
          style={{
            minHeight: "100dvh",
            background: "#0b0b14",
            color: "#f4f1ea",
            fontFamily: "system-ui, sans-serif",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <div style={{ maxWidth: 420, textAlign: "center" }}>
            <p
              style={{
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: "0.02em",
                margin: "0 0 8px",
              }}
            >
              Vice<span style={{ color: "#ff2e88" }}>Verse</span> hit a snag
            </p>
            <p style={{ color: "#9b97ad", lineHeight: 1.5, margin: "0 0 16px" }}>
              Something went wrong while loading the hub. Your posts and
              progress are saved — reloading usually fixes this.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: "#ff2e88",
                color: "#fff",
                fontWeight: 700,
                border: "none",
                borderRadius: 10,
                padding: "12px 22px",
                minHeight: 44,
                cursor: "pointer",
                fontSize: 15,
              }}
            >
              Reload ViceSunshine
            </button>
            {detail ? (
              <details style={{ marginTop: 20, textAlign: "left" }}>
                <summary
                  style={{
                    color: "#9b97ad",
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "center",
                  }}
                >
                  What happened (already recorded for the team)
                </summary>
                <pre
                  style={{
                    marginTop: 10,
                    maxHeight: 180,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontSize: 11,
                    lineHeight: 1.45,
                    color: "#c9c5d6",
                    background: "#14141f",
                    border: "1px solid #26263a",
                    borderRadius: 8,
                    padding: 10,
                  }}
                >
                  {detail}
                </pre>
              </details>
            ) : null}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) {
  // Never fail silently to a blank page: say what happened, in plain sight.
  document.body.innerHTML =
    '<div style="min-height:100dvh;background:#0b0b14;color:#f4f1ea;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center"><p>ViceSunshine could not start on this device. Please close and reopen it.</p></div>';
} else {
  // If you edit this file: keep `<QueryClientProvider client={spaceQueryClient}>`
  // wrapping the app (every space shares the SDK's QueryClient), and keep
  // BOTH the `hatch-space-root` class AND the `data-hatch-space-root`
  // attribute on the outer div. The SDK styles select on
  // `.hatch-space-root[data-hatch-space-root]` to apply mobile safe-area
  // insets (notches, gesture bars, etc.), correct viewport sizing, and
  // hosting header/chrome offsets — dropping either breaks layout silently.
  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={spaceQueryClient}>
        <RootErrorBoundary>
          <div className="hatch-space-root" data-hatch-space-root>
            <App />
          </div>
        </RootErrorBoundary>
      </QueryClientProvider>
    </StrictMode>,
  );
}
