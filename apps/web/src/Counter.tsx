import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Brand } from "./Brand";
import {
  api,
  ApiError,
  messageFor,
  type Customer,
  type Summary,
  type Transaction,
} from "./api";

const won = new Intl.NumberFormat("ko-KR");
const date = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fullDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const labels = { credit: "충전", debit: "사용", reversal: "취소" };
const pageSize = 20;

function money(amount: number | string) {
  return (
    won.format(typeof amount === "string" ? BigInt(amount) : amount) + "원"
  );
}

function signed(amount: number) {
  return (amount > 0 ? "+" : "−") + money(Math.abs(amount));
}

type Action =
  | { kind: "register" }
  | { kind: "credit" | "debit"; customer: Customer }
  | { kind: "reversal"; customer: Customer; entry: Transaction };
type Result = {
  customer: Pick<Customer, "name" | "balance">;
  transaction: Transaction;
};

function Dialog({
  title,
  children,
  onClose,
  side = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  side?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const viewport = window.visualViewport;
    const fit = () => {
      if (viewport) {
        dialog.style.setProperty("--viewport-top", viewport.offsetTop + "px");
        dialog.style.setProperty("--available-height", viewport.height + "px");
        dialog.style.setProperty(
          "--keyboard-gap",
          Math.max(
            0,
            window.innerHeight - viewport.height - viewport.offsetTop,
          ) + "px",
        );
      }
    };
    fit();
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    return () => {
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
      dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"sheet " + (side ? "history-sheet" : "")}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="sheet-header">
        <h2 id="dialog-title">{title}</h2>
        <button
          className="button close"
          type="button"
          aria-label="닫기"
          onClick={onClose}
          disabled={busy}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

function AmountDialog({
  action,
  token,
  actorId,
  onClose,
  onSuccess,
}: {
  action: Action;
  token: string;
  actorId: string;
  onClose: () => void;
  onSuccess: (result: Result) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [entered, setEntered] = useState("");
  const active = useRef(false);
  const register = action.kind === "register";
  const title = register
    ? "신규 고객 등록"
    : action.kind === "credit"
      ? "잔액 충전"
      : action.kind === "reversal"
        ? "거래 취소"
        : "사용 금액 차감";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const form = new FormData(event.currentTarget);
    const amount = Number(entered);
    const name = String(form.get("name") ?? "").trim();
    if (
      (action.kind !== "reversal" &&
        (!/^[0-9]+$/.test(entered) || amount < 1 || amount > 2_147_483_647)) ||
      (register && !name)
    ) {
      setError(
        register
          ? "이름과 원 단위 금액을 확인해 주세요."
          : "1원 이상의 원 단위 금액을 입력해 주세요.",
      );
      return;
    }
    const path = register
      ? "/customers"
      : "/customers/" +
        action.customer.id +
        (action.kind === "credit"
          ? "/credits"
          : action.kind === "reversal"
            ? "/transactions/" + action.entry.id + "/reversal"
            : "/debits");
    const body = register
      ? { name, initialAmount: amount }
      : action.kind === "reversal"
        ? {}
        : { amount };
    const signature = JSON.stringify([actorId, path, body]);
    const storageKey = "slcs:pending:" + signature;
    let key: string;
    try {
      key =
        sessionStorage.getItem(storageKey) ??
        Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      sessionStorage.setItem(storageKey, key);
    } catch {
      setError(
        "안전한 재시도를 위해 브라우저의 사이트 저장 공간을 허용해 주세요.",
      );
      return;
    }
    active.current = true;
    setPending(true);
    setError("");
    const request = new AbortController();
    const timer = window.setTimeout(() => request.abort(), 20_000);
    try {
      const result = await api<Result>(token, path, {
        body,
        key,
        signal: request.signal,
      });
      sessionStorage.removeItem(storageKey);
      onSuccess(result);
    } catch (error) {
      const ambiguous = !(error instanceof ApiError) || error.status >= 500;
      if (
        !uncertain &&
        error instanceof ApiError &&
        (error.status === 400 ||
          error.status === 404 ||
          error.code === "insufficient_balance" ||
          error.code === "balance_limit")
      ) {
        sessionStorage.removeItem(storageKey);
      }
      setUncertain(uncertain || ambiguous);
      setError(
        messageFor(error) +
          (uncertain || ambiguous
            ? " 처리 결과가 확인되지 않았습니다. 같은 입력으로 재시도해 주세요."
            : ""),
      );
    } finally {
      window.clearTimeout(timer);
      active.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog title={title} onClose={onClose} busy={pending}>
      <form className="sheet-body grid gap-4" onSubmit={submit}>
        {register ? (
          <label>
            고객 이름
            <input
              name="name"
              autoComplete="off"
              maxLength={120}
              placeholder="고객 이름 입력"
              required
              readOnly={pending || uncertain}
            />
          </label>
        ) : (
          <div className="balance-preview">
            <span>{action.customer.name}</span>
            <strong>{money(action.customer.balance)}</strong>
          </div>
        )}
        {action.kind === "reversal" ? (
          <p>
            이 거래를 취소하면 잔액에 {signed(-action.entry.amount)}이
            반영됩니다.
          </p>
        ) : (
          <label>
            {register
              ? "최초 충전 금액"
              : action.kind === "credit"
                ? "충전 금액"
                : "사용 금액"}
            <span className="amount-field">
              <input
                name="amount"
                value={entered}
                onChange={(event) => setEntered(event.target.value)}
                type="text"
                inputMode="numeric"
                pattern="[0-9]+"
                maxLength={10}
                placeholder="0"
                required
                readOnly={pending || uncertain}
              />
              <span>원</span>
            </span>
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary w-full" disabled={pending}>
          {pending
            ? "처리 중…"
            : uncertain
              ? "같은 요청 다시 확인"
              : register
                ? "등록 및 최초 충전"
                : action.kind === "credit"
                  ? "충전하기"
                  : action.kind === "reversal"
                    ? "거래 취소 확정"
                    : "차감하기"}
        </button>
      </form>
    </Dialog>
  );
}

function History({
  token,
  actorId,
  customer,
  onClose,
  onReverse,
  onManage,
}: {
  token: string;
  actorId: string;
  customer: Customer;
  onClose: () => void;
  onReverse: (entry: Transaction) => void;
  onManage: (kind: "rename" | "single") => void;
}) {
  const history = useInfiniteQuery({
    queryKey: ["ledger", actorId, customer.id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      api<{ transactions: Transaction[] }>(
        token,
        "/customers/" +
          customer.id +
          "/transactions?limit=" +
          pageSize +
          "&offset=" +
          pageParam,
        { signal },
      ),
    getNextPageParam: (last, pages) =>
      last.transactions.length === pageSize
        ? pages.length * pageSize
        : undefined,
  });
  const entries =
    history.data?.pages.flatMap((page) => page.transactions) ?? [];

  return (
    <Dialog title="거래 내역" onClose={onClose} side>
      <div className="sheet-body">
        <div className="balance-preview">
          <span>{customer.name}</span>
          <strong>{money(customer.balance)}</strong>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="button button-outline"
            onClick={() => onManage("rename")}
          >
            이름 수정
          </button>
          <button
            className="button button-outline"
            onClick={() => onManage("single")}
          >
            고객 삭제
          </button>
        </div>
        {history.isPending && (
          <p role="status" className="state">
            거래 내역을 불러오는 중…
          </p>
        )}
        {history.error && (
          <Problem error={history.error} retry={() => void history.refetch()} />
        )}
        {history.isSuccess && entries.length === 0 && (
          <p className="state">아직 거래 내역이 없습니다.</p>
        )}
        <ol className="history-list">
          {entries.map((entry) => (
            <li key={entry.id} id={"transaction-" + entry.id}>
              <div>
                <strong>
                  {labels[entry.kind]}
                  {entry.reversedById ? " · 취소됨" : ""}
                </strong>
                <time dateTime={entry.createdAt}>
                  {fullDate.format(new Date(entry.createdAt))}
                </time>
                {entry.reversesId && (
                  <small>원거래 {entry.reversesId.slice(0, 8)}</small>
                )}
                {entry.reversedById && (
                  <small>취소 거래 {entry.reversedById.slice(0, 8)}</small>
                )}
                <small>거래 번호 {entry.id.slice(0, 8)}</small>
              </div>
              <div>
                <strong className={entry.amount > 0 ? "text-primary" : ""}>
                  {signed(entry.amount)}
                </strong>
                <small>
                  {entry.balanceAfter === null
                    ? "거래 후 잔액 기록 없음"
                    : "거래 후 " + money(entry.balanceAfter)}
                </small>
                {entry.kind !== "reversal" && !entry.reversedById && (
                  <button
                    className="button button-outline"
                    onClick={() => onReverse(entry)}
                  >
                    거래 취소
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
        {history.hasNextPage && (
          <button
            className="button button-outline w-full"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            이전 거래 더 보기
          </button>
        )}
      </div>
    </Dialog>
  );
}

function Problem({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="problem">
      <p className="error" role="alert">
        {messageFor(error)}
      </p>
      <button className="button button-outline" onClick={retry}>
        다시 시도
      </button>
    </div>
  );
}

type Management =
  | { kind: "rename"; customer: Customer }
  | { kind: "single"; customer: Customer }
  | { kind: "bulk"; ids: string[] }
  | { kind: "all"; count: number };

function ManagementDialog({
  action,
  token,
  onClose,
  onSuccess,
}: {
  action: Management;
  token: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const title = {
    rename: "고객 이름 수정",
    single: "고객 삭제",
    bulk: "선택 고객 삭제",
    all: "전체 고객 삭제",
  }[action.kind];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const form = new FormData(event.currentTarget);
    active.current = true;
    setPending(true);
    setError("");
    try {
      if (action.kind === "rename") {
        await api(token, "/customers/" + action.customer.id, {
          method: "PATCH",
          body: { name: String(form.get("name")) },
        });
        onSuccess("고객 이름을 수정했습니다.");
        return;
      }
      let result: { deletedCount: number };
      switch (action.kind) {
        case "single":
          result = await api(token, "/customers/" + action.customer.id, {
            method: "DELETE",
          });
          break;
        case "bulk":
          result = await api(token, "/customers/bulk-delete", {
            body: { customerIds: action.ids },
          });
          break;
        case "all":
          result = await api(token, "/customers/delete-all", {
            body: {
              expectedCount: action.count,
              confirmation: String(form.get("confirmation")),
              pin: String(form.get("pin")),
            },
          });
          break;
      }
      onSuccess(result.deletedCount + "명의 고객을 삭제했습니다.");
    } catch (error) {
      setError(messageFor(error));
    } finally {
      active.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog title={title} onClose={onClose} busy={pending}>
      <form className="sheet-body grid gap-4" onSubmit={submit}>
        {action.kind === "rename" ? (
          <label>
            고객 이름
            <input
              name="name"
              defaultValue={action.customer.name}
              maxLength={120}
              required
            />
          </label>
        ) : (
          <>
            <p>
              {action.kind === "single"
                ? action.customer.name
                : (action.kind === "all" ? action.count : action.ids.length) +
                  "명"}
              을 활성 목록에서 삭제합니다. 잔액과 거래 내역은 보존됩니다.
            </p>
            {action.kind === "all" && (
              <>
                <label>
                  확인 문구 “전체 삭제”
                  <input name="confirmation" autoComplete="off" required />
                </label>
                <label>
                  관리자 PIN (숫자 6자리)
                  <input
                    type="password"
                    name="pin"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    autoComplete="off"
                    required
                  />
                </label>
              </>
            )}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" disabled={pending}>
          {pending
            ? "처리 중…"
            : action.kind === "rename"
              ? "저장"
              : "삭제 확정"}
        </button>
      </form>
    </Dialog>
  );
}

export function Counter({
  token,
  actorId,
  onSignOut,
}: {
  token: string;
  actorId: string;
  onSignOut: () => Promise<unknown> | undefined;
}) {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [history, setHistory] = useState<Customer | null>(null);
  const [management, setManagement] = useState<Management | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [signOutError, setSignOutError] = useState("");
  const cache = useQueryClient();
  const q = search.trim();
  const summary = useQuery({
    queryKey: ["summary", actorId],
    queryFn: ({ signal }) =>
      api<Summary>(token, "/customers/summary", { signal }),
    retry: false,
  });
  const list = useInfiniteQuery({
    queryKey: ["customers", actorId, q],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({
        q,
        limit: String(pageSize),
        offset: String(pageParam),
      });
      return api<{ customers: Customer[] }>(token, "/customers?" + params, {
        signal,
      });
    },
    getNextPageParam: (last, pages) =>
      last.customers.length === pageSize ? pages.length * pageSize : undefined,
    retry: false,
  });
  const customers = list.data?.pages.flatMap((page) => page.customers) ?? [];
  const activeCustomers = [
    ...new Map(customers.map((customer) => [customer.id, customer])).values(),
  ];

  function invalidateLedger() {
    void cache.invalidateQueries({ queryKey: ["customers", actorId] });
    void cache.invalidateQueries({ queryKey: ["summary", actorId] });
    void cache.invalidateQueries({ queryKey: ["ledger", actorId] });
  }

  function completed(result: Result) {
    setAction(null);
    setNotice(
      result.customer.name +
        " · " +
        labels[result.transaction.kind] +
        " " +
        money(Math.abs(result.transaction.amount)) +
        " 완료 · 잔액 " +
        money(result.customer.balance),
    );
    if (action?.kind === "register") setSearch(result.customer.name);
    if (action?.kind === "reversal")
      setHistory((open) =>
        open ? { ...open, balance: result.customer.balance } : open,
      );
    invalidateLedger();
  }

  return (
    <div className="counter">
      <header className="topbar">
        <div className="page-width flex items-center justify-between gap-3">
          <Brand />
          <button
            className="button button-outline logout"
            onClick={() => {
              setSignOutError("");
              void onSignOut()
                ?.then((result) => {
                  if (
                    result &&
                    typeof result === "object" &&
                    "error" in result &&
                    result.error
                  )
                    throw result.error;
                  cache.clear();
                })
                .catch(() =>
                  setSignOutError(
                    "로그아웃하지 못했습니다. 다시 시도해 주세요.",
                  ),
                );
            }}
          >
            로그아웃
          </button>
        </div>
      </header>
      <main className="page-width main">
        {signOutError && (
          <p className="error" role="alert">
            {signOutError}
          </p>
        )}
        <section
          className="summary grid grid-cols-1 md:grid-cols-3"
          aria-label="전체 장부 요약"
          aria-busy={summary.isPending}
        >
          <div>
            <span>전체 잔액</span>
            <strong>
              {summary.data ? money(summary.data.totalBalance) : "—"}
            </strong>
          </div>
          <div>
            <span>고객 수</span>
            <strong>
              {summary.data
                ? won.format(BigInt(summary.data.customerCount)) + "명"
                : "—"}
            </strong>
          </div>
          <div>
            <span>누적 사용액</span>
            <strong>
              {summary.data ? money(summary.data.totalUsed) : "—"}
            </strong>
          </div>
        </section>
        {summary.error && (
          <Problem error={summary.error} retry={() => void summary.refetch()} />
        )}
        <section aria-labelledby="customers-title">
          <div className="section-heading">
            <h1 id="customers-title">고객 장부</h1>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="button button-outline"
                onClick={() => {
                  setSelecting(!selecting);
                  setSelected([]);
                }}
              >
                {selecting ? "선택 종료" : "고객 선택"}
              </button>
              {selecting && (
                <button
                  className="button button-outline"
                  disabled={!selected.length}
                  onClick={() => setManagement({ kind: "bulk", ids: selected })}
                >
                  선택 삭제 ({selected.length}/100)
                </button>
              )}
              {selecting && summary.data && (
                <button
                  className="button button-outline"
                  disabled={summary.data.customerCount === "0"}
                  onClick={() =>
                    setManagement({
                      kind: "all",
                      count: Number(summary.data!.customerCount),
                    })
                  }
                >
                  전체 삭제
                </button>
              )}
            </div>
          </div>
          <div className="toolbar flex flex-wrap gap-2">
            <label className="search">
              <span className="search-icon" aria-hidden="true" />
              <span className="sr-only">고객 이름 검색</span>
              <input
                type="search"
                maxLength={120}
                placeholder="고객 이름 검색"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <button
              className="button primary register"
              onClick={() => {
                setNotice("");
                setAction({ kind: "register" });
              }}
            >
              <span aria-hidden="true">＋</span> 신규 고객 등록
            </button>
          </div>
          <div className={notice ? "notice" : "sr-only"} role="status">
            {notice}
          </div>
          {list.isPending && (
            <p className="state" role="status">
              고객 목록을 불러오는 중…
            </p>
          )}
          {list.error && (
            <Problem error={list.error} retry={() => void list.refetch()} />
          )}
          {list.isSuccess && !activeCustomers.length && (
            <p className="state">
              {q ? "검색 결과가 없습니다." : "등록된 고객이 없습니다."}
            </p>
          )}
          <ul className="cards grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeCustomers.map((customer) => (
              <li key={customer.id} className="card">
                {selecting && (
                  <label className="flex min-h-11 items-center gap-2">
                    <input
                      className="size-5 min-h-0"
                      type="checkbox"
                      checked={selected.includes(customer.id)}
                      disabled={
                        selected.length === 100 &&
                        !selected.includes(customer.id)
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, customer.id]
                            : selected.filter((id) => id !== customer.id),
                        )
                      }
                    />{" "}
                    {customer.name} 선택
                  </label>
                )}
                <div className="card-heading">
                  <h2>{customer.name}</h2>
                  <button
                    className="button history-button"
                    onClick={() => setHistory(customer)}
                    aria-label={customer.name + " 거래 내역"}
                  >
                    거래 내역 <span aria-hidden="true">›</span>
                  </button>
                </div>
                <p className="balance-label">현재 잔액</p>
                <p className="balance">{money(customer.balance)}</p>
                <div className="recent">
                  {customer.recentTransaction ? (
                    <>
                      <span>
                        {labels[customer.recentTransaction.kind]}{" "}
                        {signed(customer.recentTransaction.amount)}
                      </span>
                      <time dateTime={customer.recentTransaction.createdAt}>
                        {date.format(
                          new Date(customer.recentTransaction.createdAt),
                        )}
                      </time>
                    </>
                  ) : (
                    <span>최근 거래 없음</span>
                  )}
                </div>
                <div className="card-actions grid grid-cols-2 gap-2">
                  <button
                    className="button soft"
                    onClick={() => {
                      setNotice("");
                      setAction({ kind: "credit", customer });
                    }}
                    aria-label={customer.name + " 충전"}
                  >
                    ＋ 충전
                  </button>
                  <button
                    className="button button-outline"
                    onClick={() => {
                      setNotice("");
                      setAction({ kind: "debit", customer });
                    }}
                    aria-label={customer.name + " 사용"}
                  >
                    − 사용
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <button
              className="button button-outline more"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              고객 더 보기
            </button>
          )}
        </section>
      </main>
      {management && (
        <ManagementDialog
          action={management}
          token={token}
          onClose={() => setManagement(null)}
          onSuccess={(message) => {
            setManagement(null);
            setHistory(null);
            setSelected([]);
            setSelecting(false);
            setNotice(message);
            invalidateLedger();
          }}
        />
      )}
      {action && (
        <AmountDialog
          action={action}
          token={token}
          actorId={actorId}
          onClose={() => setAction(null)}
          onSuccess={completed}
        />
      )}
      {history && !action && !management && (
        <History
          token={token}
          actorId={actorId}
          customer={history}
          onClose={() => setHistory(null)}
          onReverse={(entry) =>
            setAction({ kind: "reversal", customer: history, entry })
          }
          onManage={(kind) => setManagement({ kind, customer: history })}
        />
      )}
    </div>
  );
}
