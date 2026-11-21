import { spaceQueryClient } from "@hatch/space-sdk/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

// Last-resort fallback: if anything throws during render, show a readable
// message with a way back instead of a blank dark screen.
class RootErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            minHeight: "100vh",
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
    '<div style="min-height:100vh;background:#0b0b14;color:#f4f1ea;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center"><p>ViceSunshine could not start on this device. Please close and reopen it.</p></div>';
} else {
  // If you edit this file: keep `<QueryClientProvider client={spaceQueryClient}>`
  // wrapping the app (every space shares the SDK's QueryClient), and keep
  // BOTH the `hatch-space-root` class AND the `data-hatch-space-root`
  // attribute on the outer div. The SDK styles select on
  // `.hatch-space-root[data-hatch-space-root]` to apply mobile safe-area
  // insets (notches, gesture bars, etc.), correct viewport sizing, and the
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
