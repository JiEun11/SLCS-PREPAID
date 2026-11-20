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
      const session = await api<{
        access_token: string;
        refresh_token: string;
      }>("", "/admin/pin", {
        body: { pin: String(data.get("pin")) },
      });
      const { error } = await auth.setSession(session);
      if (error)
        setNotice("로그인 세션을 시작하지 못했습니다. 다시 시도해 주세요.");
    } catch (error) {
      setNotice(messageFor(error));
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
          관리자 PIN (숫자 6자리)
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            autoComplete="off"
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
            PIN 다시 입력
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
