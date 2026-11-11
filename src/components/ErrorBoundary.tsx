import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[bytune] renderer crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen grid place-items-center bg-base text-ink">
          <div className="max-w-md text-center px-6 animate-pop-in">
            <div className="w-16 h-16 rounded-2xl glass grid place-items-center mx-auto mb-5">
              <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path
                  d="M12 8v5M12 16.5v.5"
                  strokeLinecap="round"
                  className="text-amber-400"
                />
                <path
                  d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-amber-400"
                />
              </svg>
            </div>
            <h1 className="font-display text-lg font-bold tracking-tight text-ink-hi mb-2">Something went wrong</h1>
            <p className="text-sm text-ink-dim mb-1.5">
              ByTune hit an unexpected error. Your library is safe — reloading usually fixes it.
            </p>
            <details className="text-left mt-4">
              <summary className="text-xs text-ink-faint cursor-pointer hover:text-ink-dim transition-colors select-none">
                Technical details
              </summary>
              <p className="text-xs text-ink-ghost mt-2 break-words bg-ink-hi/[0.06] rounded-lg p-3 border border-ink-hi/[0.05]">
                {this.state.error.message}
              </p>
            </details>
            <button
              onClick={() => window.location.reload()}
              className="mt-6 px-5 py-2.5 rounded-full bg-primary text-on-primary text-sm font-medium hover:brightness-110 transition-colors"
            >
              Reload ByTune
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
