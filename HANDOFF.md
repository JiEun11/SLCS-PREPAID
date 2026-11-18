# SLCS PREPAID 인수인계

원본 저장소는 JiEun11/SLCS-PREPAID입니다. 이 ZIP은 현재 클라우드 작업 공간의 Phase 1 소스와 잠금 파일을 담고 있습니다.

- Phase 1 완료. React/Vite/Tailwind/shadcn/ui 설정, Express API, pnpm 워크스페이스, TypeScript/ESLint/Prettier, 개발용 Swagger를 구성했습니다.
- pnpm frozen install, typecheck, lint, test(4개), build, format:check 통과. Vite 프록시를 통한 health와 Swagger 응답 확인.
- 다음 작업은 Phase 2. Drizzle/PostgreSQL 스키마·마이그레이션, Supabase Auth 및 admins 확인, 401/403 검증입니다.
- 원 단위 정수, 고객 행 잠금, 잔액과 거래의 원자적 변경, Idempotency-Key, 취소 거래와 중복 취소 제약, 소프트 삭제, 서울 시간 표시가 주요 원칙입니다.
- Swagger UI와 OpenAPI 명세는 개발 환경에서만 활성화합니다.
- 원래 요구사항에 따라 Phase별 결과를 보고하고 설계 변경은 먼저 승인받습니다. 환경 게시 및 배포는 매번 사용자 사전 승인이 필요합니다.
- 먼저 새 채팅에서 기존 파일을 확인하세요. 파일이 없다면 ZIP을 사용하세요. Phase 1을 다시 생성하거나 기존 파일을 덮어쓰지 마세요.
