import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@multiwa/database", () => ({
  prisma: {
    profile: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
  },
}));

import { prisma } from "@multiwa/database";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Reflector } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConversationsController } from "./conversations.controller";
import { ConversationsService } from "./conversations.service";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import {
  MessageContextQueryDto,
  SearchMessagesQueryDto,
} from "./dto/message-history-query.dto";
import {
  ConversationDetailQueryDto,
  ConversationDetailQueryPipe,
  conversationDetailLimit,
} from "./dto/conversation-detail-query.dto";
import { TenantGuard } from "../../common/tenant/tenant.guard";
import { TENANT_CHECKS } from "../../common/tenant/require-tenant.decorator";
import { JwtOrApiKeyGuard } from "../auth/guards/jwt-auth.guard";

const mutationRoutes = [
  {
    handler: "markAsRead",
    method: "PUT",
    suffix: "/read",
    response: { success: true },
  },
  {
    handler: "archive",
    method: "PUT",
    suffix: "/archive",
    response: { success: true },
  },
  {
    handler: "unarchive",
    method: "PUT",
    suffix: "/unarchive",
    response: { success: true },
  },
  {
    handler: "toggleMute",
    method: "PUT",
    suffix: "/mute",
    response: { success: true, isMuted: true },
  },
  {
    handler: "togglePin",
    method: "PUT",
    suffix: "/pin",
    response: { success: true, isPinned: true },
  },
  {
    handler: "clearMessages",
    method: "DELETE",
    suffix: "/messages",
    response: { success: true },
  },
  {
    handler: "delete",
    method: "DELETE",
    suffix: "",
    response: { success: true },
  },
] as const;

describe("ConversationsController message history authorization", () => {
  const service = { searchMessages: vi.fn(), getMessageContext: vi.fn() };
  const request = { user: { organizationId: "org-1" } };

  it("allows search when the authenticated principal can access the profile", async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue({
      id: "profile-1",
    } as any);
    service.searchMessages.mockResolvedValue({ messages: [] });
    const controller = new ConversationsController(service as any);

    await controller.searchMessages("conv-1", request, {
      profileId: "profile-1",
      q: "invoice",
      limit: 25,
    });

    expect(service.searchMessages).toHaveBeenCalledWith("conv-1", "profile-1", {
      query: "invoice",
      limit: 25,
      cursor: undefined,
    });
  });

  it("rejects context access to a profile outside the authenticated organization", async () => {
    vi.mocked(prisma.profile.findFirst).mockResolvedValue(null);
    const controller = new ConversationsController(service as any);

    await expect(
      controller.getMessageContext("conv-1", "msg-1", request, {
        profileId: "profile-elsewhere",
        before: 10,
        after: 10,
      }),
    ).rejects.toThrow("Profile not found");
    expect(service.getMessageContext).not.toHaveBeenCalled();
  });

  it("rejects out-of-bounds search and context query values", async () => {
    const search = plainToInstance(SearchMessagesQueryDto, {
      profileId: "profile-1",
      q: "",
      limit: 101,
    });
    const context = plainToInstance(MessageContextQueryDto, {
      profileId: "profile-1",
      before: -1,
      after: 51,
    });

    expect((await validate(search)).map((error) => error.property)).toEqual(
      expect.arrayContaining(["q", "limit"]),
    );
    expect((await validate(context)).map((error) => error.property)).toEqual(
      expect.arrayContaining(["before", "after"]),
    );
  });

  it.each(mutationRoutes)(
    "declares conversation ownership for $handler",
    ({ handler }) => {
      expect(
        Reflect.getMetadata(
          TENANT_CHECKS,
          ConversationsController.prototype[handler],
        ),
      ).toEqual([{ resource: "conversation", from: "param", key: "id" }]);
    },
  );

  it("declares conversation ownership for detail", () => {
    expect(
      Reflect.getMetadata(
        TENANT_CHECKS,
        ConversationsController.prototype.findOne,
      ),
    ).toEqual([{ resource: "conversation", from: "param", key: "id" }]);
  });

  it.each([
    [undefined, 50],
    ["1", 1],
    ["100", 100],
  ])("normalizes detail message limit %s", (value, expected) => {
    const query = new ConversationDetailQueryPipe().transform(
      value === undefined ? {} : { messageLimit: value },
    );
    expect(conversationDetailLimit(query)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "0",
    "-1",
    "1.5",
    "word",
    "Infinity",
    "101",
    "0x10",
    "1e2",
  ])("rejects noncanonical detail message limit %s", (value) => {
    expect(() =>
      new ConversationDetailQueryPipe().transform({ messageLimit: value }),
    ).toThrow("messageLimit must be a decimal integer from 1 through 100.");
  });

  it("rejects repeated detail message limits", () => {
    expect(() =>
      new ConversationDetailQueryPipe().transform({
        messageLimit: ["1", "2"],
      }),
    ).toThrow("messageLimit must be a decimal integer from 1 through 100.");
  });
});

