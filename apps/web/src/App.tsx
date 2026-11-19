import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import { Route, Routes } from "react-router";
import { api, auth, ApiError, messageFor } from "./api";
import { Brand } from "./Brand";
import { Counter } from "./Counter";

function Login({ loading }: { loading: boolean }) {
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth || pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setNotice("");
    try {
      const { error } = await auth.signInWithPassword({
        email: String(data.get("email")).trim(),
        password: String(data.get("password")),
      });
      if (error) {
        setNotice(
          error.status === 400 || error.status === 401
            ? "이메일과 비밀번호를 확인해 주세요."
            : "로그인 서비스에 연결할 수 없습니다. 다시 시도해 주세요.",
        );
      }
    } catch {
      setNotice("로그인 서비스에 연결할 수 없습니다. 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-form" onSubmit={signIn}>
        <Brand />
        <h1>관리자 로그인</h1>
        <p className="secondary">스몰랩커피스탠드 선결제 장부</p>
        <label>
          이메일
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          비밀번호
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        {(notice || !auth) && (
          <p className="error" role="alert">
            {notice || "로그인 설정을 확인해 주세요."}
          </p>
        )}
        <button
          className="button primary w-full"
          disabled={!auth || pending || loading}
        >
          {pending || loading ? "확인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}

function Workspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(Boolean(auth));
  const admin = useQuery({
    queryKey: ["admin", session?.user.id],
    gcTime: 0,
    enabled: Boolean(session),
    retry: false,
    queryFn: ({ signal }) =>
      api(session!.access_token, "/admin/me", { signal }),
  });
  useEffect(() => {
    if (!auth) return;
    const {
      data: { subscription },
    } = auth.onAuthStateChange((_event, value) => {
      setSession(value);
      setStarting(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  if (session && admin.isSuccess) {
    return (
      <Counter
        token={session.access_token}
        actorId={session.user.id}
        onSignOut={() => auth?.signOut({ scope: "local" })}
      />
    );
  }
  if (session && admin.error) {
    const denied =
      admin.error instanceof ApiError &&
      [401, 403].includes(admin.error.status);
    return (
      <main className="login-page">
        <section className="login-form">
          <Brand />
          <h1>관리자 확인</h1>
          <p role="alert" className="error">
            {messageFor(admin.error)}
          </p>
          {!denied && (
            <button
              className="button primary"
              onClick={() => void admin.refetch()}
            >
              다시 확인
            </button>
          )}
          <button
            className="button button-outline"
            onClick={() => void auth?.signOut({ scope: "local" })}
          >
            다른 계정으로 로그인
          </button>
        </section>
      </main>
    );
  }
  return <Login loading={starting || Boolean(session)} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      <Route
        path="*"
        element={<main className="p-6">페이지를 찾을 수 없습니다.</main>}
      />
    </Routes>
  );
}
