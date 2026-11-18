import { Route, Routes } from "react-router";

export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <main className="mx-auto max-w-2xl px-6 py-12">
            <h1 className="text-2xl font-semibold text-primary">
              SLCS PREPAID
            </h1>
            <p className="mt-2">스몰랩커피스탠드 선결제 고객 장부</p>
          </main>
        }
      />
      <Route
        path="*"
        element={<main className="p-6">페이지를 찾을 수 없습니다.</main>}
      />
    </Routes>
  );
}
