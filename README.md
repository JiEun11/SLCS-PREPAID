# SLCS PREPAID

스몰랩커피스탠드 선결제 고객 장부입니다. 현재 웹과 API의 개발 기반을 제공합니다.

## 개발 시작

Node.js 버전은 `.node-version`에, pnpm 버전은 `package.json`에 지정되어 있습니다.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

클라우드 샌드박스에서 기본 pnpm 저장소에 쓸 수 없다면 저장소 루트에서 아래 명령으로 설치합니다.

```sh
XDG_DATA_HOME="$PWD/node_modules/.local-share" XDG_CACHE_HOME="$PWD/node_modules/.cache" pnpm install --frozen-lockfile
```

Vite는 기본 포트 5173에서 실행되며 `/api`를 Express 기본 포트 3000으로 프록시합니다. API 포트를 바꾸려면 루트에서 `PORT=3001 pnpm dev`를 실행합니다.

- `GET /api/health`는 API 프로세스의 응답을 확인합니다.
- 개발 서버의 `/api/docs/`와 `/api/openapi.json`에서 API 문서를 확인할 수 있습니다.
- `pnpm --filter @slcs/api start`로 실행하기 전에 `pnpm build`를 실행합니다.
- Swagger는 `NODE_ENV=development`에서 활성화됩니다.

## 확인 명령

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

환경 게시와 스테이징·운영 배포에는 사전 승인이 필요합니다.

## Phase 2 로컬 API 설정

`DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`를 실행 환경에 설정합니다. 로컬 개발에서는 루트의 `.env.example`을 `.env`로 복사해 값을 채운 뒤 `pnpm dev`를 실행하면 API가 해당 파일을 읽습니다. 세 값이 모두 비어 있는 개발 환경에서도 상태 확인과 Swagger를 사용할 수 있습니다. 이때 관리자 API는 인증 정보를 사용할 수 없는 요청에 503을 반환합니다.

로컬 PostgreSQL에 연결한 상태에서 아래 명령으로 마이그레이션을 적용합니다. API가 사용하는 DB 역할에는 RLS가 켜진 `admins`를 읽을 권한이 필요합니다. 초기 관리자는 DB 관리자가 해당 Supabase Auth 사용자의 UUID를 `admins.user_id`에 등록해 지정합니다.

```sh
pnpm --filter @slcs/api exec node --env-file="$PWD/.env" ./node_modules/drizzle-kit/bin.cjs migrate
```

`GET /api/admin/me`에 `Authorization: Bearer <access_token>`을 보내면 Supabase Auth에서 토큰을 확인하고, 인증된 사용자의 UUID로 `admins`를 조회합니다. 유효한 토큰이 없으면 401, 인증된 사용자가 관리자 목록에 없으면 403, 관리자이면 200을 반환합니다. 인증 서버 또는 DB 장애 시에는 503을 반환합니다.

## 카운터 웹

루트의 로컬 환경에서 API용 Supabase 값과 함께 브라우저 로그인용
VITE_SUPABASE_URL 및 VITE_SUPABASE_PUBLISHABLE_KEY를 설정합니다. 두 값은
브라우저에 공개되는 프로젝트 URL과 publishable key입니다. 관리자에게는
Supabase Auth 이메일·비밀번호 계정과 admins 등록이 필요합니다.

    pnpm install --frozen-lockfile
    pnpm dev

브라우저에서 http://localhost:5173을 열고 로그인합니다. 로컬 개발에서는
Vite가 API를 프록시합니다. 배포 환경에서는 웹과 /api가 동일한 HTTPS
출처에서 제공되도록 라우팅하고, 웹 빌드 시 VITE 값을 전달합니다.
Phase 3 API에는 0001_phase3_registration 마이그레이션이 적용된 DB와
신규 테이블에 접근할 수 있는 API 역할이 필요합니다.

카운터 요약의 고객 수와 전체 잔액은 활성 고객 기준입니다. 누적 사용액은
전체 고객의 차감 거래 합계입니다. 거래 시각은 서울 시간으로 표시합니다.
