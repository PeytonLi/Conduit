import { Composio } from "@composio/core";

export interface ComposioGmailClient {
  connectedAccounts: {
    link(
      userId: string,
      authConfigId: string,
      options: { callbackUrl: string },
    ): Promise<{ id: string; redirectUrl: string }>;
    list(args: {
      userIds: string[];
      toolkitSlugs: string[];
      limit?: number;
    }): Promise<{
      items: {
        id: string;
        status: string;
        toolkit: { slug: string };
        authConfig: { id: string };
        data?: Record<string, unknown>;
      }[];
    }>;
    delete(id: string): Promise<unknown>;
  };
  tools: {
    execute(
      slug: string,
      body: {
        userId: string;
        connectedAccountId: string;
        arguments: Record<string, unknown>;
      },
    ): Promise<unknown>;
  };
}

export function createComposioClient(apiKey: string): ComposioGmailClient {
  return new Composio({ apiKey, logLevel: "error" }) as unknown as ComposioGmailClient;
}
