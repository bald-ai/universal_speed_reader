import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
  title?: string;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const message = error instanceof Error ? error.message : "Something went wrong";
    return {
      hasError: true,
      message,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("AppErrorBoundary caught render error", error, info);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100 px-4">
        <div className="max-w-md rounded-xl border border-red-500/40 bg-red-950/35 px-4 py-3 text-sm">
          <p className="font-semibold text-red-100 mb-1">
            {this.props.title ?? "Something went wrong"}
          </p>
          <p className="text-red-200/80">{this.state.message}</p>
        </div>
      </main>
    );
  }
}
