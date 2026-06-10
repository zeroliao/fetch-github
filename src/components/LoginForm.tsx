"use client";

import { LogIn } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

export function LoginForm() {
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok) {
        window.location.href = safeRedirectPath(searchParams.get("from"));
        return;
      }

      setMessage(
        body.error === "auth_not_configured"
          ? "认证尚未配置，请先在 .env.local 中设置 ADMIN_PASSWORD_HASH。"
          : "用户名或密码不正确。"
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-panel" onSubmit={submitLogin}>
        <div className="brand login-brand">
          <LogIn size={22} />
          <span>fetchGithub</span>
        </div>
        <div className="panel-title">
          <h1>管理员登录</h1>
          <p>登录后才能管理扫描任务、模型配置、访问令牌和项目推荐。</p>
        </div>
        {message && <div className="notice">{message}</div>}
        <label className="field">
          <span>用户名</span>
          <input
            className="input"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className="button primary" type="submit" disabled={isSubmitting}>
          <LogIn size={16} />
          <span>{isSubmitting ? "登录中" : "登录"}</span>
        </button>
      </form>
    </main>
  );
}

function safeRedirectPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) {
    return "/";
  }

  return value;
}
