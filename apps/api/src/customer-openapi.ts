import { z } from "zod";
import {
  customerIdSchema,
  customerSchema,
  keySchema,
  registrationResponseSchema,
  registrationSchema,
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

export const customerPaths = {
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
      summary: "활성 고객 목록 및 이름 검색",
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
          content: json(z.object({ customers: z.array(customerSchema) })),
        },
      },
    },
  },
  "/api/customers/{customerId}": {
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