describe("ConversationsController routed mutation authorization", () => {
  let app: NestFastifyApplication;
  const routedService = {
    ...Object.fromEntries(
      mutationRoutes.map(({ handler }) => [handler, vi.fn()]),
    ),
    findOne: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ConversationsController],
      providers: [{ provide: ConversationsService, useValue: routedService }],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue({
        canActivate(context: any) {
          context.switchToHttp().getRequest().user = {
            organizationId: "org-a",
          };
          return true;
        },
      })
      .overrideGuard(TenantGuard)
      .useValue(new TenantGuard(new Reflector()))
      .compile();

    // Vitest does not emit constructor type metadata, so wire the service mock
    // before Nest registers the controller routes.
    (module.get(ConversationsController) as any).service = routedService;
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(prisma.conversation.findFirst).mockReset();
    Object.values(routedService).forEach((mock) => mock.mockReset());
  });

  it.each(mutationRoutes)(
    "does not invoke $handler when routed ownership fails",
    async ({ handler, method, suffix }) => {
      vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce(null);

      const response = await app.inject({
        method,
        url: `/api/v1/conversations/conversation-b${suffix}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        statusCode: 404,
        message: "Resource not found.",
      });
      expect(routedService[handler]).not.toHaveBeenCalled();
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: {
          id: "conversation-b",
          profile: { workspace: { organizationId: "org-a" } },
        },
        select: { id: true },
      });
    },
  );

  it.each(mutationRoutes)(
    "invokes $handler after routed ownership succeeds",
    async ({ handler, method, suffix, response: expectedResponse }) => {
      vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({
        id: "conversation-a",
      } as any);
      routedService[handler].mockResolvedValueOnce(expectedResponse);

      const response = await app.inject({
        method,
        url: `/api/v1/conversations/conversation-a${suffix}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(expectedResponse);
      expect(routedService[handler]).toHaveBeenCalledOnce();
      expect(routedService[handler]).toHaveBeenCalledWith("conversation-a");
    },
  );

  it("does not invoke detail service when routed ownership fails", async () => {
    vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce(null);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/conversations/conversation-b?messageLimit=invalid",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      statusCode: 404,
      message: "Resource not found.",
    });
    expect(routedService.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ["", 50],
    ["?messageLimit=2", 2],
  ])(
    "invokes detail service with normalized limit for %s",
    async (query, expectedLimit) => {
      vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({
        id: "conversation-a",
      } as any);
      routedService.findOne.mockResolvedValueOnce({ id: "conversation-a" });

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/conversation-a${query}`,
      });

      expect(response.statusCode).toBe(200);
      expect(routedService.findOne).toHaveBeenCalledOnce();
      expect(routedService.findOne).toHaveBeenCalledWith(
        "conversation-a",
        expectedLimit,
      );
    },
  );

  it.each([
    "",
    "%20",
    "0",
    "-1",
    "1.5",
    "word",
    "Infinity",
    "101",
    "0x10",
    "1e2",
    "1&messageLimit=2",
  ])(
    "rejects routed detail limit %s before service execution",
    async (value) => {
      vi.mocked(prisma.conversation.findFirst).mockResolvedValueOnce({
        id: "conversation-a",
      } as any);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/conversations/conversation-a?messageLimit=${value}`,
      });

      expect(response.statusCode).toBe(400);
      expect(routedService.findOne).not.toHaveBeenCalled();
    },
  );
});
