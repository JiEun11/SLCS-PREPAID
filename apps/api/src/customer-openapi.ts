import { z } from "zod";
import {
  customerIdSchema,
  customerSchema,
  renameSchema,
  reversalInputSchema,
  bulkDeleteSchema,
  deleteAllSchema,
  keySchema,
  registrationResponseSchema,
  registrationSchema,
  movementResponseSchema,
  movementSchema,
  summarySchema,
  transactionSchema,
} from "./customers.js";

function json(schema: z.ZodType) {
  return { "application/json": { schema: z.toJSONSchema(schema) } };
}

const security = [{ bearerAuth: [] }];
const errors = {
  "400": { description: "잘못된 입력" },
  "401": { description: "인증 실패" },
  "403": { description: "관리자 권한 없음" },
  "500": { description: "서버 오류" },
  "503": { description: "인증 또는 고객 서비스 사용 불가" },
};

const customerId = {
  name: "customerId",
  in: "path",
  required: true,
  schema: z.toJSONSchema(customerIdSchema),
};
const requestKey = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: z.toJSONSchema(keySchema),
};
const page = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, maximum: 999_999_999, default: 0 },
  },
];

function movement(summary: string) {
  return {
    post: {
      summary,
      security,
      parameters: [customerId, requestKey],
      requestBody: { required: true, content: json(movementSchema) },
      responses: {
        ...errors,
        "201": {
          description: "거래 성공 또는 기존 성공 응답 재현",
          content: json(movementResponseSchema),
        },
        "404": { description: "활성 고객을 찾을 수 없음" },
        "409": {
          description: "잔액 부족, 잔액 한도 초과 또는 다른 요청에 사용된 키",
        },
        "413": { description: "본문 크기 초과" },
        "415": { description: "지원하지 않는 본문 인코딩" },
      },
    },
  };
}

const deleted = z.object({ deletedCount: z.number().int().nonnegative() });
function deleteResponses() {
  return {
    ...errors,
    "200": { description: "소프트 삭제 건수", content: json(deleted) },
  };
}

export const customerPaths = {
  "/api/customers/bulk-delete": {
    post: {
      summary: "선택 고객 삭제",
      security,
      requestBody: { required: true, content: json(bulkDeleteSchema) },
      responses: deleteResponses(),
    },
  },
  "/api/customers/delete-all": {
    post: {
      summary: "전체 고객 삭제",
      security,
      requestBody: { required: true, content: json(deleteAllSchema) },
      responses: {
        ...deleteResponses(),
        "403": { description: "관리자 권한 또는 비밀번호 재인증 실패" },
        "409": { description: "확인한 고객 수와 현재 고객 수가 다름" },
      },
    },
  },
  "/api/customers/{customerId}/transactions/{transactionId}/reversal": {
    post: {
      summary: "원거래 취소",
      security,
      parameters: [
        customerId,
        { ...customerId, name: "transactionId" },
        requestKey,
      ],
      requestBody: { required: true, content: json(reversalInputSchema) },
      responses: {
        ...errors,
        "201": {
          description: "취소 또는 기존 성공 응답 재현",
          content: json(movementResponseSchema),
        },
        "404": { description: "활성 고객 또는 원거래를 찾을 수 없음" },
        "409": {
          description: "취소 불가, 잔액 부족·초과 또는 다른 요청에 사용된 키",
        },
      },
    },
  },
  "/api/customers": {
    post: {
      summary: "고객 등록 및 최초 충전",
      description:
        "관리자별로 키를 구분합니다. 같은 키와 같은 입력을 재전송하면 최초 201 응답을 반환합니다. 실패로 롤백된 키는 재시도할 수 있습니다.",
      security,
      parameters: [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: z.toJSONSchema(keySchema),
        },
      ],
      requestBody: { required: true, content: json(registrationSchema) },
      responses: {
        ...errors,
        "201": {
          description: "고객 및 최초 충전 생성",
          content: json(registrationResponseSchema),
        },
        "409": { description: "이미 다른 요청에 사용된 키" },
        "413": { description: "본문 크기 초과" },
        "415": { description: "지원하지 않는 본문 인코딩" },
      },
    },
    get: {
      summary: "활성 고객 목록 및 이름·휴대폰 뒷자리 검색",
      security,
      parameters: [
        { name: "q", in: "query", schema: { type: "string", maxLength: 120 } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "offset",
          in: "query",
          schema: {
            type: "integer",
            minimum: 0,
            maximum: 999_999_999,
            default: 0,
          },
        },
      ],
      responses: {
        ...errors,
        "200": {
          description: "활성 고객 목록",
          content: json(
            z.object({
              customers: z.array(
                customerSchema.extend({
                  recentTransaction: transactionSchema.nullable(),
                }),
              ),
            }),
          ),
        },
      },
    },
  },
  "/api/customers/summary": {
    get: {
      summary: "전체 장부 요약",
      description:
        "활성 고객의 잔액 및 수와 취소되지 않은 전체 차감 거래 합계를 십진 문자열로 반환합니다.",
      security,
      responses: {
        ...errors,
        "200": { description: "전체 장부 요약", content: json(summarySchema) },
      },
    },
  },
  "/api/customers/{customerId}/credits": movement("추가 충전"),
  "/api/customers/{customerId}/debits": movement("사용 금액 차감"),
  "/api/customers/{customerId}/transactions": {
    get: {
      summary: "고객 거래 내역",
      security,
      parameters: [customerId, ...page],
      responses: {
        ...errors,
        "200": {
          description: "최신 순 거래 내역",
          content: json(z.object({ transactions: z.array(transactionSchema) })),
        },
        "404": { description: "고객을 찾을 수 없음" },
      },
    },
  },
  "/api/customers/{customerId}": {
    patch: {
      summary: "고객 이름 변경",
      security,
      parameters: [customerId],
      requestBody: { required: true, content: json(renameSchema) },
      responses: {
        ...errors,
        "200": { description: "변경한 고객", content: json(customerSchema) },
        "404": { description: "활성 고객을 찾을 수 없음" },
      },
    },
    delete: {
      summary: "고객 한 명 삭제",
      security,
      parameters: [customerId],
      responses: deleteResponses(),
    },
    get: {
      summary: "활성 고객 상세",
      security,
      parameters: [
        {
          name: "customerId",
          in: "path",
          required: true,
          schema: z.toJSONSchema(customerIdSchema),
        },
      ],
      responses: {
        ...errors,
        "200": { description: "고객 상세", content: json(customerSchema) },
        "404": { description: "활성 고객을 찾을 수 없음" },
      },
    },
  },
};
