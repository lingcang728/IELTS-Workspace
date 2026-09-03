import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary 捕获异常：", error, errorInfo);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="boot-screen">
          <div className="error-panel">
            <h1>{this.props.fallbackTitle ?? "界面渲染异常"}</h1>
            <p>
              当前视图加载时遇到非预期错误，所有本地作答数据均已安全保留。您可以尝试重试或刷新应用。
            </p>
            <small>{this.state.error?.message ?? "未知错误"}</small>
            <div>
              <button type="button" onClick={this.handleReset}>
                重新尝试
              </button>
              <button type="button" onClick={() => window.location.reload()} style={{ marginLeft: "10px" }}>
                刷新应用
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
